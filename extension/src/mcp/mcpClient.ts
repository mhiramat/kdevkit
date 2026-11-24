import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';

export class McpTimeoutError extends Error {
  constructor(method: string, timeoutMs: number) {
    super(`MCP request "${method}" timed out after ${timeoutMs}ms`);
    this.name = 'McpTimeoutError';
  }
}

export class McpRpcError extends Error {
  public readonly code: number;
  public readonly data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = 'McpRpcError';
    this.code = code;
    this.data = data;
  }
}

export class McpToolError extends Error {
  public readonly toolName: string;

  constructor(toolName: string, message: string) {
    super(`MCP tool "${toolName}" failed: ${message}`);
    this.name = 'McpToolError';
    this.toolName = toolName;
  }
}

export interface McpClientOptions {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  clientName?: string;
  clientVersion?: string;
  logger?: (line: string) => void;
}

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

interface McpCallToolResponse {
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}

/**
 * Generic vscode-free MCP JSON-RPC 2.0 NDJSON STDIO client.
 */
export class McpStdioClient {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private initialized = false;
  private nextId = 1;
  private stdoutBuffer = '';
  private readonly pending = new Map<number, PendingRequest>();
  private readonly options: McpClientOptions;
  private startPromise: Promise<void> | null = null;

  constructor(options: McpClientOptions) {
    this.options = options;
  }

  public isRunning(): boolean {
    return this.proc !== null && !this.proc.killed && this.proc.exitCode === null;
  }

  public async ensureStarted(): Promise<void> {
    if (this.isRunning() && this.initialized) {
      return;
    }
    if (this.startPromise) {
      return this.startPromise;
    }
    this.startPromise = this.startInternal().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  private async startInternal(): Promise<void> {
    await this.dispose();

    const child = spawn(this.options.command, this.options.args, {
      cwd: this.options.cwd,
      env: this.options.env ? { ...process.env, ...this.options.env } : process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc = child;
    this.initialized = false;
    this.stdoutBuffer = '';

    child.stdout.setEncoding('utf-8');
    child.stdout.on('data', (chunk: string) => {
      this.handleStdoutChunk(chunk);
    });

    child.stderr.setEncoding('utf-8');
    child.stderr.on('data', (chunk: string) => {
      for (const line of chunk.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed) {
          this.options.logger?.(`[mcp:stderr] ${trimmed}`);
        }
      }
    });

    child.on('error', (err) => {
      this.rejectAllPending(new Error(`MCP process error: ${err.message}`));
      this.proc = null;
      this.initialized = false;
    });

    child.on('exit', (code, signal) => {
      const reason = `MCP process exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`;
      this.options.logger?.(`[mcp] ${reason}`);
      this.rejectAllPending(new Error(reason));
      if (this.proc === child) {
        this.proc = null;
        this.initialized = false;
      }
    });

    await this.sendRequestRaw('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: {
        name: this.options.clientName ?? 'kdevkit',
        version: this.options.clientVersion ?? '0.1.0',
      },
    });
    this.sendNotificationRaw('notifications/initialized', {});
    this.initialized = true;
  }

  private handleStdoutChunk(chunk: string): void {
    this.stdoutBuffer += chunk;
    let nlIdx = this.stdoutBuffer.indexOf('\n');
    while (nlIdx !== -1) {
      const rawLine = this.stdoutBuffer.slice(0, nlIdx).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(nlIdx + 1);
      if (rawLine) {
        this.handleJsonLine(rawLine);
      }
      nlIdx = this.stdoutBuffer.indexOf('\n');
    }
  }

  private handleJsonLine(rawLine: string): void {
    let msg: {
      id?: number;
      result?: unknown;
      error?: { code: number; message: string; data?: unknown };
    };
    try {
      msg = JSON.parse(rawLine) as typeof msg;
    } catch {
      this.options.logger?.(`[mcp] Ignoring non-JSON stdout line: ${rawLine}`);
      return;
    }

    if (typeof msg.id !== 'number') {
      return;
    }

    const req = this.pending.get(msg.id);
    if (!req) {
      return;
    }
    this.pending.delete(msg.id);
    clearTimeout(req.timer);

    if (msg.error) {
      req.reject(new McpRpcError(msg.error.code, msg.error.message, msg.error.data));
    } else {
      req.resolve(msg.result);
    }
  }

  private sendNotificationRaw(method: string, params?: unknown): void {
    if (!this.proc || this.proc.stdin.destroyed) {
      return;
    }
    const payload =
      params !== undefined
        ? { jsonrpc: '2.0', method, params }
        : { jsonrpc: '2.0', method };
    this.proc.stdin.write(`${JSON.stringify(payload)}\n`, 'utf-8');
  }

  private sendRequestRaw(
    method: string,
    params?: unknown,
    timeoutMs?: number
  ): Promise<unknown> {
    if (!this.proc || this.proc.stdin.destroyed) {
      return Promise.reject(new Error('MCP server process is not running'));
    }

    const id = this.nextId;
    this.nextId += 1;
    const effectiveTimeout = timeoutMs ?? this.options.requestTimeoutMs ?? 30_000;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new McpTimeoutError(method, effectiveTimeout));
      }, effectiveTimeout);

      this.pending.set(id, { method, resolve, reject, timer });

      const payload =
        params !== undefined
          ? { jsonrpc: '2.0', id, method, params }
          : { jsonrpc: '2.0', id, method };
      this.proc!.stdin.write(`${JSON.stringify(payload)}\n`, 'utf-8');
    });
  }

  public async listTools(timeoutMs?: number): Promise<McpToolDescriptor[]> {
    await this.ensureStarted();
    const res = (await this.sendRequestRaw('tools/list', {}, timeoutMs)) as {
      tools?: McpToolDescriptor[];
    };
    return Array.isArray(res?.tools) ? res.tools : [];
  }

  public async callTool<T = unknown>(
    toolName: string,
    args: Record<string, unknown>,
    timeoutMs?: number
  ): Promise<T> {
    await this.ensureStarted();
    const res = (await this.sendRequestRaw(
      'tools/call',
      { name: toolName, arguments: args },
      timeoutMs
    )) as McpCallToolResponse;

    const textParts = (res?.content ?? [])
      .filter((c) => c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text as string);
    const combinedText = textParts.join('\n').trim();

    if (res?.isError) {
      throw new McpToolError(toolName, combinedText || 'Unknown tool error');
    }

    if (res?.structuredContent !== undefined) {
      const sc = res.structuredContent as Record<string, unknown>;
      if (sc && typeof sc === 'object' && 'result' in sc && Object.keys(sc).length === 1) {
        return sc.result as T;
      }
      return res.structuredContent as T;
    }

    if (!combinedText) {
      return {} as T;
    }

    try {
      return JSON.parse(combinedText) as T;
    } catch {
      return combinedText as unknown as T;
    }
  }

  public async restart(): Promise<void> {
    await this.dispose();
    await this.ensureStarted();
  }

  public async dispose(): Promise<void> {
    this.rejectAllPending(new Error('MCP client disposed'));
    this.initialized = false;
    const child = this.proc;
    this.proc = null;
    if (!child) {
      return;
    }

    await new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };

      const killTimer = setTimeout(() => {
        if (child.exitCode === null) {
          child.kill('SIGKILL');
        }
        done();
      }, 1500);

      child.once('exit', () => {
        clearTimeout(killTimer);
        done();
      });

      try {
        if (!child.stdin.destroyed) {
          child.stdin.end();
        }
        if (child.exitCode === null) {
          child.kill('SIGTERM');
        }
      } catch {
        clearTimeout(killTimer);
        done();
      }
    });
  }

  private rejectAllPending(err: Error): void {
    for (const [id, req] of this.pending.entries()) {
      clearTimeout(req.timer);
      this.pending.delete(id);
      req.reject(err);
    }
  }
}
