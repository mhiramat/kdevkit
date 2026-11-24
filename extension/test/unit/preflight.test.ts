import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runGit } from '../../src/patchstack/gitRunner';
import {
  formatPatchesForSeries,
  parseCheckpatchOutput,
  parseFormattedPatchFile,
  parseGetMaintainerOutput,
} from '../../src/patchstack/preflight';

describe('preflight parsers & format-patch', () => {
  let tmpDir: string;
  let repoDir: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kdev-preflight-unit-'));
    repoDir = path.join(tmpDir, 'repo');
    fs.mkdirSync(repoDir, { recursive: true });
    await runGit(repoDir, ['init', '-b', 'master']);
    await runGit(repoDir, ['config', 'user.name', 'Test Dev']);
    await runGit(repoDir, ['config', 'user.email', 'dev@kernel.org']);
    fs.writeFileSync(path.join(repoDir, 'foo.c'), 'int x = 0;\n', 'utf-8');
    await runGit(repoDir, ['add', 'foo.c']);
    await runGit(repoDir, ['commit', '-m', 'init']);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('parses get_maintainer.pl output and deduplicates recipients', () => {
    const out = [
      'Steven Rostedt <rostedt@goodmis.org> (maintainer:TRACING)',
      'Masami Hiramatsu <mhiramat@kernel.org>',
      'masami hiramatsu <mhiramat@kernel.org>',
      'linux-trace-kernel@vger.kernel.org (open list:TRACING)',
      'not-an-email-line',
    ].join('\n');

    expect(parseGetMaintainerOutput(out)).toEqual([
      'Steven Rostedt <rostedt@goodmis.org>',
      'Masami Hiramatsu <mhiramat@kernel.org>',
      'linux-trace-kernel@vger.kernel.org',
    ]);
  });

  it('parses checkpatch.pl errors, warnings, and file:line coordinates', () => {
    const out = [
      'ERROR: code indent should use tabs where possible',
      '#24: FILE: kernel/trace/fprobe.c:112:',
      '+        return 0;',
      '',
      'WARNING: Missing Signed-off-by: line(s)',
      '',
      'CHECK: Alignment should match open parenthesis',
      '#31: FILE: kernel/trace/fprobe.c:120:',
    ].join('\n');

    expect(parseCheckpatchOutput(out)).toEqual([
      {
        severity: 'ERROR',
        file: 'kernel/trace/fprobe.c',
        line: 112,
        message: 'code indent should use tabs where possible',
      },
      {
        severity: 'WARNING',
        file: undefined,
        line: undefined,
        message: 'Missing Signed-off-by: line(s)',
      },
      {
        severity: 'CHECK',
        file: 'kernel/trace/fprobe.c',
        line: 120,
        message: 'Alignment should match open parenthesis',
      },
    ]);
  });

  it('formats patches with cover letter and preserves raw tabs verbatim', async () => {
    const baseSha = (await runGit(repoDir, ['rev-parse', 'HEAD'])).stdout.trim();
    fs.writeFileSync(path.join(repoDir, 'foo.c'), 'int f(void)\n{\n\treturn 1;\n}\n', 'utf-8');
    await runGit(repoDir, ['add', 'foo.c']);
    await runGit(repoDir, ['commit', '-m', 'foo: add tabbed function\n\nSigned-off-by: Test Dev <dev@kernel.org>']);

    fs.writeFileSync(path.join(repoDir, 'foo.c'), 'int f(void)\n{\n\treturn 2;\n}\n', 'utf-8');
    await runGit(repoDir, ['add', 'foo.c']);
    await runGit(repoDir, ['commit', '-m', 'foo: return 2\n\nSigned-off-by: Test Dev <dev@kernel.org>']);

    const stagingDir = path.join(tmpDir, 'staging');
    const patches = await formatPatchesForSeries(repoDir, {
      baseSha,
      version: 2,
      subjectPrefix: 'PATCH',
      stagingDir,
      includeCoverLetter: true,
      coverMdContent: 'Subject: foo series\n\nCover body with\ttab.',
    });

    expect(patches).toHaveLength(3);
    expect(patches[0].isCoverLetter).toBe(true);
    expect(patches[0].subject).toBe('[PATCH v2 0/2] foo series');
    expect(patches[0].body).toContain('Cover body with\ttab.');
    expect(patches[1].isCoverLetter).toBe(false);
    expect(patches[1].commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(patches[1].body).toContain('+\treturn 1;');
  });

  it('unfolds multi-line RFC 2822 Subject headers', () => {
    const raw = [
      'From 1111111111111111111111111111111111111111 Mon Sep 17 00:00:00 2001',
      'Subject: [PATCH 1/1] very long subject',
      ' continuation line',
      '',
      'body text\twith tab\n',
    ].join('\n');

    const parsed = parseFormattedPatchFile(raw, '/tmp/0001.patch', 1, false);
    expect(parsed.subject).toBe('[PATCH 1/1] very long subject continuation line');
    expect(parsed.body).toBe('body text\twith tab\n');
    expect(parsed.commitSha).toBe('1111111111111111111111111111111111111111');
  });
});
