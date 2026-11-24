import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { runGit } from './gitRunner';
import { mergeCoverLetterIntoPatch } from './seriesStore';
import { CheckpatchIssue, FormattedPatch, PreflightResult, StackCommit } from './types';

const execFileAsync = promisify(execFile);

/**
 * Parse `scripts/get_maintainer.pl --no-rolestats` stdout into deduplicated recipient addresses.
 */
export function parseGetMaintainerOutput(stdout: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || !line.includes('@')) {
      continue;
    }
    // Strip any trailing role annotation in parentheses if --no-rolestats wasn't honored
    const cleaned = line.replace(/\s+\([^)]+\)\s*$/, '').trim();
    const key = cleaned.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      result.push(cleaned);
    }
  }

  return result;
}

/**
 * Parse `scripts/checkpatch.pl` output into structured issues.
 */
export function parseCheckpatchOutput(stdout: string): CheckpatchIssue[] {
  const issues: CheckpatchIssue[] = [];
  const lines = stdout.split(/\r?\n/);

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const match = line.match(/^(ERROR|WARNING|CHECK):\s*(.+)$/);
    if (!match) {
      continue;
    }
    const severity = match[1] as 'ERROR' | 'WARNING' | 'CHECK';
    const message = match[2].trim();

    let file: string | undefined;
    let lineNum: number | undefined;
    const nextLine = lines[i + 1] ?? '';
    const locMatch = nextLine.match(/^#\d+:\s+FILE:\s+([^:]+):(\d+):/);
    if (locMatch) {
      file = locMatch[1];
      lineNum = Number.parseInt(locMatch[2], 10);
    }

    issues.push({ severity, file, line: lineNum, message });
  }

  return issues;
}

/**
 * Parse a `git format-patch` mbox/patch file into `{ subject, body, commitSha }`,
 * unfolding RFC 2822 continuation lines in Subject while preserving the patch body
 * (including raw `\t` tabs and exact UTF-8) verbatim.
 */
export function parseFormattedPatchFile(
  rawContent: string,
  filePath: string,
  index: number,
  isCoverLetter: boolean
): FormattedPatch {
  const normalized = rawContent.replace(/\r\n/g, '\n');
  const sepIdx = normalized.indexOf('\n\n');
  const headerBlock = sepIdx >= 0 ? normalized.slice(0, sepIdx) : normalized;
  const body = sepIdx >= 0 ? normalized.slice(sepIdx + 2) : '';

  const headerLines = headerBlock.split('\n');
  let commitSha: string | undefined;
  let subject = '';

  if (headerLines.length > 0) {
    const fromMatch = headerLines[0].match(/^From\s+([0-9a-f]{40})\s+/);
    if (fromMatch && !/^0+$/.test(fromMatch[1])) {
      commitSha = fromMatch[1];
    }
  }

  for (let i = 0; i < headerLines.length; i += 1) {
    const line = headerLines[i];
    if (/^Subject:\s*/i.test(line)) {
      subject = line.replace(/^Subject:\s*/i, '');
      while (i + 1 < headerLines.length && /^[ \t]+/.test(headerLines[i + 1])) {
        i += 1;
        subject += ` ${headerLines[i].trim()}`;
      }
      subject = subject.trim();
      break;
    }
  }

  return {
    index,
    isCoverLetter,
    filePath,
    subject,
    body,
    commitSha,
  };
}

export interface FormatSeriesOptions {
  baseSha: string;
  headRef?: string;
  version: number;
  subjectPrefix: string;
  stagingDir: string;
  includeCoverLetter: boolean;
  coverMdContent?: string;
}

/**
 * Run `git format-patch` into `stagingDir`, merge `cover.md` into `0000-cover-letter.patch`
 * when present, and return ordered `FormattedPatch[]` with exact UTF-8 and `\t` preservation.
 */
export async function formatPatchesForSeries(
  repoDir: string,
  opts: FormatSeriesOptions
): Promise<FormattedPatch[]> {
  fs.rmSync(opts.stagingDir, { recursive: true, force: true });
  fs.mkdirSync(opts.stagingDir, { recursive: true });

  const args = [
    'format-patch',
    `--base=${opts.baseSha}`,
    `--subject-prefix=${opts.subjectPrefix || 'PATCH'}`,
  ];
  if (opts.version > 1) {
    args.push('-v', String(opts.version));
  }
  if (opts.includeCoverLetter) {
    args.push('--cover-letter');
  }
  args.push('-o', opts.stagingDir, `${opts.baseSha}..${opts.headRef || 'HEAD'}`);

  await runGit(repoDir, args);

  const files = fs
    .readdirSync(opts.stagingDir)
    .filter((f) => f.endsWith('.patch'))
    .sort();

  const patches: FormattedPatch[] = [];
  for (const fileName of files) {
    const fullPath = path.join(opts.stagingDir, fileName);
    let raw = fs.readFileSync(fullPath, 'utf-8');
    const isCover = fileName.includes('0000-cover-letter');
    if (isCover && opts.coverMdContent) {
      raw = mergeCoverLetterIntoPatch(raw, opts.coverMdContent);
      fs.writeFileSync(fullPath, raw, 'utf-8');
    }

    const numMatch = fileName.match(/(?:v\d+-)?(\d{4})-/);
    const index = numMatch ? Number.parseInt(numMatch[1], 10) : patches.length;
    patches.push(parseFormattedPatchFile(raw, fullPath, index, isCover));
  }

  return patches;
}

/**
 * Run `scripts/get_maintainer.pl` and `scripts/checkpatch.pl` inside `repoDir`
 * plus verify `Signed-off-by:` trailers across stack commits.
 */
export async function runPreflightChecks(
  repoDir: string,
  baseSha: string,
  commits: StackCommit[],
  patchFiles?: string[]
): Promise<PreflightResult> {
  const missingSignoffShas = commits.filter((c) => !c.hasSignedOffBy).map((c) => c.shortSha);

  let maintainers: string[] = [];
  const getMaintainerScript = path.join(repoDir, 'scripts', 'get_maintainer.pl');
  if (fs.existsSync(getMaintainerScript)) {
    try {
      let stdout = '';
      if (patchFiles && patchFiles.length > 0) {
        const res = await execFileAsync('perl', [getMaintainerScript, '--no-rolestats', ...patchFiles], {
          cwd: repoDir,
          timeout: 60_000,
          maxBuffer: 16 * 1024 * 1024,
          encoding: 'utf-8',
        });
        stdout = res.stdout;
      } else {
        const diffRes = await runGit(repoDir, ['diff', `${baseSha}..HEAD`]);
        const tmpPatch = path.join(repoDir, '.git', 'kdev-preflight.diff');
        try {
          fs.writeFileSync(tmpPatch, diffRes.stdout, 'utf-8');
          const res = await execFileAsync('perl', [getMaintainerScript, '--no-rolestats', tmpPatch], {
            cwd: repoDir,
            timeout: 60_000,
            maxBuffer: 16 * 1024 * 1024,
            encoding: 'utf-8',
          });
          stdout = res.stdout;
        } finally {
          fs.rmSync(tmpPatch, { force: true });
        }
      }
      maintainers = parseGetMaintainerOutput(stdout);
    } catch {
      // Non-fatal: continue returning checkpatch and signoff results
    }
  }

  let checkpatchIssues: CheckpatchIssue[] = [];
  const checkpatchScript = path.join(repoDir, 'scripts', 'checkpatch.pl');
  if (fs.existsSync(checkpatchScript)) {
    try {
      const res = await execFileAsync(
        'perl',
        [checkpatchScript, '--strict', '--no-summary', '--git', `${baseSha}..HEAD`],
        {
          cwd: repoDir,
          timeout: 60_000,
          maxBuffer: 16 * 1024 * 1024,
          encoding: 'utf-8',
        }
      );
      checkpatchIssues = parseCheckpatchOutput(res.stdout);
    } catch (err: unknown) {
      const e = err as { stdout?: string | Buffer };
      if (e.stdout) {
        checkpatchIssues = parseCheckpatchOutput(e.stdout.toString('utf-8'));
      }
    }
  }

  const errorCount = checkpatchIssues.filter((i) => i.severity === 'ERROR').length;
  const warningCount = checkpatchIssues.filter((i) => i.severity === 'WARNING').length;

  return {
    maintainers,
    checkpatchIssues,
    missingSignoffShas,
    errorCount,
    warningCount,
  };
}
