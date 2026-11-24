import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runGit } from '../../src/patchstack/gitRunner';
import { classifyBranch, GitStackEngine } from '../../src/patchstack/gitStackEngine';
import { BranchClassificationConfig } from '../../src/patchstack/types';

const TEST_CONFIG: BranchClassificationConfig = {
  topicPrefix: 'topic/',
  reviewPrefix: 'review/',
  maintainerPrefixes: ['probes/', 'for-next'],
  fixesSuffixes: ['fixes', 'urgent'],
  nextSuffixes: ['for-next', 'next', 'core'],
};

describe('GitStackEngine integration (Layer 1: ephemeral Git repos)', () => {
  let tmpDir: string;
  let originDir: string;
  let repoDir: string;
  let engine: GitStackEngine;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kdev-git-stack-'));
    originDir = path.join(tmpDir, 'origin.git');
    repoDir = path.join(tmpDir, 'linux');
    fs.mkdirSync(originDir, { recursive: true });
    fs.mkdirSync(repoDir, { recursive: true });

    await runGit(originDir, ['init', '--bare', '-b', 'master']);
    await runGit(repoDir, ['init', '-b', 'master']);
    await runGit(repoDir, ['config', 'user.name', 'Kernel Dev']);
    await runGit(repoDir, ['config', 'user.email', 'dev@kernel.org']);
    await runGit(repoDir, ['remote', 'add', 'origin', originDir]);

    fs.writeFileSync(path.join(repoDir, 'file1.c'), 'line1\nline2\nline3\n', 'utf-8');
    fs.writeFileSync(path.join(repoDir, 'file2.c'), 'alpha\nbeta\n', 'utf-8');
    await runGit(repoDir, ['add', '.']);
    await runGit(repoDir, ['commit', '-m', 'base commit']);
    await runGit(repoDir, ['push', '-u', 'origin', 'master']);

    engine = new GitStackEngine(repoDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('classifies customizable maintainerPrefixes (prefix-style and flat) and cadences', () => {
    expect(classifyBranch('topic/fprobe-cleanup', TEST_CONFIG)).toEqual({ role: 'topic' });
    expect(classifyBranch('review/fix-bug', TEST_CONFIG)).toEqual({ role: 'review' });
    expect(classifyBranch('probes/fixes', TEST_CONFIG)).toEqual({
      role: 'maintainer',
      cadence: 'fixes',
      subsystem: 'probes',
    });
    expect(classifyBranch('probes/core', TEST_CONFIG)).toEqual({
      role: 'maintainer',
      cadence: 'for-next',
      subsystem: 'probes',
    });
    expect(classifyBranch('for-next', TEST_CONFIG)).toEqual({
      role: 'maintainer',
      cadence: 'for-next',
      subsystem: '',
    });
    expect(classifyBranch('master', TEST_CONFIG)).toEqual({ role: 'other' });
  });

  it('refreshes patch #1 in a 3-patch topic stack, auto-rebases #2/#3, and supports Undo', async () => {
    await engine.createBranch('topic/stack-test', 'master', 'topic');

    fs.writeFileSync(path.join(repoDir, 'p1.c'), 'int p1 = 1;\n', 'utf-8');
    await runGit(repoDir, ['add', 'p1.c']);
    await runGit(repoDir, ['commit', '-m', 'patch 1\n\nSigned-off-by: Kernel Dev <dev@kernel.org>']);

    fs.writeFileSync(path.join(repoDir, 'p2.c'), 'int p2 = 2;\n', 'utf-8');
    await runGit(repoDir, ['add', 'p2.c']);
    await runGit(repoDir, ['commit', '-m', 'patch 2\n\nSigned-off-by: Kernel Dev <dev@kernel.org>']);

    fs.writeFileSync(path.join(repoDir, 'p3.c'), 'int p3 = 3;\n', 'utf-8');
    await runGit(repoDir, ['add', 'p3.c']);
    await runGit(repoDir, ['commit', '-m', 'patch 3\n\nSigned-off-by: Kernel Dev <dev@kernel.org>']);

    const before = await engine.inspectStack(TEST_CONFIG);
    expect(before.commits).toHaveLength(3);
    expect(before.commits.every((c) => c.hasSignedOffBy)).toBe(true);
    const oldHead = before.headSha;

    // Modify p1.c and refresh into patch #1
    fs.writeFileSync(path.join(repoDir, 'p1.c'), 'int p1 = 42;\n', 'utf-8');
    const refreshRes = await engine.refreshCommit(before.commits[0].sha, TEST_CONFIG, {
      stageTracked: true,
    });
    expect(refreshRes.status).toBe('ok');

    const after = await engine.inspectStack(TEST_CONFIG);
    expect(after.commits.map((c) => c.subject)).toEqual(['patch 1', 'patch 2', 'patch 3']);
    expect(fs.readFileSync(path.join(repoDir, 'p1.c'), 'utf-8')).toBe('int p1 = 42;\n');
    expect(after.headSha).not.toBe(oldHead);

    // Undo restores exact prior HEAD SHA and file contents
    const undoRes = await engine.undo('topic/stack-test');
    expect(undoRes.restoredSha).toBe(oldHead);
    expect(fs.readFileSync(path.join(repoDir, 'p1.c'), 'utf-8')).toBe('int p1 = 1;\n');
  });

  it('handles refresh conflict -> abort and conflict -> resolve -> continue', async () => {
    await engine.createBranch('topic/conflict-test', 'master', 'topic');

    fs.writeFileSync(path.join(repoDir, 'file1.c'), 'line1-p1\nline2\nline3\n', 'utf-8');
    await runGit(repoDir, ['add', 'file1.c']);
    await runGit(repoDir, ['commit', '-m', 'patch 1']);

    fs.writeFileSync(path.join(repoDir, 'file1.c'), 'line1-p2\nline2\nline3\n', 'utf-8');
    await runGit(repoDir, ['add', 'file1.c']);
    await runGit(repoDir, ['commit', '-m', 'patch 2']);

    const ins = await engine.inspectStack(TEST_CONFIG);

    // Refresh patch 1 with conflicting change on line1
    fs.writeFileSync(path.join(repoDir, 'file1.c'), 'line1-conflict\nline2\nline3\n', 'utf-8');
    const res1 = await engine.refreshCommit(ins.commits[0].sha, TEST_CONFIG, { stageTracked: true });
    expect(res1.status).toBe('conflict');
    expect(res1.conflictingFiles).toContain('file1.c');

    // Abort returns to clean state
    await engine.abortOperation();
    expect(await engine.detectOperationState()).toBe('clean');
    // Note: fixup commit was created before rebase; undo brings back original 2 commits
    await engine.undo('topic/conflict-test');

    const ins2 = await engine.inspectStack(TEST_CONFIG);
    fs.writeFileSync(path.join(repoDir, 'file1.c'), 'line1-resolved-base\nline2\nline3\n', 'utf-8');
    const res2 = await engine.refreshCommit(ins2.commits[0].sha, TEST_CONFIG, { stageTracked: true });
    expect(res2.status).toBe('conflict');

    // Resolve conflict(s) across fixup and dependent patch 2, then continue
    let contRes = res2;
    while (contRes.status === 'conflict') {
      fs.writeFileSync(path.join(repoDir, 'file1.c'), 'line1-final\nline2\nline3\n', 'utf-8');
      await runGit(repoDir, ['add', 'file1.c']);
      contRes = await engine.continueOperation();
    }
    expect(contRes.status).toBe('ok');
    expect(await engine.detectOperationState()).toBe('clean');
    expect(fs.readFileSync(path.join(repoDir, 'file1.c'), 'utf-8')).toBe('line1-final\nline2\nline3\n');
  });

  it('guards published maintainer commits and performs transactional cross-branch move', async () => {
    // Create probes/fixes with one pushed (published) commit
    await engine.createBranch('probes/fixes', 'master', 'maintainer', {
      upstreamRef: 'origin/probes/fixes',
    });
    fs.writeFileSync(path.join(repoDir, 'file1.c'), 'line1-pub\nline2\nline3\n', 'utf-8');
    await runGit(repoDir, ['add', 'file1.c']);
    await runGit(repoDir, ['commit', '-m', 'probes: published fix']);
    await runGit(repoDir, ['push', '-u', 'origin', 'probes/fixes']);

    const fixesIns = await engine.inspectStack(TEST_CONFIG);
    expect(fixesIns.commits).toHaveLength(1);
    expect(fixesIns.commits[0].published).toBe(true);

    // Guard blocks dropping published commit without override
    await expect(engine.dropCommit(fixesIns.commits[0].sha, TEST_CONFIG, false)).rejects.toThrow(
      /already published/
    );

    // Create probes/for-next with two unpublished commits: one clean for fixes, one conflicting with fixes
    await engine.createBranch('probes/for-next', 'master', 'maintainer');
    fs.writeFileSync(path.join(repoDir, 'file2.c'), 'alpha-next\nbeta\n', 'utf-8');
    await runGit(repoDir, ['add', 'file2.c']);
    await runGit(repoDir, ['commit', '-m', 'probes: clean patch to move']);

    fs.writeFileSync(path.join(repoDir, 'file1.c'), 'line1-conflicting-next\nline2\nline3\n', 'utf-8');
    await runGit(repoDir, ['add', 'file1.c']);
    await runGit(repoDir, ['commit', '-m', 'probes: conflicting patch']);

    const nextBefore = await engine.inspectStack(TEST_CONFIG);
    expect(nextBefore.commits).toHaveLength(2);
    const cleanCommitSha = nextBefore.commits[0].sha;
    const conflictCommitSha = nextBefore.commits[1].sha;

    // 1. Conflicting cross-branch move aborts cleanly and leaves source untouched
    const conflictMove = await engine.movePatchesToBranch(
      [conflictCommitSha],
      'probes/fixes',
      TEST_CONFIG
    );
    expect(conflictMove.status).toBe('conflict');
    expect(await engine.getCurrentBranch()).toBe('probes/for-next');
    expect((await engine.inspectStack(TEST_CONFIG)).headSha).toBe(nextBefore.headSha);

    // 2. Clean cross-branch move cherry-picks onto probes/fixes and drops from probes/for-next
    const okMove = await engine.movePatchesToBranch([cleanCommitSha], 'probes/fixes', TEST_CONFIG);
    expect(okMove.status).toBe('ok');
    expect(await engine.getCurrentBranch()).toBe('probes/for-next');
    expect((await engine.inspectStack(TEST_CONFIG)).commits.map((c) => c.subject)).toEqual([
      'probes: conflicting patch',
    ]);

    await engine.checkoutBranch('probes/fixes');
    expect((await engine.inspectStack(TEST_CONFIG)).commits.map((c) => c.subject)).toEqual([
      'probes: published fix',
      'probes: clean patch to move',
    ]);
  });
});
