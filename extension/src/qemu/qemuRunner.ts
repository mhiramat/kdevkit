import { ChildProcess, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';

export class QemuBusyError extends Error {
  constructor(message = 'Another QEMU session is already running.') {
    super(message);
    this.name = 'QemuBusyError';
  }
}

export interface QemuRunOptions {
  /** Path to the launcher script (defaults to <workspaceRoot>/scripts/run_qemu.sh). */
  scriptPath?: string;
  workspaceRoot: string;
  env?: NodeJS.ProcessEnv;
  /** Overall run timeout in seconds (default 300). */
  timeoutSec?: number;
  /** Boot-hang watchdog timeout in seconds (default 60). Set <= 0 to disable. */
  bootTimeoutSec?: number;
  /** Sentinel line that disarms the boot-hang watchdog (default "=== KDEV_SELFTEST_BEGIN ==="). */
  bootSentinel?: string;
  /** Optional path to shared/exit_code written by guest /init. */
  exitCodePath?: string;
  /** Grace period before escalating SIGTERM to SIGKILL (default 3000ms). */
  killGraceMs?: number;
  /** Live line callback for stdout and stderr. */
  onLine?: (line: string, stream: 'stdout' | 'stderr') => void;
  /** Optional AbortSignal for cancellation. */
  signal?: AbortSignal;
}

export interface QemuRunResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  guestExitCode: number | null;
  timedOut: boolean;
  bootTimedOut: boolean;
  cancelled: boolean;
  durationMs: number;
}

/**
 * Managed QEMU child process runner (zero `vscode` imports).
 * Enforces single-session mutual exclusion, process-group cancellation,
 * live stdout/stderr line streaming, and overall + boot-hang watchdogs.
 */
export class QemuRunner {
  private activeChild: ChildProcess | null = null;
  private activeKillGraceMs = 3000;
  private killEscalationTimer: NodeJS.Timeout | null = null;
  private cancelRequested = false;

  public isRunning(): boolean {
    return this.activeChild !== null;
  }

  public cancel(): void {
    const child = this.activeChild;
    if (!child || this.cancelRequested) {
      return;
    }
    this.cancelRequested = true;
    this.terminateProcessGroup(child, this.activeKillGraceMs);
  }

  private terminateProcessGroup(child: ChildProcess, graceMs: number): void {
    const pid = child.pid;
    if (!pid) {
      return;
    }
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      try {
        child.kill('SIGTERM');
      } catch {
        // Process already exited
      }
    }

    if (this.killEscalationTimer) {
      clearTimeout(this.killEscalationTimer);
    }
    this.killEscalationTimer = setTimeout(() => {
      if (this.activeChild === child) {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          try {
            child.kill('SIGKILL');
          } catch {
            // Process already exited
          }
        }
      }
    }, Math.max(50, graceMs));
  }

  public async run(options: QemuRunOptions): Promise<QemuRunResult> {
    if (this.activeChild !== null) {
      throw new QemuBusyError();
    }

    const scriptPath =
      options.scriptPath ?? path.join(options.workspaceRoot, 'scripts', 'run_qemu.sh');
    const timeoutSec = options.timeoutSec ?? 300;
    const bootTimeoutSec = options.bootTimeoutSec ?? 60;
    const bootSentinel = options.bootSentinel ?? '=== KDEV_SELFTEST_BEGIN ===';
    const killGraceMs = options.killGraceMs ?? 3000;

    if (options.exitCodePath && fs.existsSync(options.exitCodePath)) {
      try {
        fs.unlinkSync(options.exitCodePath);
      } catch {
        // Ignore stale file unlink failure
      }
    }

    const startedAt = Date.now();
    this.cancelRequested = false;
    this.activeKillGraceMs = killGraceMs;

    return new Promise<QemuRunResult>((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = spawn(scriptPath, [], {
          cwd: options.workspaceRoot,
          env: { ...process.env, ...options.env },
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (err) {
        reject(err);
        return;
      }

      this.activeChild = child;

      let timedOut = false;
      let bootTimedOut = false;
      let bootSeen = false;
      let settled = false;

      let overallTimer: NodeJS.Timeout | null = null;
      let bootTimer: NodeJS.Timeout | null = null;

      const clearTimers = () => {
        if (overallTimer) {
          clearTimeout(overallTimer);
          overallTimer = null;
        }
        if (bootTimer) {
          clearTimeout(bootTimer);
          bootTimer = null;
        }
        if (this.killEscalationTimer) {
          clearTimeout(this.killEscalationTimer);
          this.killEscalationTimer = null;
        }
      };

      const onAbort = () => {
        this.cancel();
      };

      if (options.signal) {
        if (options.signal.aborted) {
          this.cancel();
        } else {
          options.signal.addEventListener('abort', onAbort, { once: true });
        }
      }

      if (timeoutSec > 0) {
        overallTimer = setTimeout(() => {
          if (this.activeChild === child) {
            timedOut = true;
            this.terminateProcessGroup(child, killGraceMs);
          }
        }, timeoutSec * 1000);
      }

      if (bootTimeoutSec > 0) {
        bootTimer = setTimeout(() => {
          if (!bootSeen && this.activeChild === child) {
            bootTimedOut = true;
            this.terminateProcessGroup(child, killGraceMs);
          }
        }, bootTimeoutSec * 1000);
      }

      const handleLine = (line: string, stream: 'stdout' | 'stderr') => {
        if (!bootSeen && bootSentinel && line.includes(bootSentinel)) {
          bootSeen = true;
          if (bootTimer) {
            clearTimeout(bootTimer);
            bootTimer = null;
          }
        }
        options.onLine?.(line, stream);
      };

      const rlOut = child.stdout
        ? readline.createInterface({ input: child.stdout, crlfDelay: Infinity })
        : null;
      const rlErr = child.stderr
        ? readline.createInterface({ input: child.stderr, crlfDelay: Infinity })
        : null;

      rlOut?.on('line', (line) => handleLine(line, 'stdout'));
      rlErr?.on('line', (line) => handleLine(line, 'stderr'));

      const cleanup = () => {
        clearTimers();
        rlOut?.close();
        rlErr?.close();
        if (options.signal) {
          options.signal.removeEventListener('abort', onAbort);
        }
        if (this.activeChild === child) {
          this.activeChild = null;
        }
      };

      child.once('error', (err) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(err);
      });

      child.once('close', (code, sig) => {
        if (settled) {
          return;
        }
        settled = true;
        const cancelled = this.cancelRequested;
        cleanup();

        let guestExitCode: number | null = null;
        if (options.exitCodePath && fs.existsSync(options.exitCodePath)) {
          try {
            const raw = fs.readFileSync(options.exitCodePath, 'utf-8').trim();
            const parsed = Number.parseInt(raw, 10);
            if (!Number.isNaN(parsed)) {
              guestExitCode = parsed;
            }
          } catch {
            // Ignore unreadable exit_code file
          }
        }

        resolve({
          exitCode: code,
          signal: sig,
          guestExitCode,
          timedOut,
          bootTimedOut,
          cancelled,
          durationMs: Date.now() - startedAt,
        });
      });
    });
  }
}
