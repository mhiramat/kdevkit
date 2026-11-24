import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runGit } from '../../src/patchstack/gitRunner';
import { sanitizeBranchSlug } from '../../src/patchstack/gitStackEngine';
import {
  mergeCoverLetterIntoPatch,
  parseCoverMarkdown,
  SeriesStore,
} from '../../src/patchstack/seriesStore';

describe('SeriesStore & cover letter handling', () => {
  let tmpDir: string;
  let stateDir: string;
  let repoDir: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kdev-series-unit-'));
    stateDir = path.join(tmpDir, '.kdev', 'series');
    repoDir = path.join(tmpDir, 'repo');
    fs.mkdirSync(repoDir, { recursive: true });
    await runGit(repoDir, ['init', '-b', 'master']);
    await runGit(repoDir, ['config', 'user.name', 'Test Dev']);
    await runGit(repoDir, ['config', 'user.email', 'dev@kernel.org']);
    fs.writeFileSync(path.join(repoDir, 'a.c'), 'int a = 1;\n', 'utf-8');
    await runGit(repoDir, ['add', 'a.c']);
    await runGit(repoDir, ['commit', '-m', 'base commit']);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('sanitizes branch names into safe .kdev/series slugs', () => {
    expect(sanitizeBranchSlug('topic/fprobe-cleanup')).toBe('topic__fprobe-cleanup');
    expect(sanitizeBranchSlug('probes/for-next')).toBe('probes__for-next');
    expect(sanitizeBranchSlug('topic/weird name@1')).toBe('topic__weird_name_1');
  });

  it('merges cover.md into 0000-cover-letter.patch preserving raw tabs and trailers', () => {
    const rawCover = [
      'From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001',
      'From: Test Dev <dev@kernel.org>',
      'Date: Mon, 24 Nov 2026 10:00:00 +0900',
      'Subject: [PATCH v2 0/2] *** SUBJECT HERE ***',
      '',
      '*** BLURB HERE ***',
      '',
      'Test Dev (2):',
      '  foo: patch 1',
      '  foo: patch 2',
      '',
      ' a.c | 2 ++',
      ' 1 file changed, 2 insertions(+)',
      '',
      'base-commit: a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
      '-- ',
      '2.43.0',
    ].join('\n');

    const coverMd = [
      'Subject: fprobe: clean up entry handling',
      '',
      'Motivation:',
      '\tPreserve leading tab indentation verbatim.',
      '',
      'Changes in v2:',
      '- Fixed review feedback',
    ].join('\n');

    expect(parseCoverMarkdown(coverMd)).toEqual({
      subject: 'fprobe: clean up entry handling',
      body: 'Motivation:\n\tPreserve leading tab indentation verbatim.\n\nChanges in v2:\n- Fixed review feedback',
    });

    const merged = mergeCoverLetterIntoPatch(rawCover, coverMd);
    expect(merged).toContain('Subject: [PATCH v2 0/2] fprobe: clean up entry handling');
    expect(merged).toContain('\tPreserve leading tab indentation verbatim.');
    expect(merged).toContain('Test Dev (2):');
    expect(merged).toContain('base-commit: a1b2c3d4e5f60718293a4b5c6d7e8f9012345678');
  });

  it('records v1 snapshot ref and computes git range-diff on bumpVersion (v1 -> v2)', async () => {
    const store = new SeriesStore(stateDir);
    const baseSha = (await runGit(repoDir, ['rev-parse', 'HEAD'])).stdout.trim();

    await runGit(repoDir, ['checkout', '-b', 'topic/demo']);
    fs.writeFileSync(path.join(repoDir, 'a.c'), 'int a = 2;\n', 'utf-8');
    await runGit(repoDir, ['add', 'a.c']);
    await runGit(repoDir, ['commit', '-m', 'demo: set a to 2\n\nSigned-off-by: Test Dev <dev@kernel.org>']);
    const v1Head = (await runGit(repoDir, ['rev-parse', 'HEAD'])).stdout.trim();

    const snap = await store.recordStagedSnapshot(repoDir, 'topic/demo', {
      version: 1,
      stagedAt: new Date().toISOString(),
      baseSha,
      headSha: v1Head,
      undinedSeriesId: 'ser_test_1',
    });
    expect(snap.gitRef).toBe('refs/kdev/staged/topic__demo/v1');

    // Amend commit for v2
    fs.writeFileSync(path.join(repoDir, 'a.c'), 'int a = 3;\n', 'utf-8');
    await runGit(repoDir, ['add', 'a.c']);
    await runGit(repoDir, ['commit', '--amend', '--no-edit']);
    const v2Head = (await runGit(repoDir, ['rev-parse', 'HEAD'])).stdout.trim();

    const { meta, rangeDiff } = await store.bumpVersion(repoDir, 'topic/demo', baseSha, v2Head);
    expect(meta.version).toBe(2);
    expect(rangeDiff).not.toBeNull();
    expect(rangeDiff).toContain('demo: set a to 2');

    const coverPath = store.appendRangeDiffToCover('topic/demo', 2, rangeDiff!);
    expect(fs.readFileSync(coverPath, 'utf-8')).toContain('Changes in v2:');
  });
});
