import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  checkTargetConfig,
  discoverTargetTests,
  filterSolvableRequests,
  listAvailableTargets,
  parseKconfigFile,
  parseKselftestList,
  parseMakefileTestProgs,
} from '../../src/selftest/discovery';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kdev-selftest-disc-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('Selftest Discovery & Config Diffing', () => {
  it('parses TEST_PROGS, TEST_GEN_PROGS, TEST_PROGS_EXTENDED with line continuations', () => {
    const makefile = `
# Sample Makefile
TEST_PROGS := test_a.sh \\
  test_b.sh
TEST_GEN_PROGS += breakpoint_test \\
  step_after_suspend_test $(EXTRA_PROGS)
TEST_PROGS_EXTENDED = ftracetest # trailing comment
`;
    const progs = parseMakefileTestProgs(makefile);
    expect(progs).toEqual([
      'test_a.sh',
      'test_b.sh',
      'breakpoint_test',
      'step_after_suspend_test',
      'ftracetest',
    ]);
  });

  it('lists available targets containing Makefiles and detects config files', () => {
    const ws = makeTempDir();
    const stRoot = path.join(ws, 'tools', 'testing', 'selftests');
    fs.mkdirSync(path.join(stRoot, 'ftrace'), { recursive: true });
    fs.writeFileSync(path.join(stRoot, 'ftrace', 'Makefile'), 'TEST_PROGS := ftracetest-ktap\n');
    fs.writeFileSync(path.join(stRoot, 'ftrace', 'config'), 'CONFIG_FTRACE=y\n');

    fs.mkdirSync(path.join(stRoot, 'breakpoints'), { recursive: true });
    fs.writeFileSync(
      path.join(stRoot, 'breakpoints', 'Makefile'),
      'TEST_GEN_PROGS := breakpoint_test\n'
    );

    // Non-target directory (no Makefile)
    fs.mkdirSync(path.join(stRoot, 'kselftest'), { recursive: true });

    const targets = listAvailableTargets(ws, 'x86_64');
    expect(targets.map((t) => t.name)).toEqual(['breakpoints', 'ftrace']);
    expect(targets[0].hasConfig).toBe(false);
    expect(targets[1].hasConfig).toBe(true);
    expect(targets[1].configPaths).toHaveLength(1);
  });

  it('reconciles Tier 1 Makefile scan with Tier 2 kselftest-list.txt and ftrace subtests', () => {
    const ws = makeTempDir();
    const ftraceDir = path.join(ws, 'tools', 'testing', 'selftests', 'ftrace');
    fs.mkdirSync(path.join(ftraceDir, 'test.d', '00basic'), { recursive: true });
    fs.writeFileSync(
      path.join(ftraceDir, 'Makefile'),
      'TEST_PROGS := ftracetest-ktap boottime-ktap\n'
    );
    fs.writeFileSync(path.join(ftraceDir, 'test.d', '00basic', 'basic1.tc'), '#!/bin/sh\n');

    // Tier 1 (before build)
    const tier1 = discoverTargetTests({ kernelDir: ws, target: 'ftrace' });
    expect(tier1.map((i) => i.id)).toEqual([
      'ftrace:ftracetest-ktap',
      'ftrace:boottime-ktap',
      'ftrace:ftracetest:test.d/00basic/basic1.tc',
    ]);

    // Tier 2 (after build with kselftest-list.txt)
    const listPath = path.join(ws, 'kselftest-list.txt');
    fs.writeFileSync(
      listPath,
      'breakpoints:breakpoint_test\nftrace:ftracetest-ktap\n'
    );
    expect(parseKselftestList(fs.readFileSync(listPath, 'utf-8'), 'ftrace')).toEqual([
      { target: 'ftrace', test: 'ftracetest-ktap' },
    ]);

    const tier2 = discoverTargetTests({
      kernelDir: ws,
      target: 'ftrace',
      kselftestListPath: listPath,
    });
    expect(tier2.map((i) => i.id)).toEqual([
      'ftrace:ftracetest-ktap',
      'ftrace:ftracetest:test.d/00basic/basic1.tc',
    ]);
  });

  it('diffs config and config.<arch> against active .config accurately', () => {
    const ws = makeTempDir();
    const targetDir = path.join(ws, 'tools', 'testing', 'selftests', 'ftrace');
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(
      path.join(targetDir, 'config'),
      [
        'CONFIG_FTRACE=y',
        'CONFIG_KPROBES=y',
        'CONFIG_SAMPLE_TRACE_EVENTS=m',
        '# CONFIG_DEBUG_LOCKDEP is not set',
      ].join('\n')
    );
    fs.writeFileSync(path.join(targetDir, 'config.x86_64'), 'CONFIG_OPTPROBES=y\n');

    const dotConfig = path.join(ws, '.config');
    fs.writeFileSync(
      dotConfig,
      [
        'CONFIG_FTRACE=y',
        '# CONFIG_KPROBES is not set',
        'CONFIG_SAMPLE_TRACE_EVENTS=y',
      ].join('\n')
    );

    const parsed = parseKconfigFile(fs.readFileSync(dotConfig, 'utf-8'));
    expect(parsed.get('FTRACE')).toBe('y');
    expect(parsed.get('KPROBES')).toBe('n');

    const check = checkTargetConfig({
      kernelDir: ws,
      target: 'ftrace',
      dotConfigPath: dotConfig,
      arch: 'x86_64',
    });

    expect(check.status).toBe('missing');
    expect(check.configPaths).toHaveLength(2);
    expect(check.missing.map((m) => [m.symbol, m.required, m.current])).toEqual([
      ['KPROBES', 'y', 'n'],
      ['OPTPROBES', 'y', 'n'],
      ['SAMPLE_TRACE_EVENTS', 'm', 'y'],
    ]);
  });

  it('filters unknown and non-tristate symbols before calling SAT solver', async () => {
    const symbolTable: Record<string, { type: string }> = {
      FTRACE: { type: 'bool' },
      SAMPLE_TRACE_EVENTS: { type: 'tristate' },
      LOG_BUF_SHIFT: { type: 'int' },
    };

    const result = await filterSolvableRequests(
      [
        { symbol: 'RESERVE_MEM', required: 'y', current: 'n', sourceFile: 'config' },
        { symbol: 'FTRACE', required: 'm', current: 'n', sourceFile: 'config' },
        { symbol: 'SAMPLE_TRACE_EVENTS', required: 'm', current: 'n', sourceFile: 'config' },
        { symbol: 'LOG_BUF_SHIFT', required: '18', current: '17', sourceFile: 'config' },
      ],
      async (sym) => symbolTable[sym] ?? null
    );

    expect(result.requests).toEqual([
      { symbol: 'FTRACE', value: 'y' },
      { symbol: 'SAMPLE_TRACE_EVENTS', value: 'm' },
    ]);
    expect(result.skipped.map((s) => s.symbol)).toEqual(['RESERVE_MEM', 'LOG_BUF_SHIFT']);
  });
});
