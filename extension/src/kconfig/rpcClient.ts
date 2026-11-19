import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import * as readline from 'node:readline';
import {
  ApplyResponse,
  BackendLifecycleState,
  ConfigLayer,
  InitResponse,
  KconfigNode,
  LayersPayload,
  SearchItem,
  SolveChange,
  SolveResponse,
  SymbolDetail,
} from '../shared/protocol';

export class RpcTimeoutError extends Error {
  public readonly method: string;
  public readonly timeoutMs: number;

  constructor(method: string, timeoutMs: number) {
    super(`JSON-RPC request '${method}' timed out after ${timeoutMs}ms`);
    this.name = 'RpcTimeoutError';
    this.method = method;
    this.timeoutMs = timeoutMs;
  }
}

export class RpcProcessExitedError extends Error {
  public readonly exitCode: number | null;
  public readonly signal: NodeJS.Signals | null;

  constructor(exitCode: number | null, signal: NodeJS.Signals | null) {
    super(`Kconfig backend daemon exited unexpectedly (code=${exitCode}, signal=${signal})`);
    this.name = 'RpcProcessExitedError';
    this.exitCode = exitCode;
    this.signal = signal;
  }
}

export class RpcRemoteError extends Error {
  public readonly code: number;
  public readonly data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = 'RpcRemoteError';
    this.code = code;
    this.data = data;
  }
}

interface PendingRequest {
  method: string;
  resolve: (result: any) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export interface KconfigRpcClientOptions {
  pythonPath: string;
  workspaceRoot: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  logger?: (line: string) => void;
  onStatusChange?: (state: BackendLifecycleState, message?: string) => void;
  timeouts?: {
    initMs?: number;
    applyMs?: number;
    defaultMs?: number;
  };
  maxAutoRestarts?: number;
}

export class KconfigRpcClient {
  private readonly options: KconfigRpcClientOptions;
  private readonly logger: (line: string) => void;
  private readonly onStatusChange?: (state: BackendLifecycleState, message?: string) => void;
  private readonly maxAutoRestarts: number;

  private proc: ChildProcessWithoutNullStreams | null = null;
  private stdoutReader: readline.Interface | null = null;
  private stderrReader: readline.Interface | null = null;

  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private state: BackendLifecycleState = 'stopped';
  private disposing = false;
  private consecutiveRestarts = 0;
  private lastInitParams: Record<string, unknown> | null = null;

  constructor(options: KconfigRpcClientOptions) {
    this.options = options;
    this.logger = options.logger ?? (() => {});
    this.onStatusChange = options.onStatusChange;
    this.maxAutoRestarts = options.maxAutoRestarts ?? 2;
  }

  public getState(): BackendLifecycleState {
    return this.state;
  }

  public isRunning(): boolean {
    return this.proc !== null && this.state === 'running';
  }

  private setState(newState: BackendLifecycleState, message?: string): void {
    this.state = newState;
    this.onStatusChange?.(newState, message);
  }

  public start(): void {
    if (this.proc !== null) {
      return;
    }
    this.disposing = false;
    this.setState('starting', 'Spawning Kconfig Python daemon...');

    const args = this.options.args ?? ['-m', 'kconfig_server.main', 'serve'];
    const child = spawn(this.options.pythonPath, args, {
      cwd: this.options.workspaceRoot,
      env: { ...process.env, ...this.options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    child.stdin.setDefaultEncoding('utf8');
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    this.proc = child;

    this.stdoutReader = readline.createInterface({
      input: child.stdout,
      crlfDelay: Infinity,
    });
    this.stdoutReader.on('line', (line) => this.handleStdoutLine(line));

    this.stderrReader = readline.createInterface({
      input: child.stderr,
      crlfDelay: Infinity,
    });
    this.stderrReader.on('line', (line) => {
      this.logger(line);
    });

    child.on('error', (err) => {
      this.logger(`[rpcClient] Process spawn error: ${err.message}`);
      this.handleUnexpectedExit(null, null, err);
    });

    child.on('exit', (code, signal) => {
      if (this.proc === child) {
        this.handleUnexpectedExit(code, signal);
      }
    });

    this.setState('running');
  }

  private handleStdoutLine(rawLine: string): void {
    const line = rawLine.trim();
    if (!line) {
      return;
    }

    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch (err) {
      this.logger(`[rpcClient] Non-JSON stdout line ignored: ${line}`);
      return;
    }

    if (typeof msg !== 'object' || msg === null || msg.id === undefined || msg.id === null) {
      return;
    }

    const reqId = Number(msg.id);
    const pendingReq = this.pending.get(reqId);
    if (!pendingReq) {
      return;
    }

    clearTimeout(pendingReq.timer);
    this.pending.delete(reqId);
    this.consecutiveRestarts = 0;

    if (msg.error) {
      const code = typeof msg.error.code === 'number' ? msg.error.code : -32603;
      const message = typeof msg.error.message === 'string' ? msg.error.message : 'Unknown RPC error';
      pendingReq.reject(new RpcRemoteError(code, message, msg.error.data));
    } else {
      pendingReq.resolve(msg.result);
    }
  }

  private handleUnexpectedExit(
    code: number | null,
    signal: NodeJS.Signals | null,
    spawnErr?: Error
  ): void {
    this.cleanupReaders();
    this.proc = null;

    const err = spawnErr ?? new RpcProcessExitedError(code, signal);
    for (const [id, req] of this.pending.entries()) {
      clearTimeout(req.timer);
      req.reject(err);
      this.pending.delete(id);
    }

    if (!this.disposing) {
      this.logger(`[rpcClient] Daemon exited (code=${code}, signal=${signal})`);
      this.setState('stopped', err.message);
    } else {
      this.setState('stopped');
    }
  }

  private cleanupReaders(): void {
    if (this.stdoutReader) {
      this.stdoutReader.removeAllListeners();
      this.stdoutReader.close();
      this.stdoutReader = null;
    }
    if (this.stderrReader) {
      this.stderrReader.removeAllListeners();
      this.stderrReader.close();
      this.stderrReader = null;
    }
  }

  private getTimeoutForMethod(method: string, customTimeoutMs?: number): number {
    if (customTimeoutMs !== undefined) {
      return customTimeoutMs;
    }
    if (method === 'kconfig/init') {
      return this.options.timeouts?.initMs ?? 60_000;
    }
    if (method === 'kconfig/apply' || method === 'kconfig/layers/set') {
      return this.options.timeouts?.applyMs ?? 45_000;
    }
    return this.options.timeouts?.defaultMs ?? 10_000;
  }

  public async request<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    customTimeoutMs?: number
  ): Promise<T> {
    if (!this.proc) {
      if (this.disposing) {
        throw new Error('KconfigRpcClient has been disposed');
      }
      if (this.lastInitParams && method !== 'kconfig/init') {
        if (this.consecutiveRestarts >= this.maxAutoRestarts) {
          throw new Error(
            `Kconfig backend exceeded max automatic restarts (${this.maxAutoRestarts})`
          );
        }
        this.consecutiveRestarts += 1;
        this.setState('restarting', `Auto-restarting Kconfig daemon (attempt ${this.consecutiveRestarts})...`);
        this.start();
        await this.sendRawRequest('kconfig/init', this.lastInitParams);
      } else {
        this.start();
      }
    }

    if (method === 'kconfig/init') {
      this.lastInitParams = { ...params };
    }

    return this.sendRawRequest<T>(method, params, customTimeoutMs);
  }

  private sendRawRequest<T>(
    method: string,
    params: Record<string, unknown>,
    customTimeoutMs?: number
  ): Promise<T> {
    const activeProc = this.proc;
    if (!activeProc || !activeProc.stdin.writable) {
      return Promise.reject(new Error('Kconfig backend stdin is not writable'));
    }

    const id = this.nextId++;
    const timeoutMs = this.getTimeoutForMethod(method, customTimeoutMs);

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcTimeoutError(method, timeoutMs));
      }, timeoutMs);

      this.pending.set(id, { method, resolve, reject, timer });

      const payload = JSON.stringify({
        jsonrpc: '2.0',
        id,
        method,
        params,
      });

      activeProc.stdin.write(payload + '\n', 'utf8', (writeErr) => {
        if (writeErr) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(writeErr);
        }
      });
    });
  }

  public async restart(): Promise<InitResponse | null> {
    this.setState('restarting', 'Restarting Kconfig daemon...');
    await this.dispose();
    this.consecutiveRestarts = 0;
    this.start();
    if (this.lastInitParams) {
      return this.init(this.lastInitParams as any);
    }
    return null;
  }

  public async dispose(): Promise<void> {
    this.disposing = true;
    const activeProc = this.proc;
    this.proc = null;
    this.cleanupReaders();

    for (const [id, req] of this.pending.entries()) {
      clearTimeout(req.timer);
      req.reject(new RpcProcessExitedError(null, null));
      this.pending.delete(id);
    }

    if (!activeProc) {
      this.setState('stopped');
      return;
    }

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };

      activeProc.once('exit', finish);

      try {
        activeProc.stdin.end();
      } catch {
        // ignore stdin close error
      }

      const termTimer = setTimeout(() => {
        if (!settled) {
          try {
            activeProc.kill('SIGTERM');
          } catch {
            // ignore
          }
        }
      }, 2_000);

      const killTimer = setTimeout(() => {
        if (!settled) {
          try {
            activeProc.kill('SIGKILL');
          } catch {
            // ignore
          }
          finish();
        }
      }, 2_500);

      activeProc.once('exit', () => {
        clearTimeout(termTimer);
        clearTimeout(killTimer);
      });
    });

    this.setState('stopped');
  }

  // Typed RPC Methods
  public async init(params: {
    workspaceRoot: string;
    kernelDir?: string;
    buildDir?: string;
    arch?: string;
    layersJsonPath?: string;
    useMakeProbe?: boolean;
  }): Promise<InitResponse> {
    return this.request<InitResponse>('kconfig/init', params);
  }

  public async getTree(parentId: string | null = null): Promise<{ nodes: KconfigNode[] }> {
    return this.request<{ nodes: KconfigNode[] }>('kconfig/getTree', { parentId });
  }

  public async search(params: {
    query: string;
    limit?: number;
    onlyChanged?: boolean;
  }): Promise<{ items: SearchItem[] }> {
    return this.request<{ items: SearchItem[] }>('kconfig/search', params);
  }

  public async getSymbolDetail(symbol: string): Promise<SymbolDetail> {
    return this.request<SymbolDetail>('kconfig/getSymbolDetail', { symbol });
  }

  public async solve(params: {
    requests: Array<{ symbol: string; value: string }>;
    ignorePins?: boolean;
  }): Promise<SolveResponse> {
    const raw = await this.request<any>('kconfig/solve', params);
    const changes: SolveChange[] = (raw.changes ?? []).map((c: any) => ({
      symbol: c.symbol,
      from: c.from ?? c.oldValue ?? 'n',
      to: c.to ?? c.newValue ?? 'n',
      oldValue: c.oldValue ?? c.from ?? 'n',
      newValue: c.newValue ?? c.to ?? 'n',
      reason: c.reason ?? 'dependency_closure',
    }));
    return {
      status: raw.status,
      solveTimeMs: raw.solveTimeMs,
      changes,
      conflicts: raw.conflicts ?? [],
      diagnostics: raw.diagnostics ?? [],
      warnings: raw.warnings ?? [],
    };
  }

  public async getLayers(): Promise<LayersPayload> {
    return this.request<LayersPayload>('kconfig/layers/get', {});
  }

  public async setLayers(params: {
    baseTarget: string;
    layers: ConfigLayer[];
    runConfigure?: boolean;
  }): Promise<LayersPayload & { applyResult?: ApplyResponse }> {
    return this.request<LayersPayload & { applyResult?: ApplyResponse }>('kconfig/layers/set', params);
  }

  public async apply(
    changes: Array<{ symbol: string; value: string }>
  ): Promise<ApplyResponse> {
    return this.request<ApplyResponse>('kconfig/apply', { changes });
  }

  public async reloadConfig(): Promise<{ reloaded: boolean; configPath: string; exists: boolean }> {
    return this.request<{ reloaded: boolean; configPath: string; exists: boolean }>('kconfig/reloadConfig', {});
  }
}
