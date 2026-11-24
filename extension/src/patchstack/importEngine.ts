import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { runGit, tryGit } from './gitRunner';
import { GitStackEngine } from './gitStackEngine';
import { StackMutationResult } from './types';

const execFileAsync = promisify(execFile);

/**
 * Normalize a Message-ID or lore.kernel.org URL into a clean Message-ID without angle brackets.
 */
export function extractMessageId(input: string): string {
  let trimmed = input.trim();
  const urlMatch = trimmed.match(/^https?:\/\/[^/]+\/[^/]+\/([^/?#]+)/i);
  if (urlMatch) {
    trimmed = decodeURIComponent(urlMatch[1]);
  }
  return trimmed.replace(/^<+|>+$/g, '').trim();
}

/**
 * Inspect an mbox file for a `base-commit: <40-hex>` trailer.
 */
export function extractBaseCommitFromMbox(mboxContent: string): string | undefined {
  const match = mboxContent.match(/^base-commit:\s*([0-9a-f]{40})\b/m);
  return match ? match[1] : undefined;
}

/**
 * Derive a clean branch slug from the first Subject line in an mbox.
 */
export function extractSubjectSlugFromMbox(mboxContent: string, fallback = 'patch'): string {
  const match = mboxContent.match(/^Subject:\s*(.+)$/m);
  if (!match) {
    return fallback;
  }
  const cleaned = match[1]
    .replace(/^(?:Re:\s*)?(?:\[[^\]]*\]\s*)*/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return cleaned || fallback;
}

export interface B4FetchOptions {
  b4Bin: string;
  msgId: string;
  addLink?: boolean;
  addSignoff?: boolean;
  guessBase?: boolean;
  cwd?: string;
}

export interface B4FetchResult {
  mboxPath: string;
  tempDir: string;
  stdout: string;
  stderr: string;
}

/**
 * Fetch a patch series mbox using `b4 am` into a temporary directory (outside `linux/`).
 */
export async function fetchMboxViaB4(opts: B4FetchOptions): Promise<B4FetchResult> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kdev-b4-'));
  const args = ['am', '-o', tempDir];
  if (opts.addLink) {
    args.push('-l');
  }
  if (opts.addSignoff) {
    args.push('-s');
  }
  if (opts.guessBase) {
    args.push('--guess-base');
  }
  args.push(opts.msgId);

  try {
    const res = await execFileAsync(opts.b4Bin, args, {
      cwd: opts.cwd,
      timeout: 120_000,
      maxBuffer: 16 * 1024 * 1024,
      encoding: 'utf-8',
    });

    const files = fs
      .readdirSync(tempDir)
      .filter((f) => f.endsWith('.mbx') || f.endsWith('.mbox'))
      .sort();
    if (files.length === 0) {
      throw new Error(`b4 am did not produce an mbox file in ${tempDir}`);
    }

    return {
      mboxPath: path.join(tempDir, files[0]),
      tempDir,
      stdout: res.stdout,
      stderr: res.stderr,
    };
  } catch (err) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    throw err;
  }
}

export interface ImportReviewResult extends StackMutationResult {
  branch: string;
  baseRef: string;
  appliedCount: number;
}

/**
 * Create a `review/*` branch at `baseRef` and apply `mboxPath` via `git am -3`.
 */
export async function importReviewBranchFromMbox(
  engine: GitStackEngine,
  mboxPath: string,
  msgId: string,
  reviewPrefix: string,
  baseRef: string,
  customSlug?: string
): Promise<ImportReviewResult> {
  const repoDir = engine.getRepoDir();
  const mboxContent = fs.readFileSync(mboxPath, 'utf-8');
  const slug = customSlug || extractSubjectSlugFromMbox(mboxContent, 'series');
  const branch = `${reviewPrefix}${slug}`;

  const beforeSha = (await runGit(repoDir, ['rev-parse', baseRef])).stdout.trim();
  await engine.createBranch(branch, baseRef, 'review', { sourceMsgId: msgId });

  const amRes = await tryGit(repoDir, ['am', '-3', mboxPath]);
  if (amRes.exitCode !== 0) {
    const opState = await engine.detectOperationState();
    if (opState === 'am') {
      return {
        status: 'conflict',
        branch,
        baseRef,
        appliedCount: 0,
        conflictingFiles: await engine.getConflictingFiles(),
        message: amRes.stderr.trim() || 'git am -3 encountered conflicts',
      };
    }
    throw new Error(amRes.stderr.trim() || 'git am -3 failed');
  }

  const cntRes = await runGit(repoDir, ['rev-list', '--count', `${beforeSha}..HEAD`]);
  const appliedCount = Number.parseInt(cntRes.stdout.trim(), 10) || 0;

  return {
    status: 'ok',
    branch,
    baseRef,
    appliedCount,
  };
}

export interface MaintainerApplyResult extends StackMutationResult {
  branch: string;
  appliedCommits: Array<{ sha: string; shortSha: string; subject: string }>;
}

/**
 * Checkout `targetBranch`, create an Undo snapshot, and apply `mboxPath` via `git am -3`.
 */
export async function applyMboxToMaintainerBranch(
  engine: GitStackEngine,
  targetBranch: string,
  mboxPath: string
): Promise<MaintainerApplyResult> {
  const repoDir = engine.getRepoDir();
  const current = await engine.getCurrentBranch();
  if (current !== targetBranch) {
    await engine.checkoutBranch(targetBranch);
  }

  const beforeSha = await engine.getHeadSha();
  const undoRef = await engine.createUndoSnapshot(targetBranch);

  const amRes = await tryGit(repoDir, ['am', '-3', mboxPath]);
  if (amRes.exitCode !== 0) {
    const opState = await engine.detectOperationState();
    if (opState === 'am') {
      return {
        status: 'conflict',
        branch: targetBranch,
        undoRef,
        appliedCommits: [],
        conflictingFiles: await engine.getConflictingFiles(),
        message: amRes.stderr.trim() || 'git am -3 encountered conflicts on maintainer branch',
      };
    }
    throw new Error(amRes.stderr.trim() || 'git am -3 failed');
  }

  const logRes = await runGit(repoDir, [
    'log',
    '--reverse',
    '--format=%H\t%h\t%s',
    `${beforeSha}..HEAD`,
  ]);
  const appliedCommits = logRes.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const [sha, shortSha, ...rest] = line.split('\t');
      return { sha, shortSha, subject: rest.join('\t') };
    });

  return {
    status: 'ok',
    branch: targetBranch,
    undoRef,
    appliedCommits,
  };
}
