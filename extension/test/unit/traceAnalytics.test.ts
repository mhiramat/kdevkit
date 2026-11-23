import { describe, expect, it } from 'vitest';
import {
  computeHistogram,
  computeInterArrival,
  computePairedLatency,
  computeStats,
  extractNumericFields,
  parseScalarValue,
  suggestLatencyPairs,
} from '../../src/kprobe/traceAnalytics';
import { KprobeSpec, TraceEvent } from '../../src/kprobe/types';

function makeEvent(
  index: number,
  probeId: string,
  pid: number,
  timestamp: number,
  argsMap: Record<string, string> = {},
  cpu = 0
): TraceEvent {
  return {
    index,
    task: 'sh',
    pid,
    cpu,
    flags: '....',
    timestamp,
    eventName: probeId,
    probeId,
    symbol: 'do_sys_openat2+0x0',
    argsText: Object.entries(argsMap)
      .map(([k, v]) => `${k}=${v}`)
      .join(' '),
    argsMap,
  };
}

describe('Phase 3B Trace Analytics Engine', () => {
  it('parses decimal, signed/unsigned hex, and 64-bit pointers while ignoring strings', () => {
    expect(parseScalarValue('42')).toEqual({
      value: 42,
      isHex: false,
      isPointer64: false,
    });
    expect(parseScalarValue('-12.5')).toEqual({
      value: -12.5,
      isHex: false,
      isPointer64: false,
    });
    expect(parseScalarValue('0x8000')).toMatchObject({
      value: 0x8000,
      isHex: true,
      isPointer64: false,
    });
    expect(parseScalarValue('-0x16')).toMatchObject({
      value: -0x16,
      isHex: true,
      isPointer64: false,
    });
    expect(parseScalarValue('0xffffffff81001234')).toMatchObject({
      isHex: true,
      isPointer64: true,
    });
    expect(parseScalarValue('"/etc/passwd"')).toBeNull();
    expect(parseScalarValue('not_a_number')).toBeNull();
  });

  it('extracts numeric fields grouped by probeId', () => {
    const events = [
      makeEvent(1, 'p1', 100, 1.0, {
        dfd: '-100',
        flags: '0x8000',
        ptr: '0xffff888001234000',
        filename: '"/etc/hosts"',
      }),
      makeEvent(2, 'p1', 100, 1.1, {
        dfd: '3',
        flags: '0x8002',
        ptr: '0xffff888001234080',
        filename: '"/etc/passwd"',
      }),
    ];

    const fields = extractNumericFields(events);
    expect(fields.map((f) => f.field)).toEqual(['dfd', 'flags', 'ptr']);
    expect(fields.find((f) => f.field === 'dfd')).toMatchObject({
      min: -100,
      max: 3,
      isHex: false,
      isPointer64: false,
    });
    expect(fields.find((f) => f.field === 'flags')).toMatchObject({
      min: 0x8000,
      max: 0x8002,
      isHex: true,
      isPointer64: false,
    });
    expect(fields.find((f) => f.field === 'ptr')).toMatchObject({
      isHex: true,
      isPointer64: true,
    });
  });

  it('pairs nested/recursive kprobe->kretprobe stacks per PID and tracks unmatched boundaries', () => {
    const events = [
      // Unmatched exit at start of buffer
      makeEvent(1, 'p2', 42, 1.000000, { arg1: '0x0' }),
      // Outer entry PID 42
      makeEvent(2, 'p1', 42, 1.000100),
      // Nested entry PID 42
      makeEvent(3, 'p1', 42, 1.000150),
      // Concurrent entry PID 99 (unmatched at end)
      makeEvent(4, 'p1', 99, 1.000160),
      // Inner exit PID 42 -> 50 us
      makeEvent(5, 'p2', 42, 1.000200, { arg1: '0x3' }),
      // Outer exit PID 42 -> 300 us
      makeEvent(6, 'p2', 42, 1.000400, { arg1: '0x4' }),
    ];

    const res = computePairedLatency(events, 'p1', 'p2');
    expect(res.unmatchedExits).toBe(1);
    expect(res.unmatchedEntries).toBe(1);
    expect(res.samples).toHaveLength(2);
    expect(res.samples[0].entryEventIndex).toBe(3);
    expect(res.samples[0].exitEventIndex).toBe(5);
    expect(res.samples[0].durationUs).toBeCloseTo(50, 3);
    expect(res.samples[0].retval).toBe('0x3');
    expect(res.samples[1].entryEventIndex).toBe(2);
    expect(res.samples[1].exitEventIndex).toBe(6);
    expect(res.samples[1].durationUs).toBeCloseTo(300, 3);
  });

  it('suggests latency pairs and computes inter-arrival deltas', () => {
    const probes: KprobeSpec[] = [
      {
        id: 'p1',
        group: 'kdev',
        kind: 'kprobe',
        enabled: true,
        file: 'fs/open.c',
        line: 1420,
        vars: ['dfd'],
        customExprs: [],
        definitions: [],
        vmlinuxMtimeMs: 0,
        status: 'valid',
      },
      {
        id: 'p2',
        group: 'kdev',
        kind: 'kretprobe',
        enabled: true,
        file: 'fs/open.c',
        line: 1420,
        funcName: 'do_sys_openat2',
        vars: [],
        customExprs: ['$retval'],
        definitions: [],
        vmlinuxMtimeMs: 0,
        status: 'valid',
      },
    ];
    expect(suggestLatencyPairs(probes)).toHaveLength(1);

    const events = [
      makeEvent(1, 'p1', 10, 1.000000, {}, 0),
      makeEvent(2, 'p1', 20, 1.000100, {}, 1),
      makeEvent(3, 'p1', 10, 1.000250, {}, 0),
    ];

    const globalDeltas = computeInterArrival(events, 'p1', 'global');
    expect(globalDeltas.map((s) => Math.round(s.durationUs))).toEqual([100, 150]);

    const perPidDeltas = computeInterArrival(events, 'p1', 'per-pid');
    expect(perPidDeltas.map((s) => Math.round(s.durationUs))).toEqual([250]);
  });

  it('computes accurate percentiles and linear/log10 histograms with index preservation', () => {
    const vals = Array.from({ length: 101 }, (_, i) => i); // 0..100
    const stats = computeStats(vals);
    expect(stats).toEqual({
      count: 101,
      min: 0,
      max: 100,
      mean: 50,
      p50: 50,
      p95: 95,
      p99: 99,
    });

    const samples = [
      { value: 1, eventIndex: 10 },
      { value: 10, eventIndex: 20 },
      { value: 100, eventIndex: 30 },
      { value: 1000, eventIndex: 40 },
    ];

    const linear = computeHistogram(samples, { binCount: 10, logScale: false });
    expect(linear).toHaveLength(10);
    expect(linear.reduce((sum, b) => sum + b.count, 0)).toBe(4);
    expect(linear.flatMap((b) => b.sampleEventIndices).sort()).toEqual([10, 20, 30, 40]);

    const logBins = computeHistogram(samples, { binCount: 3, logScale: true });
    expect(logBins).toHaveLength(3);
    expect(logBins.reduce((sum, b) => sum + b.count, 0)).toBe(4);
    expect(logBins.flatMap((b) => b.sampleEventIndices).sort()).toEqual([10, 20, 30, 40]);
  });
});
