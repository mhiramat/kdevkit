import { describe, expect, it } from 'vitest';
import { KDEV_SELFTEST_BEGIN, KtapStreamParser } from '../../src/selftest/ktapParser';

describe('Streaming KTAP v1 Parser', () => {
  it('isolates KTAP output between begin/end sentinels and handles chunked delivery', () => {
    const parser = new KtapStreamParser();

    const rawStream = [
      '[    0.000000] Linux version 6.12.0',
      'ok 99 noise_before_sentinel',
      KDEV_SELFTEST_BEGIN,
      'TAP version 13',
      '1..3',
      '# selftests: breakpoints: breakpoint_test',
      '    # Starting subtests',
      '    ok 1 hardware watchpoint',
      '    ok 2 step test # SKIP not supported in TCG',
      'ok 1 selftests: breakpoints: breakpoint_test',
      'ok 2 selftests: ftrace: expected_fail # XFAIL known limitation',
      'not ok 3 selftests: ftrace: slow_case # TIMEOUT 120 seconds',
      '=== KDEV_SELFTEST_END rc=1 ===',
      'not ok 100 noise_after_sentinel',
    ].join('\n');

    // Feed in arbitrary small chunks to test line buffering
    const events = [];
    for (let i = 0; i < rawStream.length; i += 17) {
      events.push(...parser.feedChunk(rawStream.slice(i, i + 17)));
    }
    events.push(...parser.flush());

    expect(events.find((e) => e.type === 'begin')).toBeTruthy();
    expect(events.find((e) => e.type === 'end')).toMatchObject({ type: 'end', exitCode: 1 });

    const suiteStarts = events.filter((e) => e.type === 'suiteStart');
    expect(suiteStarts).toHaveLength(1);
    expect(suiteStarts[0]).toMatchObject({
      target: 'breakpoints',
      test: 'breakpoint_test',
    });

    const subtests = events.filter((e) => e.type === 'subtestResult');
    expect(subtests).toHaveLength(2);
    expect(subtests[0]).toMatchObject({
      depth: 1,
      index: 1,
      status: 'pass',
      description: 'hardware watchpoint',
    });
    expect(subtests[1]).toMatchObject({
      depth: 1,
      index: 2,
      status: 'skip',
      description: 'step test',
      reason: 'not supported in TCG',
    });

    const topResults = events.filter((e) => e.type === 'testResult');
    expect(topResults).toHaveLength(3);
    expect(topResults[0]).toMatchObject({
      index: 1,
      status: 'pass',
      target: 'breakpoints',
      test: 'breakpoint_test',
    });
    expect(topResults[1]).toMatchObject({
      index: 2,
      status: 'xfail',
      reason: 'known limitation',
    });
    expect(topResults[2]).toMatchObject({
      index: 3,
      status: 'timeout',
      reason: '120 seconds',
    });
  });

  it('detects kernel Oops/BUG/Kernel panic crashes even during test execution', () => {
    const parser = new KtapStreamParser();
    const lines = [
      KDEV_SELFTEST_BEGIN,
      '# selftests: ftrace: ftracetest-ktap',
      '[    2.114500] BUG: kernel NULL pointer dereference, address: 0000000000000008',
      '[    2.114900] Call Trace:',
      '[    2.115100]  <TASK>',
    ];

    const events = lines.flatMap((l) => parser.feedLine(l));
    const crashes = events.filter((e) => e.type === 'kernelCrash');
    expect(crashes).toHaveLength(1);
    expect(crashes[0]).toMatchObject({
      type: 'kernelCrash',
      line: expect.stringContaining('BUG: kernel NULL pointer dereference'),
    });
  });

  it('parses #-prefixed runner.sh subtests and UNRESOLVED directives with diagnostics', () => {
    const parser = new KtapStreamParser();
    const lines = [
      KDEV_SELFTEST_BEGIN,
      'TAP version 13',
      '1..1',
      '# selftests: ftrace: ftracetest-ktap',
      '# TAP version 13',
      '# 1..3',
      '# ok 1 Basic trace file check',
      '# Missing required tool: ping',
      '# not ok 2 Ping trace test # UNRESOLVED',
      '# ok 3 Optional feature # SKIP',
      'ok 1 selftests: ftrace: ftracetest-ktap',
      '=== KDEV_SELFTEST_END rc=0 ===',
    ];

    const events = lines.flatMap((l) => parser.feedLine(l));
    const subtests = events.filter((e) => e.type === 'subtestResult');
    expect(subtests).toHaveLength(3);
    expect(subtests[0]).toMatchObject({
      index: 1,
      status: 'pass',
      description: 'Basic trace file check',
    });
    expect(subtests[1]).toMatchObject({
      index: 2,
      status: 'unresolved',
      description: 'Ping trace test',
      diagnostics: ['Missing required tool: ping'],
    });
    expect(subtests[2]).toMatchObject({
      index: 3,
      status: 'skip',
      description: 'Optional feature',
    });
  });
});
