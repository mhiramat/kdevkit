import type { EChartsCoreOption } from 'echarts/core';
import {
  HistogramBin,
  LatencySample,
  NumericFieldInfo,
  parseScalarValue,
  SummaryStats,
} from '../../../src/kprobe/traceAnalytics';
import { KprobeSpec, TraceEvent } from '../../../src/kprobe/types';
import { FALLBACK_THEME, TracePlotTheme } from './echartsSetup';

export type TimelineLaneMode = 'probe' | 'cpu' | 'task';

export const LARGE_DATASET_THRESHOLD = 2000;

function formatTs(ts: number, relative: boolean): string {
  return relative ? `+${ts.toFixed(6)}s` : `${ts.toFixed(6)}s`;
}

function formatHex(val: number): string {
  const n = Math.trunc(val);
  return n < 0 ? `-0x${Math.abs(n).toString(16)}` : `0x${n.toString(16)}`;
}

function baseCommonOption(
  theme: TracePlotTheme,
  pointCount: number
): Partial<EChartsCoreOption> {
  return {
    backgroundColor: 'transparent',
    color: theme.palette,
    animation: pointCount <= LARGE_DATASET_THRESHOLD,
    textStyle: { color: theme.textColor, fontSize: 12 },
    tooltip: {
      trigger: 'item',
      backgroundColor: theme.tooltipBg,
      borderColor: theme.tooltipBorder,
      textStyle: { color: theme.textColor, fontSize: 12 },
    },
    legend: {
      top: 4,
      textStyle: { color: theme.textColor },
    },
    grid: {
      left: 72,
      right: 24,
      top: 40,
      bottom: 64,
      containLabel: true,
    },
  };
}

function buildEmptyOption(theme: TracePlotTheme, message: string): EChartsCoreOption {
  return {
    backgroundColor: 'transparent',
    title: {
      text: message,
      left: 'center',
      top: 'middle',
      textStyle: {
        color: theme.mutedTextColor,
        fontSize: 13,
        fontWeight: 'normal',
      },
    },
  };
}

export interface TimelineOptionParams {
  events: TraceEvent[];
  probes: KprobeSpec[];
  laneMode: TimelineLaneMode;
  relativeTime: boolean;
  t0: number;
  selectedEventIndex: number | null;
  theme?: TracePlotTheme;
}

export function buildTimelineOption(params: TimelineOptionParams): EChartsCoreOption {
  const theme = params.theme ?? FALLBACK_THEME;
  const { events, probes, laneMode, relativeTime, t0, selectedEventIndex } = params;

  if (events.length === 0) {
    return buildEmptyOption(theme, 'No trace events to plot. Load trace.log or run QEMU with Kprobes.');
  }

  const probeLookup = new Map(probes.map((p) => [p.id, p]));
  const laneLabels: string[] = [];
  const laneIndexMap = new Map<string, number>();

  const getLaneLabel = (ev: TraceEvent): string => {
    if (laneMode === 'cpu') {
      return `CPU ${ev.cpu}`;
    }
    if (laneMode === 'task') {
      return `${ev.task}-${ev.pid}`;
    }
    const id = ev.probeId ?? ev.eventName;
    const spec = probeLookup.get(id);
    return spec ? `${id} (${spec.file}:${spec.line})` : id;
  };

  for (const ev of events) {
    const label = getLaneLabel(ev);
    if (!laneIndexMap.has(label)) {
      laneIndexMap.set(label, laneLabels.length);
      laneLabels.push(label);
    }
  }

  const byProbe = new Map<string, Array<[number, number, number]>>();
  let highlightedCoord: { probeKey: string; x: number; y: number } | null = null;

  for (const ev of events) {
    const probeKey = ev.probeId ?? ev.eventName;
    const x = relativeTime ? ev.timestamp - t0 : ev.timestamp;
    const y = laneIndexMap.get(getLaneLabel(ev)) ?? 0;

    let list = byProbe.get(probeKey);
    if (!list) {
      list = [];
      byProbe.set(probeKey, list);
    }
    list.push([x, y, ev.index]);

    if (selectedEventIndex !== null && ev.index === selectedEventIndex) {
      highlightedCoord = { probeKey, x, y };
    }
  }

  const isLarge = events.length > LARGE_DATASET_THRESHOLD;
  const eventByIndex = new Map(events.map((e) => [e.index, e]));

  const series = Array.from(byProbe.entries()).map(([probeKey, data]) => {
    const markPoint =
      highlightedCoord && highlightedCoord.probeKey === probeKey
        ? {
            symbol: 'pin',
            symbolSize: 36,
            data: [
              {
                name: 'Selected',
                coord: [highlightedCoord.x, highlightedCoord.y],
                value: `#${selectedEventIndex}`,
              },
            ],
          }
        : undefined;

    return {
      name: probeKey,
      type: 'scatter',
      symbolSize: isLarge ? 5 : 8,
      large: isLarge,
      largeThreshold: LARGE_DATASET_THRESHOLD,
      data,
      markPoint,
    };
  });

  return {
    ...baseCommonOption(theme, events.length),
    tooltip: {
      trigger: 'item',
      backgroundColor: theme.tooltipBg,
      borderColor: theme.tooltipBorder,
      textStyle: { color: theme.textColor, fontSize: 12 },
      formatter: (p: any) => {
        const idx = Array.isArray(p.value) ? p.value[2] : undefined;
        const ev = typeof idx === 'number' ? eventByIndex.get(idx) : undefined;
        if (!ev) {
          return '';
        }
        const xVal = relativeTime ? ev.timestamp - t0 : ev.timestamp;
        return [
          `<b>#${ev.index} ${ev.probeId ?? ev.eventName}</b>`,
          `Time: ${formatTs(xVal, relativeTime)}`,
          `Task: ${ev.task}-${ev.pid} (CPU ${ev.cpu})`,
          ev.argsText ? `Args: ${ev.argsText}` : `Symbol: ${ev.symbol}`,
        ].join('<br/>');
      },
    },
    xAxis: {
      type: 'value',
      name: relativeTime ? 'Time (t - t0, s)' : 'Timestamp (s)',
      nameLocation: 'middle',
      nameGap: 26,
      axisLabel: { color: theme.textColor },
      axisLine: { lineStyle: { color: theme.borderColor } },
      splitLine: { lineStyle: { color: theme.borderColor, opacity: 0.4 } },
    },
    yAxis: {
      type: 'category',
      data: laneLabels,
      axisLabel: { color: theme.textColor },
      axisLine: { lineStyle: { color: theme.borderColor } },
      splitLine: { show: true, lineStyle: { color: theme.borderColor, opacity: 0.3 } },
    },
    dataZoom: [
      { type: 'inside', xAxisIndex: 0 },
      { type: 'slider', xAxisIndex: 0, height: 22, bottom: 8 },
    ],
    series,
  };
}

export interface ValueSeriesOptionParams {
  events: TraceEvent[];
  selectedFields: Array<{ probeId: string; field: string }>;
  fieldInfos: NumericFieldInfo[];
  chartType: 'line' | 'scatter';
  logScale: boolean;
  formatAsHex: boolean;
  pointerOffsetFromMin: boolean;
  relativeTime: boolean;
  t0: number;
  selectedEventIndex: number | null;
  theme?: TracePlotTheme;
}

export function buildValueSeriesOption(params: ValueSeriesOptionParams): EChartsCoreOption {
  const theme = params.theme ?? FALLBACK_THEME;
  const {
    events,
    selectedFields,
    fieldInfos,
    chartType,
    logScale,
    formatAsHex,
    pointerOffsetFromMin,
    relativeTime,
    t0,
    selectedEventIndex,
  } = params;

  if (events.length === 0 || selectedFields.length === 0) {
    return buildEmptyOption(
      theme,
      selectedFields.length === 0
        ? 'Select one or more numeric fields above to plot values over time.'
        : 'No trace events to plot.'
    );
  }

  const infoMap = new Map(fieldInfos.map((f) => [`${f.probeId}.${f.field}`, f]));
  let totalPoints = 0;

  const series = selectedFields.map(({ probeId, field }) => {
    const seriesName = `${probeId}.${field}`;
    const info = infoMap.get(seriesName);
    const data: Array<[number, number, number]> = [];
    let minBig: bigint | null = null;
    const rawItems: Array<{ x: number; parsedVal: number; big?: bigint; idx: number }> = [];

    for (const ev of events) {
      const id = ev.probeId ?? ev.eventName;
      if (id !== probeId) {
        continue;
      }
      const raw = ev.argsMap[field];
      if (raw === undefined) {
        continue;
      }
      const parsed = parseScalarValue(raw);
      if (!parsed) {
        continue;
      }
      const x = relativeTime ? ev.timestamp - t0 : ev.timestamp;
      if (parsed.bigIntValue !== undefined) {
        if (minBig === null || parsed.bigIntValue < minBig) {
          minBig = parsed.bigIntValue;
        }
      }
      rawItems.push({ x, parsedVal: parsed.value, big: parsed.bigIntValue, idx: ev.index });
    }

    let highlightPoint: [number, number] | null = null;
    for (const item of rawItems) {
      let y = item.parsedVal;
      if (pointerOffsetFromMin && info?.isPointer64 && minBig !== null && item.big !== undefined) {
        y = Number(item.big - minBig);
      }
      if (logScale && y <= 0) {
        continue;
      }
      data.push([item.x, y, item.idx]);
      if (selectedEventIndex !== null && item.idx === selectedEventIndex) {
        highlightPoint = [item.x, y];
      }
    }

    totalPoints += data.length;
    const isLarge = data.length > LARGE_DATASET_THRESHOLD;

    return {
      name: seriesName,
      type: chartType,
      showSymbol: true,
      symbolSize: isLarge ? 4 : 7,
      large: isLarge,
      largeThreshold: LARGE_DATASET_THRESHOLD,
      data,
      markPoint: highlightPoint
        ? {
            symbol: 'pin',
            symbolSize: 34,
            data: [{ name: 'Selected', coord: highlightPoint, value: `#${selectedEventIndex}` }],
          }
        : undefined,
    };
  });

  return {
    ...baseCommonOption(theme, totalPoints),
    tooltip: {
      trigger: 'item',
      backgroundColor: theme.tooltipBg,
      borderColor: theme.tooltipBorder,
      textStyle: { color: theme.textColor, fontSize: 12 },
      formatter: (p: any) => {
        if (!Array.isArray(p.value)) {
          return '';
        }
        const [x, y, idx] = p.value as [number, number, number];
        const yText = formatAsHex ? formatHex(y) : String(y);
        return [
          `<b>${p.seriesName} (#${idx})</b>`,
          `Time: ${formatTs(x, relativeTime)}`,
          `Value: ${yText}`,
        ].join('<br/>');
      },
    },
    xAxis: {
      type: 'value',
      name: relativeTime ? 'Time (t - t0, s)' : 'Timestamp (s)',
      nameLocation: 'middle',
      nameGap: 26,
      axisLabel: { color: theme.textColor },
      axisLine: { lineStyle: { color: theme.borderColor } },
      splitLine: { lineStyle: { color: theme.borderColor, opacity: 0.4 } },
    },
    yAxis: {
      type: logScale ? 'log' : 'value',
      name: pointerOffsetFromMin ? 'Offset' : 'Value',
      axisLabel: {
        color: theme.textColor,
        formatter: (v: number) => (formatAsHex ? formatHex(v) : String(v)),
      },
      axisLine: { lineStyle: { color: theme.borderColor } },
      splitLine: { lineStyle: { color: theme.borderColor, opacity: 0.4 } },
    },
    dataZoom: [
      { type: 'inside', xAxisIndex: 0 },
      { type: 'slider', xAxisIndex: 0, height: 22, bottom: 8 },
    ],
    series,
  };
}

export interface LatencyScatterOptionParams {
  samples: LatencySample[];
  stats: SummaryStats;
  logScale: boolean;
  relativeTime: boolean;
  t0: number;
  selectedEventIndex: number | null;
  seriesName?: string;
  theme?: TracePlotTheme;
}

export function buildLatencyScatterOption(
  params: LatencyScatterOptionParams
): EChartsCoreOption {
  const theme = params.theme ?? FALLBACK_THEME;
  const {
    samples,
    stats,
    logScale,
    relativeTime,
    t0,
    selectedEventIndex,
    seriesName = 'Duration (µs)',
  } = params;

  if (samples.length === 0) {
    return buildEmptyOption(theme, 'No latency samples available for the selected probes.');
  }

  const data: Array<[number, number, number]> = [];
  let highlightCoord: [number, number] | null = null;
  const sampleByEntryIdx = new Map<number, LatencySample>();

  for (const s of samples) {
    if (logScale && s.durationUs <= 0) {
      continue;
    }
    const x = relativeTime ? s.startTs - t0 : s.startTs;
    data.push([x, s.durationUs, s.entryEventIndex]);
    sampleByEntryIdx.set(s.entryEventIndex, s);

    if (
      selectedEventIndex !== null &&
      (s.entryEventIndex === selectedEventIndex || s.exitEventIndex === selectedEventIndex)
    ) {
      highlightCoord = [x, s.durationUs];
    }
  }

  const isLarge = data.length > LARGE_DATASET_THRESHOLD;
  const markLineData: Array<{ yAxis: number; name: string }> = [];
  if (stats.count > 0 && (!logScale || stats.p50 > 0)) {
    markLineData.push({ yAxis: stats.p50, name: `p50 (${stats.p50.toFixed(1)}µs)` });
  }
  if (stats.count > 0 && (!logScale || stats.p99 > 0)) {
    markLineData.push({ yAxis: stats.p99, name: `p99 (${stats.p99.toFixed(1)}µs)` });
  }

  return {
    ...baseCommonOption(theme, data.length),
    tooltip: {
      trigger: 'item',
      backgroundColor: theme.tooltipBg,
      borderColor: theme.tooltipBorder,
      textStyle: { color: theme.textColor, fontSize: 12 },
      formatter: (p: any) => {
        if (!Array.isArray(p.value)) {
          return '';
        }
        const [x, dur, idx] = p.value as [number, number, number];
        const s = sampleByEntryIdx.get(idx);
        return [
          `<b>Duration: ${dur.toFixed(2)} µs</b>`,
          `Start: ${formatTs(x, relativeTime)}`,
          s ? `Task: ${s.task}-${s.pid} (CPU ${s.cpu})` : '',
          s?.retval ? `Retval: ${s.retval}` : '',
          s ? `Events: #${s.entryEventIndex} → #${s.exitEventIndex}` : '',
        ]
          .filter(Boolean)
          .join('<br/>');
      },
    },
    xAxis: {
      type: 'value',
      name: relativeTime ? 'Start Time (t - t0, s)' : 'Start Timestamp (s)',
      nameLocation: 'middle',
      nameGap: 26,
      axisLabel: { color: theme.textColor },
      axisLine: { lineStyle: { color: theme.borderColor } },
      splitLine: { lineStyle: { color: theme.borderColor, opacity: 0.4 } },
    },
    yAxis: {
      type: logScale ? 'log' : 'value',
      name: 'Duration (µs)',
      axisLabel: { color: theme.textColor },
      axisLine: { lineStyle: { color: theme.borderColor } },
      splitLine: { lineStyle: { color: theme.borderColor, opacity: 0.4 } },
    },
    dataZoom: [
      { type: 'inside', xAxisIndex: 0 },
      { type: 'slider', xAxisIndex: 0, height: 22, bottom: 8 },
    ],
    series: [
      {
        name: seriesName,
        type: 'scatter',
        symbolSize: isLarge ? 5 : 8,
        large: isLarge,
        largeThreshold: LARGE_DATASET_THRESHOLD,
        data,
        markLine:
          markLineData.length > 0
            ? {
                symbol: 'none',
                silent: true,
                lineStyle: { type: 'dashed' },
                label: { formatter: '{b}', color: theme.textColor },
                data: markLineData,
              }
            : undefined,
        markPoint: highlightCoord
          ? {
              symbol: 'pin',
              symbolSize: 34,
              data: [{ name: 'Selected', coord: highlightCoord, value: `#${selectedEventIndex}` }],
            }
          : undefined,
      },
    ],
  };
}

export interface LatencyHistogramOptionParams {
  bins: HistogramBin[];
  theme?: TracePlotTheme;
}

export function buildLatencyHistogramOption(
  params: LatencyHistogramOptionParams
): EChartsCoreOption {
  const theme = params.theme ?? FALLBACK_THEME;
  const { bins } = params;

  if (bins.length === 0) {
    return buildEmptyOption(theme, 'No latency samples to bin.');
  }

  return {
    ...baseCommonOption(theme, bins.length),
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      backgroundColor: theme.tooltipBg,
      borderColor: theme.tooltipBorder,
      textStyle: { color: theme.textColor, fontSize: 12 },
      formatter: (items: any) => {
        const first = Array.isArray(items) ? items[0] : items;
        if (!first) {
          return '';
        }
        return `<b>${first.name}</b><br/>Count: ${first.value}<br/><i>Click bar to jump to sample</i>`;
      },
    },
    xAxis: {
      type: 'category',
      data: bins.map((b) => b.label),
      axisLabel: { color: theme.textColor, rotate: 30 },
      axisLine: { lineStyle: { color: theme.borderColor } },
    },
    yAxis: {
      type: 'value',
      name: 'Count',
      axisLabel: { color: theme.textColor },
      axisLine: { lineStyle: { color: theme.borderColor } },
      splitLine: { lineStyle: { color: theme.borderColor, opacity: 0.4 } },
    },
    series: [
      {
        name: 'Latency Distribution',
        type: 'bar',
        data: bins.map((b) => ({
          value: b.count,
          eventIndices: b.sampleEventIndices,
        })),
      },
    ],
  };
}
