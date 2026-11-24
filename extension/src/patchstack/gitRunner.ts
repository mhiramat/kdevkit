import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface GitRunOptions {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxBuffer?: number;
}

export interface GitRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export class GitError extends Error {
  public readonly exitCode: number;
  public readonly stdout: string;
  public readonly stderr: string;
  public readonly args: string[];

  constructor(message: string, exitCode: number, stdout: string, stderr: string, args: string[]) {
    super(message);
    this.name = 'GitError';
    this.exitCode = exitCode;
    this.stdout = stdout;
    this.stderr = stderr;
    this.args = args;
  }
}

/**
 * Execute `git -C <repoDir> ...args` using `execFile` (never `shell: true`).
 */
export async function runGit(
  repoDir: string,
  args: string[],
  options: GitRunOptions = {}
): Promise<GitRunResult> {
  const fullArgs = ['-C', repoDir, ...args];
  try {
    const res = await execFileAsync('git', fullArgs, {
      env: options.env ? { ...process.env, ...options.env } : process.env,
      timeout: options.timeoutMs ?? 60_000,
      maxBuffer: options.maxBuffer ?? 32 * 1024 * 1024,
      encoding: 'utf-8',
    });
    return {
      stdout: res.stdout ?? '',
      stderr: res.stderr ?? '',
      exitCode: 0,
    };
  } catch (err: unknown) {
    const e = err as {
      code?: number | string;
      stdout?: string | Buffer;
      stderr?: string | Buffer;
      message?: string;
    };
    const stdout = e.stdout ? e.stdout.toString('utf-8') : '';
    const stderr = e.stderr ? e.stderr.toString('utf-8') : '';
    const exitCode = typeof e.code === 'number' ? e.code : 1;
    const detail = stderr.trim() || stdout.trim() || e.message || `git ${args[0] ?? ''} failed`;
    throw new GitError(detail, exitCode, stdout, stderr, args);
  }
}

/**
 * Execute `git -C <repoDir> ...args` without throwing on non-zero exit.
 */
export async function tryGit(
  repoDir: string,
  args: string[],
  options: GitRunOptions = {}
): Promise<GitRunResult> {
  try {
    return await runGit(repoDir, args, options);
  } catch (err) {
    if (err instanceof GitError) {
      return {
        stdout: err.stdout,
        stderr: err.stderr,
        exitCode: err.exitCode,
      };
    }
    throw err;
  }
}
