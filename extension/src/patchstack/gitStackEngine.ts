import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { GitError, runGit, tryGit } from './gitRunner';
import {
  BranchClassification,
  BranchClassificationConfig,
  BranchInfo,
  BranchRole,
  GitOperationState,
  MaintainerCadence,
  StackCommit,
  StackInspection,
  StackMutationResult,
} from './types';

const MAX_UNDO_HISTORY = 20;

export function sanitizeBranchSlug(branch: string): string {
  return branch
    .trim()
    .replace(/\//g, '__')
    .replace(/[^a-zA-Z0-9._-]/g, '_');
}

function globMatch(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(value);
}

export function detectMaintainerCadence(
  branchName: string,
  config: Pick<BranchClassificationConfig, 'fixesSuffixes' | 'nextSuffixes'>
): MaintainerCadence {
  const lastSegment = branchName.includes('/')
    ? branchName.slice(branchName.lastIndexOf('/') + 1)
    : branchName;

  if (config.fixesSuffixes.includes(lastSegment)) {
    return 'fixes';
  }
  if (config.nextSuffixes.includes(lastSegment)) {
    return 'for-next';
  }
  return 'custom';
}

export function classifyBranch(
  branchName: string,
  config: BranchClassificationConfig,
  explicitRole?: BranchRole
): BranchClassification {
  if (explicitRole && explicitRole !== 'other') {
    if (explicitRole === 'maintainer') {
      const slashIdx = branchName.indexOf('/');
      return {
        role: 'maintainer',
        cadence: detectMaintainerCadence(branchName, config),
        subsystem: slashIdx > 0 ? branchName.slice(0, slashIdx) : '',
      };
    }
    return { role: explicitRole };
  }

  if (config.topicPrefix && branchName.startsWith(config.topicPrefix)) {
    return { role: 'topic' };
  }
  if (config.reviewPrefix && branchName.startsWith(config.reviewPrefix)) {
    return { role: 'review' };
  }

  for (const rawPattern of config.maintainerPrefixes) {
    const pattern = rawPattern.trim();
    if (!pattern) {
      continue;
    }
    if (pattern.endsWith('/')) {
      if (branchName.startsWith(pattern)) {
        return {
          role: 'maintainer',
          cadence: detectMaintainerCadence(branchName, config),
          subsystem: pattern.slice(0, -1),
        };
      }
    } else if (pattern.includes('*')) {
      if (globMatch(pattern, branchName)) {
        const slashIdx = branchName.indexOf('/');
        return {
          role: 'maintainer',
          cadence: detectMaintainerCadence(branchName, config),
          subsystem: slashIdx > 0 ? branchName.slice(0, slashIdx) : '',
        };
      }
    } else if (branchName === pattern) {
      return {
        role: 'maintainer',
        cadence: detectMaintainerCadence(branchName, config),
        subsystem: '',
      };
    }
  }

  return { role: 'other' };
}

export class GitStackEngine {
  private readonly redoStack = new Map<string, string[]>();

  constructor(private readonly repoDir: string) {}

  public getRepoDir(): string {
    return this.repoDir;
  }

  public async getGitDir(): Promise<string> {
    const res = await runGit(this.repoDir, ['rev-parse', '--git-dir']);
    const raw = res.stdout.trim();
    return path.isAbsolute(raw) ? raw : path.resolve(this.repoDir, raw);
  }

  public async getCurrentBranch(): Promise<string> {
    const res = await tryGit(this.repoDir, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    if (res.exitCode === 0 && res.stdout.trim()) {
      return res.stdout.trim();
    }
    return '';
  }

  public async getHeadSha(): Promise<string> {
    const res = await runGit(this.repoDir, ['rev-parse', 'HEAD']);
    return res.stdout.trim();
  }

  public async getBranchConfig(branch: string, key: string): Promise<string | undefined> {
    const res = await tryGit(this.repoDir, ['config', '--get', `branch.${branch}.${key}`]);
    if (res.exitCode !== 0) {
      return undefined;
    }
    const val = res.stdout.trim();
    return val || undefined;
  }

  public async setBranchConfig(branch: string, key: string, value: string): Promise<void> {
    await runGit(this.repoDir, ['config', `branch.${branch}.${key}`, value]);
  }

  public async unsetBranchConfig(branch: string, key: string): Promise<void> {
    await tryGit(this.repoDir, ['config', '--unset', `branch.${branch}.${key}`]);
  }

  public async setBranchRole(branch: string, role: BranchRole): Promise<void> {
    if (role === 'other') {
      await this.unsetBranchConfig(branch, 'kdev-role');
    } else {
      await this.setBranchConfig(branch, 'kdev-role', role);
    }
  }

  public async checkoutBranch(branch: string): Promise<void> {
    await runGit(this.repoDir, ['checkout', branch]);
  }

  public async createBranch(
    branch: string,
    baseRef: string,
    role: BranchRole,
    extra?: { sourceMsgId?: string; upstreamRef?: string }
  ): Promise<void> {
    await runGit(this.repoDir, ['checkout', '-b', branch, baseRef]);
    await this.setBranchRole(branch, role);
    await this.setBranchConfig(branch, 'kdev-base', baseRef);
    if (role === 'topic') {
      await this.setBranchConfig(branch, 'kdev-version', '1');
    }
    if (extra?.sourceMsgId) {
      await this.setBranchConfig(branch, 'kdev-source-msgid', extra.sourceMsgId);
    }
    if (extra?.upstreamRef) {
      await this.setBranchConfig(branch, 'kdev-upstream-ref', extra.upstreamRef);
    }
  }

  public async detectOperationState(): Promise<GitOperationState> {
    const gitDir = await this.getGitDir();
    if (fs.existsSync(path.join(gitDir, 'rebase-merge'))) {
      return 'rebase';
    }
    if (fs.existsSync(path.join(gitDir, 'rebase-apply'))) {
      if (fs.existsSync(path.join(gitDir, 'rebase-apply', 'applying'))) {
        return 'am';
      }
      return 'rebase';
    }
    if (fs.existsSync(path.join(gitDir, 'CHERRY_PICK_HEAD'))) {
      return 'cherry-pick';
    }
    return 'clean';
  }

  public async getConflictingFiles(): Promise<string[]> {
    const res = await tryGit(this.repoDir, ['diff', '--name-only', '--diff-filter=U']);
    if (res.exitCode !== 0) {
      return [];
    }
    return res.stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
  }

  public async getWorkingTreeStatus(): Promise<{ isDirty: boolean; hasStagedChanges: boolean }> {
    const res = await runGit(this.repoDir, ['status', '--porcelain']);
    const lines = res.stdout.split(/\r?\n/).filter((l) => l.length >= 2);
    let isDirty = false;
    let hasStagedChanges = false;
    for (const line of lines) {
      if (line.startsWith('??')) {
        continue;
      }
      isDirty = true;
      const indexStatus = line[0];
      if (indexStatus !== ' ' && indexStatus !== '?') {
        hasStagedChanges = true;
      }
    }
    return { isDirty, hasStagedChanges };
  }

  public async resolveBaseRefAndSha(branch: string): Promise<{ baseRef: string; baseSha: string }> {
    const configured = await this.getBranchConfig(branch, 'kdev-base');
    const candidates: string[] = [];
    if (configured) {
      candidates.push(configured);
    }

    const upstream = await tryGit(this.repoDir, [
      'rev-parse',
      '--abbrev-ref',
      `${branch}@{upstream}`,
    ]);
    if (upstream.exitCode === 0 && upstream.stdout.trim()) {
      candidates.push(upstream.stdout.trim());
    }

    candidates.push('torvalds/master', 'origin/master', 'origin/main', 'master', 'main');

    for (const candidate of candidates) {
      if (candidate === branch) {
        continue;
      }
      const mb = await tryGit(this.repoDir, ['merge-base', candidate, branch]);
      if (mb.exitCode === 0 && mb.stdout.trim()) {
        return { baseRef: candidate, baseSha: mb.stdout.trim() };
      }
      const verify = await tryGit(this.repoDir, ['rev-parse', '--verify', `${candidate}^{commit}`]);
      if (verify.exitCode === 0 && verify.stdout.trim()) {
        return { baseRef: candidate, baseSha: verify.stdout.trim() };
      }
    }

    const headSha = await this.getHeadSha();
    return { baseRef: headSha, baseSha: headSha };
  }

  public async listBranches(config: BranchClassificationConfig): Promise<BranchInfo[]> {
    const current = await this.getCurrentBranch();
    const res = await runGit(this.repoDir, [
      'for-each-ref',
      '--format=%(refname:short)',
      'refs/heads',
    ]);
    const names = res.stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);

    const branches: BranchInfo[] = [];
    for (const name of names) {
      const explicitRaw = await this.getBranchConfig(name, 'kdev-role');
      const explicitRole =
        explicitRaw === 'topic' || explicitRaw === 'review' || explicitRaw === 'maintainer'
          ? explicitRaw
          : undefined;

      const classification = classifyBranch(name, config, explicitRole);
      const baseRef = await this.getBranchConfig(name, 'kdev-base');
      const upstreamRef = await this.getBranchConfig(name, 'kdev-upstream-ref');
      const versionStr = await this.getBranchConfig(name, 'kdev-version');
      const sourceMsgId = await this.getBranchConfig(name, 'kdev-source-msgid');

      let aheadCount: number | undefined;
      if (classification.role !== 'other') {
        const resolved = await this.resolveBaseRefAndSha(name);
        const cnt = await tryGit(this.repoDir, ['rev-list', '--count', `${resolved.baseSha}..${name}`]);
        if (cnt.exitCode === 0) {
          aheadCount = Number.parseInt(cnt.stdout.trim(), 10) || 0;
        }
      }

      branches.push({
        name,
        role: classification.role,
        cadence: classification.cadence,
        subsystem: classification.subsystem,
        isCurrent: name === current,
        baseRef,
        upstreamRef,
        version: versionStr ? Number.parseInt(versionStr, 10) || undefined : undefined,
        sourceMsgId,
        aheadCount,
      });
    }

    return branches;
  }

  public async inspectStack(config: BranchClassificationConfig): Promise<StackInspection> {
    const opState = await this.detectOperationState();
    const conflictingFiles = opState === 'clean' ? [] : await this.getConflictingFiles();
    const { isDirty, hasStagedChanges } = await this.getWorkingTreeStatus();
    const branch = await this.getCurrentBranch();
    const headSha = await this.getHeadSha();

    const explicitRaw = branch ? await this.getBranchConfig(branch, 'kdev-role') : undefined;
    const explicitRole =
      explicitRaw === 'topic' || explicitRaw === 'review' || explicitRaw === 'maintainer'
        ? explicitRaw
        : undefined;
    const classification = branch
      ? classifyBranch(branch, config, explicitRole)
      : { role: 'other' as BranchRole };

    const { baseRef, baseSha } = branch
      ? await this.resolveBaseRefAndSha(branch)
      : { baseRef: headSha, baseSha: headSha };

    const publishedSet = new Set<string>();
    if (branch) {
      const upstreamRef = await this.getBranchConfig(branch, 'kdev-upstream-ref');
      if (upstreamRef) {
        const pubRes = await tryGit(this.repoDir, ['rev-list', `${baseSha}..${upstreamRef}`]);
        if (pubRes.exitCode === 0) {
          for (const sha of pubRes.stdout.split(/\r?\n/)) {
            const s = sha.trim();
            if (s) {
              publishedSet.add(s);
            }
          }
        }
      }
    }

    const commits: StackCommit[] = [];
    if (baseSha !== headSha) {
      const sep = '\x1f';
      const recSep = '\x1e';
      const logRes = await runGit(this.repoDir, [
        'rev-list',
        '--reverse',
        `--format=%H${sep}%h${sep}%s${sep}%an${sep}%aI${sep}%B${recSep}`,
        `${baseSha}..HEAD`,
      ]);
      const records = logRes.stdout.split(recSep);
      let idx = 0;
      for (const rawRec of records) {
        const trimmed = rawRec.trim();
        if (!trimmed) {
          continue;
        }
        // First line of rev-list --format output is "commit <sha>"
        const firstNewline = trimmed.indexOf('\n');
        const payload = firstNewline >= 0 ? trimmed.slice(firstNewline + 1) : trimmed;
        const parts = payload.split(sep);
        if (parts.length < 6) {
          continue;
        }
        const sha = parts[0].trim();
        const shortSha = parts[1].trim();
        const subject = parts[2].trim();
        const author = parts[3].trim();
        const date = parts[4].trim();
        const body = parts.slice(5).join(sep);

        idx += 1;
        commits.push({
          sha,
          shortSha,
          subject,
          author,
          date,
          hasSignedOffBy: /^Signed-off-by:\s+.+/m.test(body),
          published: publishedSet.has(sha),
          index: idx,
        });
      }
    }

    const undoRefs = branch ? await this.listUndoRefs(branch) : [];
    const poppedCount = branch ? await this.getPoppedCount(branch) : 0;

    return {
      branch,
      role: classification.role,
      cadence: classification.cadence,
      subsystem: classification.subsystem,
      baseRef,
      baseSha,
      headSha,
      commits,
      opState,
      conflictingFiles,
      isDirty,
      hasStagedChanges,
      undoCount: undoRefs.length,
      poppedCount,
    };
  }

  public async listUndoRefs(branch: string): Promise<Array<{ ref: string; seq: number; sha: string }>> {
    const slug = sanitizeBranchSlug(branch);
    const prefix = `refs/kdev/undo/${slug}/`;
    const res = await tryGit(this.repoDir, [
      'for-each-ref',
      '--format=%(refname) %(objectname)',
      prefix,
    ]);
    if (res.exitCode !== 0) {
      return [];
    }
    const items: Array<{ ref: string; seq: number; sha: string }> = [];
    for (const line of res.stdout.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      const [ref, sha] = trimmed.split(/\s+/);
      const seqStr = ref.slice(prefix.length);
      const seq = Number.parseInt(seqStr, 10);
      if (Number.isFinite(seq) && sha) {
        items.push({ ref, seq, sha });
      }
    }
    items.sort((a, b) => a.seq - b.seq);
    return items;
  }

  public async createUndoSnapshot(branch: string): Promise<string> {
    const slug = sanitizeBranchSlug(branch);
    const existing = await this.listUndoRefs(branch);
    const nextSeq = existing.length > 0 ? existing[existing.length - 1].seq + 1 : 1;
    const refName = `refs/kdev/undo/${slug}/${String(nextSeq).padStart(4, '0')}`;
    const shaRes = await runGit(this.repoDir, ['rev-parse', branch]);
    await runGit(this.repoDir, ['update-ref', refName, shaRes.stdout.trim()]);

    // Clear redo stack for this branch on new mutation
    this.redoStack.delete(branch);

    // Prune older undo refs beyond MAX_UNDO_HISTORY
    const updated = await this.listUndoRefs(branch);
    if (updated.length > MAX_UNDO_HISTORY) {
      const toDelete = updated.slice(0, updated.length - MAX_UNDO_HISTORY);
      for (const item of toDelete) {
        await tryGit(this.repoDir, ['update-ref', '-d', item.ref]);
      }
    }

    return refName;
  }

  public async undo(branch?: string): Promise<{ restoredSha: string; consumedRef: string }> {
    const targetBranch = branch || (await this.getCurrentBranch());
    if (!targetBranch) {
      throw new Error('Cannot undo on a detached HEAD');
    }
    const opState = await this.detectOperationState();
    if (opState !== 'clean') {
      throw new Error(`Cannot undo while a ${opState} operation is in progress`);
    }
    const status = await this.getWorkingTreeStatus();
    if (status.isDirty) {
      throw new Error('Working tree has uncommitted changes; commit or stash before Undo');
    }

    const refs = await this.listUndoRefs(targetBranch);
    if (refs.length === 0) {
      throw new Error(`No Undo snapshots available for branch ${targetBranch}`);
    }

    const latest = refs[refs.length - 1];
    const currentHead = await this.getHeadSha();
    const redoList = this.redoStack.get(targetBranch) ?? [];
    redoList.push(currentHead);
    this.redoStack.set(targetBranch, redoList);

    await runGit(this.repoDir, ['reset', '--hard', latest.sha]);
    await runGit(this.repoDir, ['update-ref', '-d', latest.ref]);

    return { restoredSha: latest.sha, consumedRef: latest.ref };
  }

  public async redo(branch?: string): Promise<{ restoredSha: string }> {
    const targetBranch = branch || (await this.getCurrentBranch());
    if (!targetBranch) {
      throw new Error('Cannot redo on a detached HEAD');
    }
    const redoList = this.redoStack.get(targetBranch);
    if (!redoList || redoList.length === 0) {
      throw new Error(`No Redo history available for branch ${targetBranch}`);
    }
    const nextSha = redoList.pop()!;
    const slug = sanitizeBranchSlug(targetBranch);
    const existing = await this.listUndoRefs(targetBranch);
    const nextSeq = existing.length > 0 ? existing[existing.length - 1].seq + 1 : 1;
    const refName = `refs/kdev/undo/${slug}/${String(nextSeq).padStart(4, '0')}`;
    const currentHead = await this.getHeadSha();
    await runGit(this.repoDir, ['update-ref', refName, currentHead]);
    await runGit(this.repoDir, ['reset', '--hard', nextSha]);
    return { restoredSha: nextSha };
  }

  private async ensureEditableCommit(
    targetSha: string,
    config: BranchClassificationConfig,
    allowPublished = false
  ): Promise<StackInspection> {
    const inspection = await this.inspectStack(config);
    if (inspection.opState !== 'clean') {
      throw new Error(`A ${inspection.opState} operation is already in progress`);
    }
    if (!inspection.branch) {
      throw new Error('Cannot mutate stack on a detached HEAD');
    }
    const target = inspection.commits.find((c) => c.sha === targetSha || c.shortSha === targetSha);
    if (!target) {
      throw new Error(`Commit ${targetSha} is not in the current branch stack`);
    }
    if (target.published && !allowPublished) {
      throw new Error(
        `Commit ${target.shortSha} ("${target.subject}") is already published on upstream; override confirmation is required.`
      );
    }
    return inspection;
  }

  /**
   * StGit `stg refresh` equivalent: fold staged (or tracked) changes into an arbitrary stack commit
   * and automatically rebase dependent commits above it.
   */
  public async refreshCommit(
    targetSha: string,
    config: BranchClassificationConfig,
    options: { allowPublished?: boolean; stageTracked?: boolean } = {}
  ): Promise<StackMutationResult> {
    const inspection = await this.ensureEditableCommit(
      targetSha,
      config,
      options.allowPublished ?? false
    );

    if (options.stageTracked) {
      await runGit(this.repoDir, ['add', '-u']);
    }

    const status = await this.getWorkingTreeStatus();
    if (!status.hasStagedChanges) {
      throw new Error('No staged changes to refresh into the target commit');
    }

    const undoRef = await this.createUndoSnapshot(inspection.branch);
    const target = inspection.commits.find((c) => c.sha === targetSha || c.shortSha === targetSha)!;

    // Fast path: refreshing top commit (HEAD)
    if (target.sha === inspection.headSha) {
      await runGit(this.repoDir, ['commit', '--amend', '--no-edit']);
      return { status: 'ok', undoRef };
    }

    // Fixup + autosquash rebase for non-HEAD stack commit
    await runGit(this.repoDir, ['commit', `--fixup=${target.sha}`]);
    const rebaseRes = await tryGit(
      this.repoDir,
      ['rebase', '-i', '--autosquash', '--autostash', inspection.baseSha],
      {
        env: { GIT_SEQUENCE_EDITOR: ':' },
      }
    );

    if (rebaseRes.exitCode !== 0) {
      const opState = await this.detectOperationState();
      if (opState === 'rebase') {
        const conflictingFiles = await this.getConflictingFiles();
        return {
          status: 'conflict',
          conflictingFiles,
          undoRef,
          message: rebaseRes.stderr.trim() || 'Rebase conflict during refresh',
        };
      }
      throw new GitError(
        rebaseRes.stderr.trim() || 'Rebase failed during refresh',
        rebaseRes.exitCode,
        rebaseRes.stdout,
        rebaseRes.stderr,
        ['rebase', '-i', '--autosquash', '--autostash', inspection.baseSha]
      );
    }

    return { status: 'ok', undoRef };
  }

  private async runScriptedRebase(
    baseSha: string,
    todoLines: string[],
    extraEnv: NodeJS.ProcessEnv = {}
  ): Promise<StackMutationResult> {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kdev-rebase-'));
    const todoFile = path.join(tmpDir, 'todo.txt');
    const seqScript = path.join(tmpDir, 'seq-editor.js');

    try {
      fs.writeFileSync(todoFile, `${todoLines.join('\n')}\n`, 'utf-8');
      fs.writeFileSync(
        seqScript,
        [
          `#!${process.execPath}`,
          'const fs = require("node:fs");',
          'const target = process.argv[2];',
          'fs.copyFileSync(process.env.KDEV_REBASE_TODO_FILE, target);',
        ].join('\n'),
        { mode: 0o755 }
      );

      const res = await tryGit(this.repoDir, ['rebase', '-i', '--autostash', baseSha], {
        env: {
          GIT_SEQUENCE_EDITOR: seqScript,
          KDEV_REBASE_TODO_FILE: todoFile,
          ...extraEnv,
        },
      });

      if (res.exitCode !== 0) {
        const opState = await this.detectOperationState();
        if (opState === 'rebase') {
          return {
            status: 'conflict',
            conflictingFiles: await this.getConflictingFiles(),
            message: res.stderr.trim() || 'Rebase conflict',
          };
        }
        throw new GitError(
          res.stderr.trim() || 'Scripted rebase failed',
          res.exitCode,
          res.stdout,
          res.stderr,
          ['rebase', '-i', '--autostash', baseSha]
        );
      }

      return { status: 'ok' };
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  /**
   * Reorder commits in the active stack. `newOrderBottomToTop` lists commit SHAs from base to HEAD.
   */
  public async reorderCommits(
    newOrderBottomToTop: string[],
    config: BranchClassificationConfig,
    allowPublished = false
  ): Promise<StackMutationResult> {
    const inspection = await this.inspectStack(config);
    if (inspection.opState !== 'clean') {
      throw new Error(`A ${inspection.opState} operation is already in progress`);
    }
    if (!inspection.branch) {
      throw new Error('Cannot reorder commits on detached HEAD');
    }
    if (newOrderBottomToTop.length !== inspection.commits.length) {
      throw new Error('Reordered commit list length does not match current stack');
    }
    if (!allowPublished && inspection.commits.some((c) => c.published)) {
      // Ensure published commits remain in their exact original prefix positions
      for (let i = 0; i < inspection.commits.length; i += 1) {
        if (inspection.commits[i].published && newOrderBottomToTop[i] !== inspection.commits[i].sha) {
          throw new Error(
            `Cannot reorder published commit ${inspection.commits[i].shortSha} without override`
          );
        }
      }
    }

    const undoRef = await this.createUndoSnapshot(inspection.branch);
    const todoLines = newOrderBottomToTop.map((sha) => `pick ${sha}`);
    const result = await this.runScriptedRebase(inspection.baseSha, todoLines);
    return { ...result, undoRef };
  }

  public async dropCommit(
    targetSha: string,
    config: BranchClassificationConfig,
    allowPublished = false
  ): Promise<StackMutationResult> {
    const inspection = await this.ensureEditableCommit(targetSha, config, allowPublished);
    const target = inspection.commits.find((c) => c.sha === targetSha || c.shortSha === targetSha)!;
    const undoRef = await this.createUndoSnapshot(inspection.branch);

    const remaining = inspection.commits.filter((c) => c.sha !== target.sha);
    if (remaining.length === 0) {
      await runGit(this.repoDir, ['reset', '--hard', inspection.baseSha]);
      return { status: 'ok', undoRef };
    }

    const todoLines = remaining.map((c) => `pick ${c.sha}`);
    const result = await this.runScriptedRebase(inspection.baseSha, todoLines);
    return { ...result, undoRef };
  }

  public async rewordCommit(
    targetSha: string,
    newMessage: string,
    config: BranchClassificationConfig,
    allowPublished = false
  ): Promise<StackMutationResult> {
    const inspection = await this.ensureEditableCommit(targetSha, config, allowPublished);
    const target = inspection.commits.find((c) => c.sha === targetSha || c.shortSha === targetSha)!;
    const undoRef = await this.createUndoSnapshot(inspection.branch);

    if (target.sha === inspection.headSha) {
      const tmpMsg = path.join(os.tmpdir(), `kdev-reword-${Date.now()}.txt`);
      try {
        fs.writeFileSync(tmpMsg, newMessage, 'utf-8');
        await runGit(this.repoDir, ['commit', '--amend', '-F', tmpMsg]);
        return { status: 'ok', undoRef };
      } finally {
        fs.rmSync(tmpMsg, { force: true });
      }
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kdev-reword-'));
    const msgFile = path.join(tmpDir, 'msg.txt');
    const msgEditor = path.join(tmpDir, 'msg-editor.js');
    try {
      fs.writeFileSync(msgFile, newMessage, 'utf-8');
      fs.writeFileSync(
        msgEditor,
        [
          `#!${process.execPath}`,
          'const fs = require("node:fs");',
          'fs.copyFileSync(process.env.KDEV_COMMIT_MSG_FILE, process.argv[2]);',
        ].join('\n'),
        { mode: 0o755 }
      );

      const todoLines = inspection.commits.map((c) =>
        c.sha === target.sha ? `reword ${c.sha}` : `pick ${c.sha}`
      );
      const result = await this.runScriptedRebase(inspection.baseSha, todoLines, {
        GIT_EDITOR: msgEditor,
        KDEV_COMMIT_MSG_FILE: msgFile,
      });
      return { ...result, undoRef };
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  public async continueOperation(): Promise<StackMutationResult> {
    const opState = await this.detectOperationState();
    if (opState === 'clean') {
      return { status: 'ok', message: 'No operation in progress' };
    }

    const cmd =
      opState === 'rebase'
        ? ['rebase', '--continue']
        : opState === 'am'
          ? ['am', '--continue']
          : ['cherry-pick', '--continue'];

    const res = await tryGit(this.repoDir, cmd, { env: { GIT_EDITOR: 'true' } });
    if (res.exitCode !== 0) {
      const stillState = await this.detectOperationState();
      if (stillState !== 'clean') {
        return {
          status: 'conflict',
          conflictingFiles: await this.getConflictingFiles(),
          message: res.stderr.trim() || `Conflict remaining during ${opState} --continue`,
        };
      }
      throw new GitError(res.stderr.trim(), res.exitCode, res.stdout, res.stderr, cmd);
    }
    return { status: 'ok' };
  }

  public async skipOperation(): Promise<StackMutationResult> {
    const opState = await this.detectOperationState();
    if (opState === 'clean') {
      return { status: 'ok' };
    }
    const cmd =
      opState === 'rebase'
        ? ['rebase', '--skip']
        : opState === 'am'
          ? ['am', '--skip']
          : ['cherry-pick', '--skip'];

    const res = await tryGit(this.repoDir, cmd, { env: { GIT_EDITOR: 'true' } });
    if (res.exitCode !== 0) {
      const stillState = await this.detectOperationState();
      if (stillState !== 'clean') {
        return {
          status: 'conflict',
          conflictingFiles: await this.getConflictingFiles(),
          message: res.stderr.trim(),
        };
      }
      throw new GitError(res.stderr.trim(), res.exitCode, res.stdout, res.stderr, cmd);
    }
    return { status: 'ok' };
  }

  public async abortOperation(): Promise<void> {
    const opState = await this.detectOperationState();
    if (opState === 'rebase') {
      await runGit(this.repoDir, ['rebase', '--abort']);
    } else if (opState === 'am') {
      await runGit(this.repoDir, ['am', '--abort']);
    } else if (opState === 'cherry-pick') {
      await runGit(this.repoDir, ['cherry-pick', '--abort']);
    }
  }

  private stackTopRef(branch: string): string {
    return `refs/kdev/stack-top/${sanitizeBranchSlug(branch)}`;
  }

  public async getPoppedCount(branch: string): Promise<number> {
    const topRef = this.stackTopRef(branch);
    const verify = await tryGit(this.repoDir, ['rev-parse', '--verify', topRef]);
    if (verify.exitCode !== 0) {
      return 0;
    }
    const cnt = await tryGit(this.repoDir, ['rev-list', '--count', `HEAD..${topRef}`]);
    return cnt.exitCode === 0 ? Number.parseInt(cnt.stdout.trim(), 10) || 0 : 0;
  }

  public async popCommits(count = 1, config: BranchClassificationConfig): Promise<StackMutationResult> {
    const inspection = await this.inspectStack(config);
    if (inspection.opState !== 'clean' || inspection.isDirty) {
      throw new Error('Working tree must be clean before popping commits');
    }
    if (!inspection.branch) {
      throw new Error('Cannot pop on detached HEAD');
    }
    const actualCount = Math.min(count, inspection.commits.length);
    if (actualCount <= 0) {
      throw new Error('No commits available to pop');
    }

    const topRef = this.stackTopRef(inspection.branch);
    const hasTop = await tryGit(this.repoDir, ['rev-parse', '--verify', topRef]);
    if (hasTop.exitCode !== 0) {
      await runGit(this.repoDir, ['update-ref', topRef, inspection.headSha]);
    }

    const undoRef = await this.createUndoSnapshot(inspection.branch);
    await runGit(this.repoDir, ['reset', '--hard', `HEAD~${actualCount}`]);
    return { status: 'ok', undoRef };
  }

  public async pushCommits(count = 1): Promise<StackMutationResult> {
    const branch = await this.getCurrentBranch();
    if (!branch) {
      throw new Error('Cannot push on detached HEAD');
    }
    const topRef = this.stackTopRef(branch);
    const listRes = await tryGit(this.repoDir, ['rev-list', '--reverse', `HEAD..${topRef}`]);
    if (listRes.exitCode !== 0) {
      throw new Error('No popped commits to push');
    }
    const pending = listRes.stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (pending.length === 0) {
      await tryGit(this.repoDir, ['update-ref', '-d', topRef]);
      throw new Error('No popped commits to push');
    }

    const toApply = pending.slice(0, count);
    const undoRef = await this.createUndoSnapshot(branch);
    const cpRes = await tryGit(this.repoDir, ['cherry-pick', ...toApply]);
    if (cpRes.exitCode !== 0) {
      return {
        status: 'conflict',
        conflictingFiles: await this.getConflictingFiles(),
        undoRef,
        message: cpRes.stderr.trim() || 'Conflict pushing popped commit',
      };
    }

    if (toApply.length >= pending.length) {
      await tryGit(this.repoDir, ['update-ref', '-d', topRef]);
    }
    return { status: 'ok', undoRef };
  }

  /**
   * Transactional cross-branch patch move (Section 4.5):
   * Cherry-picks unpublished commits onto targetBranch first; aborts and leaves sourceBranch
   * 100% untouched on conflict. Only after clean cherry-pick drops them from sourceBranch.
   */
  public async movePatchesToBranch(
    commitShas: string[],
    targetBranch: string,
    config: BranchClassificationConfig
  ): Promise<StackMutationResult> {
    if (commitShas.length === 0) {
      throw new Error('No commits selected to move');
    }
    const inspection = await this.inspectStack(config);
    if (inspection.opState !== 'clean') {
      throw new Error(`A ${inspection.opState} operation is already in progress`);
    }
    if (inspection.isDirty) {
      throw new Error('Working tree must be clean before moving patches across branches');
    }
    const sourceBranch = inspection.branch;
    if (!sourceBranch || sourceBranch === targetBranch) {
      throw new Error('Target branch must be different from the current branch');
    }

    const targetExists = await tryGit(this.repoDir, [
      'show-ref',
      '--verify',
      `refs/heads/${targetBranch}`,
    ]);
    if (targetExists.exitCode !== 0) {
      throw new Error(`Target branch "${targetBranch}" does not exist`);
    }

    // Order selected commits chronologically (bottom-to-top) and validate unpublished
    const shaSet = new Set(commitShas);
    const orderedSelected = inspection.commits.filter(
      (c) => shaSet.has(c.sha) || shaSet.has(c.shortSha)
    );
    if (orderedSelected.length !== commitShas.length) {
      throw new Error('One or more selected commits are not in the active branch stack');
    }
    for (const c of orderedSelected) {
      if (c.published) {
        throw new Error(`Cannot move published commit ${c.shortSha} ("${c.subject}")`);
      }
    }

    // Undo snapshots on BOTH branches before any mutation
    const sourceUndoRef = await this.createUndoSnapshot(sourceBranch);
    await this.createUndoSnapshot(targetBranch);

    const chronologicalShas = orderedSelected.map((c) => c.sha);

    // Step 1: Checkout targetBranch and cherry-pick
    await this.checkoutBranch(targetBranch);
    const cpRes = await tryGit(this.repoDir, ['cherry-pick', ...chronologicalShas]);
    if (cpRes.exitCode !== 0) {
      const conflicts = await this.getConflictingFiles();
      await tryGit(this.repoDir, ['cherry-pick', '--abort']);
      await this.checkoutBranch(sourceBranch);
      return {
        status: 'conflict',
        conflictingFiles: conflicts,
        undoRef: sourceUndoRef,
        message: `Cherry-pick into ${targetBranch} conflicted; aborted cleanly so ${sourceBranch} remains untouched.`,
      };
    }

    // Step 2: Checkout sourceBranch and drop the moved commits
    await this.checkoutBranch(sourceBranch);
    const movedSet = new Set(chronologicalShas);
    const remaining = inspection.commits.filter((c) => !movedSet.has(c.sha));
    if (remaining.length === 0) {
      await runGit(this.repoDir, ['reset', '--hard', inspection.baseSha]);
      return { status: 'ok', undoRef: sourceUndoRef };
    }

    const todoLines = remaining.map((c) => `pick ${c.sha}`);
    const dropRes = await this.runScriptedRebase(inspection.baseSha, todoLines);
    if (dropRes.status === 'conflict') {
      return {
        ...dropRes,
        undoRef: sourceUndoRef,
        message: `${targetBranch} received the moved commits, but rebasing remaining commits on ${sourceBranch} conflicted. Resolve or Undo on both branches.`,
      };
    }
    return { status: 'ok', undoRef: sourceUndoRef };
  }
}
