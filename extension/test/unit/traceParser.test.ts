import { describe, expect, it } from 'vitest';
import { parseArgsMap, parseTraceLog } from '../../src/kprobe/traceParser';
import { KprobeSpec } from '../../src/kprobe/types';

const SAMPLE_PROBES: KprobeSpec[] = [
  {
    id: 'p1',
    group: 'kdev',
    kind: 'kprobe',
    enabled: true,
    file: 'fs/open.c',
    line: 1438,
    vars: ['dfd', 'flags'],
    customExprs: [],
    definitions: ['p:kdev/p1 do_sys_openat2+0x14 dfd=%di:s32 flags=%si:s32'],
    vmlinuxMtimeMs: 1000,
    status: 'valid',
  },
  {
    id: 'p2',
    group: 'kdev',
    kind: 'kretprobe',
    enabled: true,
    file: 'fs/open.c',
    line: 1434,
    funcName: 'do_sys_openat2',
    vars: [],
    customExprs: ['$retval'],
    definitions: ['r:kdev/p2__return do_sys_openat2+0 $retval'],
    vmlinuxMtimeMs: 1000,
    status: 'valid',
  },
];

describe('traceParser', () => {
  it('parses scalar and quoted string key=value pairs', () => {
    expect(parseArgsMap('dfd=0x3 flags=0x8000 name="/etc/passwd" msg="a \\"b\\" c"')).toEqual({
      dfd: '0x3',
      flags: '0x8000',
      name: '"/etc/passwd"',
      msg: '"a \\"b\\" c"',
    });
  });

  it('parses standard kprobes, kretprobes, hyphenated/spaced tasks, inline suffixes, and skips comments', () => {
    const log = [
      '# tracer: nop',
      '#',
      '# entries-in-buffer/entries-written: 4/4   #P:2',
      '          sh-142     [000] d..2.    12.345678: p1: (do_sys_openat2+0x14/0x100) dfd=0x3 flags=0x8000',
      '  kworker/u4:1-42    [001] ...1.    12.345690: p1_1: (do_sys_openat2+0x14/0x100) dfd=0xffffff9c name="/etc/passwd"',
      '     my task-99      [000] d..2.    12.345701: p2__return: (do_sys_openat2+0x0/0x100 <- __x64_sys_openat+0x56/0xa0) arg1=0x3',
      '  rcu_preempt-14     [001] dN.1.    12.345800: unknown_ev: (some_func+0x0/0x20) x=1',
    ].join('\n');

    const res = parseTraceLog(log, SAMPLE_PROBES, 100);
    expect(res.truncated).toBe(false);
    expect(res.totalMatched).toBe(4);
    expect(res.events).toHaveLength(4);

    expect(res.events[0]).toMatchObject({
      index: 1,
      task: 'sh',
      pid: 142,
      cpu: 0,
      flags: 'd..2.',
      timestamp: 12.345678,
      eventName: 'p1',
      probeId: 'p1',
      symbol: 'do_sys_openat2+0x14/0x100',
      argsMap: { dfd: '0x3', flags: '0x8000' },
    });

    expect(res.events[1]).toMatchObject({
      index: 2,
      task: 'kworker/u4:1',
      pid: 42,
      cpu: 1,
      eventName: 'p1_1',
      probeId: 'p1',
      argsMap: { dfd: '0xffffff9c', name: '"/etc/passwd"' },
    });

    expect(res.events[2]).toMatchObject({
      index: 3,
      task: 'my task',
      pid: 99,
      eventName: 'p2__return',
      probeId: 'p2',
      symbol: 'do_sys_openat2+0x0/0x100 <- __x64_sys_openat+0x56/0xa0',
      argsMap: { arg1: '0x3' },
    });

    expect(res.events[3].probeId).toBeUndefined();
  });

  it('enforces maxEvents truncation limit and reports totalMatched', () => {
    const lines: string[] = [];
    for (let i = 0; i < 15; i += 1) {
      lines.push(
        `          sh-142     [000] d..2.    12.${String(i).padStart(6, '0')}: p1: (do_sys_openat2+0x14/0x100) dfd=${i}`
      );
    }

    const res = parseTraceLog(lines.join('\n'), SAMPLE_PROBES, 5);
    expect(res.truncated).toBe(true);
    expect(res.totalMatched).toBe(15);
    expect(res.events).toHaveLength(5);
    expect(res.events[0].index).toBe(1);
    expect(res.events[4].index).toBe(5);
  });
});
