import { describe, expect, it } from 'vitest';
import {
  computeHistogram,
  computeStats,
  extractNumericFields,
  LatencySample,
} from '../../src/kprobe/traceAnalytics';
import { KprobeSpec, TraceEvent } from '../../src/kprobe/types';
import {
  buildLatencyHistogramOption,
  buildLatencyScatterOption,
  buildTimelineOption,
  buildValueSeriesOption,
  LARGE_DATASET_THRESHOLD,
} from '../../webview-ui/src/trace-plot/optionBuilders';

function makeEvent(
  index: number,
  probeId: string,
  timestamp: number,
  argsMap: Record<string, string> = {}
): TraceEvent {
  return {
    index,
    task: 'sh',
    pid: 100,
    cpu: index % 2,
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

const sampleProbes: KprobeSpec[] = [
  {
    id: 'p1',
    group: 'kdev',
    kind: 'kprobe',
    enabled: true,
    file: 'fs/open.c',
    line: 1420,
    vars: ['dfd', 'flags'],
    customExprs: [],
    definitions: [],
    vmlinuxMtimeMs: 0,
    status: 'valid',
  },
];

describe('Phase 3B ECharts Option Builders', () => {
  it('builds Timeline option with swimlanes, markPoint highlight, and empty state', () => {
    const emptyOpt = buildTimelineOption({
      events: [],
      probes: sampleProbes,
      laneMode: 'probe',
      relativeTime: true,
      t0: 0,
      selectedEventIndex: null,
    });
    expect((emptyOpt.title as any)?.text).toContain('No trace events');

    const events = [
      makeEvent(1, 'p1', 10.0, { dfd: '-100' }),
      makeEvent(2, 'p1', 10.5, { dfd: '3' }),
    ];
    const opt = buildTimelineOption({
      events,
      probes: sampleProbes,
      laneMode: 'probe',
      relativeTime: true,
      t0: 10.0,
      selectedEventIndex: 2,
    });
    expect(opt.animation).toBe(true);
    const series = opt.series as any[];
    expect(series).toHaveLength(1);
    expect(series[0].type).toBe('scatter');
    expect(series[0].data[1]).toEqual([0.5, 0, 2]);
    expect(series[0].markPoint.data[0].value).toBe('#2');
  });

  it('enables large mode and disables animation automatically above 2,000 points', () => {
    const bigEvents: TraceEvent[] = [];
    for (let i = 1; i <= LARGE_DATASET_THRESHOLD + 50; i += 1) {
      bigEvents.push(makeEvent(i, 'p1', 1.0 + i * 0.0001, { dfd: String(i) }));
    }
    const opt = buildTimelineOption({
      events: bigEvents,
      probes: sampleProbes,
      laneMode: 'cpu',
      relativeTime: true,
      t0: 1.0,
      selectedEventIndex: null,
    });
    expect(opt.animation).toBe(false);
    const series = opt.series as any[];
    expect(series[0].large).toBe(true);
    expect(series[0].largeThreshold).toBe(LARGE_DATASET_THRESHOLD);
  });

  it('builds Value Series option with hex formatting and selected highlight', () => {
    const events = [
      makeEvent(1, 'p1', 1.0, { flags: '0x8000' }),
      makeEvent(2, 'p1', 1.2, { flags: '0x8002' }),
    ];
    const fieldInfos = extractNumericFields(events);
    const opt = buildValueSeriesOption({
      events,
      selectedFields: [{ probeId: 'p1', field: 'flags' }],
      fieldInfos,
      chartType: 'line',
      logScale: false,
      formatAsHex: true,
      pointerOffsetFromMin: false,
      relativeTime: true,
      t0: 1.0,
      selectedEventIndex: 1,
    });

    const series = opt.series as any[];
    expect(series).toHaveLength(1);
    expect(series[0].type).toBe('line');
    expect(series[0].data[0]).toEqual([0, 0x8000, 1]);
    expect(series[0].data[1][0]).toBeCloseTo(0.2, 6);
    expect(series[0].data[1][1]).toBe(0x8002);
    expect(series[0].data[1][2]).toBe(2);
    expect(series[0].markPoint.data[0].value).toBe('#1');
    expect((opt.yAxis as any).axisLabel.formatter(0x8000)).toBe('0x8000');
  });

  it('builds Latency Scatter (with p50/p99 markLines) and Histogram options', () => {
    const samples: LatencySample[] = [
      {
        entryEventIndex: 1,
        exitEventIndex: 2,
        pid: 100,
        task: 'sh',
        cpu: 0,
        startTs: 1.0,
        endTs: 1.00001,
        durationUs: 10,
      },
      {
        entryEventIndex: 3,
        exitEventIndex: 4,
        pid: 100,
        task: 'sh',
        cpu: 0,
        startTs: 1.1,
        endTs: 1.10005,
        durationUs: 50,
      },
    ];
    const stats = computeStats(samples.map((s) => s.durationUs));

    const scatterOpt = buildLatencyScatterOption({
      samples,
      stats,
      logScale: false,
      relativeTime: true,
      t0: 1.0,
      selectedEventIndex: 3,
    });
    const scatterSeries = (scatterOpt.series as any[])[0];
    expect(scatterSeries.markLine.data).toHaveLength(2);
    expect(scatterSeries.markPoint.data[0].value).toBe('#3');

    const bins = computeHistogram(
      samples.map((s) => ({ value: s.durationUs, eventIndex: s.entryEventIndex })),
      { binCount: 4 }
    );
    const histOpt = buildLatencyHistogramOption({ bins });
    const barSeries = (histOpt.series as any[])[0];
    expect(barSeries.type).toBe('bar');
    expect(barSeries.data.reduce((acc: number, d: any) => acc + d.value, 0)).toBe(2);
  });
});
