import { KprobeSpec, TraceEvent } from './types';

export interface ParsedScalar {
  value: number;
  bigIntValue?: bigint;
  isHex: boolean;
  isPointer64: boolean;
}

export interface NumericFieldInfo {
  probeId: string;
  field: string;
  sampleCount: number;
  isHex: boolean;
  isPointer64: boolean;
  min: number;
  max: number;
}

export interface LatencySample {
  entryEventIndex: number;
  exitEventIndex: number;
  pid: number;
  task: string;
  cpu: number;
  startTs: number;
  endTs: number;
  durationUs: number;
  retval?: string;
}

export interface PairedLatencyResult {
  samples: LatencySample[];
  unmatchedEntries: number;
  unmatchedExits: number;
}

export interface SuggestedLatencyPair {
  entryProbeId: string;
  exitProbeId: string;
  label: string;
}

export type InterArrivalGrouping = 'global' | 'per-pid' | 'per-cpu';

export interface SummaryStats {
  count: number;
  min: number;
  max: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
}

export interface HistogramBin {
  label: string;
  min: number;
  max: number;
  count: number;
  sampleEventIndices: number[];
}

const HEX_RE = /^(-?)0x([0-9a-fA-F]+)$/;
const DEC_RE = /^-?\d+(?:\.\d+)?$/;

/**
 * Parse a scalar numeric/hex string from `TraceEvent.argsMap`.
 * Returns `null` for non-numeric or quoted string values.
 */
export function parseScalarValue(raw: string): ParsedScalar | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.startsWith('"') || trimmed.startsWith("'")) {
    return null;
  }

  const hexMatch = trimmed.match(HEX_RE);
  if (hexMatch) {
    const neg = hexMatch[1] === '-';
    const digits = hexMatch[2];
    const absBig = BigInt(`0x${digits}`);
    const bigIntValue = neg ? -absBig : absBig;
    const isPointer64 = digits.length > 8 || absBig > 0xffffffffn;
    return {
      value: Number(bigIntValue),
      bigIntValue,
      isHex: true,
      isPointer64,
    };
  }

  if (DEC_RE.test(trimmed)) {
    const num = Number(trimmed);
    if (!Number.isFinite(num)) {
      return null;
    }
    return {
      value: num,
      isHex: false,
      isPointer64: false,
    };
  }

  return null;
}

/**
 * Scan `events[].argsMap` grouped by `probeId` and discover plottable numeric/hex fields.
 */
export function extractNumericFields(events: TraceEvent[]): NumericFieldInfo[] {
  const acc = new Map<
    string,
    {
      probeId: string;
      field: string;
      sampleCount: number;
      hexCount: number;
      pointer64Count: number;
      min: number;
      max: number;
    }
  >();

  for (const ev of events) {
    const probeKey = ev.probeId ?? ev.eventName;
    for (const [field, rawVal] of Object.entries(ev.argsMap)) {
      const parsed = parseScalarValue(rawVal);
      if (!parsed) {
        continue;
      }
      const key = `${probeKey}\0${field}`;
      let entry = acc.get(key);
      if (!entry) {
        entry = {
          probeId: probeKey,
          field,
          sampleCount: 0,
          hexCount: 0,
          pointer64Count: 0,
          min: parsed.value,
          max: parsed.value,
        };
        acc.set(key, entry);
      }
      entry.sampleCount += 1;
      if (parsed.isHex) {
        entry.hexCount += 1;
      }
      if (parsed.isPointer64) {
        entry.pointer64Count += 1;
      }
      if (parsed.value < entry.min) {
        entry.min = parsed.value;
      }
      if (parsed.value > entry.max) {
        entry.max = parsed.value;
      }
    }
  }

  const results: NumericFieldInfo[] = [];
  for (const entry of acc.values()) {
    results.push({
      probeId: entry.probeId,
      field: entry.field,
      sampleCount: entry.sampleCount,
      isHex: entry.hexCount > 0,
      isPointer64: entry.pointer64Count > 0,
      min: entry.min,
      max: entry.max,
    });
  }

  results.sort((a, b) =>
    a.probeId === b.probeId
      ? a.field.localeCompare(b.field)
      : a.probeId.localeCompare(b.probeId)
  );
  return results;
}

/**
 * Pair entry `kprobe` and exit `kretprobe` events per PID using a LIFO call stack
 * to support nested/recursive kernel calls accurately.
 */
export function computePairedLatency(
  events: TraceEvent[],
  entryProbeId: string,
  exitProbeId: string
): PairedLatencyResult {
  const stacks = new Map<number, TraceEvent[]>();
  const samples: LatencySample[] = [];
  let unmatchedExits = 0;

  for (const ev of events) {
    const id = ev.probeId ?? ev.eventName;
    if (id === entryProbeId) {
      let stack = stacks.get(ev.pid);
      if (!stack) {
        stack = [];
        stacks.set(ev.pid, stack);
      }
      stack.push(ev);
    } else if (id === exitProbeId) {
      const stack = stacks.get(ev.pid);
      if (!stack || stack.length === 0) {
        unmatchedExits += 1;
        continue;
      }
      const entry = stack.pop()!;
      if (ev.timestamp < entry.timestamp) {
        unmatchedExits += 1;
        continue;
      }
      const retval =
        ev.argsMap.arg1 ?? ev.argsMap.retval ?? ev.argsMap.$retval ?? undefined;
      samples.push({
        entryEventIndex: entry.index,
        exitEventIndex: ev.index,
        pid: ev.pid,
        task: ev.task,
        cpu: ev.cpu,
        startTs: entry.timestamp,
        endTs: ev.timestamp,
        durationUs: (ev.timestamp - entry.timestamp) * 1e6,
        retval,
      });
    }
  }

  let unmatchedEntries = 0;
  for (const stack of stacks.values()) {
    unmatchedEntries += stack.length;
  }

  return {
    samples,
    unmatchedEntries,
    unmatchedExits,
  };
}

/**
 * Automatically suggest `(entry, exit)` pairs from configured `kprobe` and `kretprobe` specs.
 */
export function suggestLatencyPairs(probes: KprobeSpec[]): SuggestedLatencyPair[] {
  const entries = probes.filter((p) => p.kind === 'kprobe');
  const exits = probes.filter((p) => p.kind === 'kretprobe');
  const suggestions: SuggestedLatencyPair[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    for (const exit of exits) {
      const sameFunc =
        entry.funcName && exit.funcName && entry.funcName === exit.funcName;
      const sameFile = entry.file === exit.file;
      if (sameFunc || sameFile) {
        const key = `${entry.id}->${exit.id}`;
        if (!seen.has(key)) {
          seen.add(key);
          suggestions.push({
            entryProbeId: entry.id,
            exitProbeId: exit.id,
            label: `${entry.id} -> ${exit.id} (${exit.funcName || entry.file})`,
          });
        }
      }
    }
  }

  if (suggestions.length === 0 && entries.length === 1 && exits.length === 1) {
    suggestions.push({
      entryProbeId: entries[0].id,
      exitProbeId: exits[0].id,
      label: `${entries[0].id} -> ${exits[0].id}`,
    });
  }

  return suggestions;
}

/**
 * Compute inter-arrival time deltas (in microseconds) for a single probe.
 */
export function computeInterArrival(
  events: TraceEvent[],
  probeId: string,
  grouping: InterArrivalGrouping = 'global'
): LatencySample[] {
  const prevByKey = new Map<string, TraceEvent>();
  const samples: LatencySample[] = [];

  for (const ev of events) {
    const id = ev.probeId ?? ev.eventName;
    if (id !== probeId) {
      continue;
    }

    const key =
      grouping === 'per-pid'
        ? `pid:${ev.pid}`
        : grouping === 'per-cpu'
          ? `cpu:${ev.cpu}`
          : 'global';

    const prev = prevByKey.get(key);
    prevByKey.set(key, ev);

    if (prev && ev.timestamp >= prev.timestamp) {
      samples.push({
        entryEventIndex: prev.index,
        exitEventIndex: ev.index,
        pid: ev.pid,
        task: ev.task,
        cpu: ev.cpu,
        startTs: prev.timestamp,
        endTs: ev.timestamp,
        durationUs: (ev.timestamp - prev.timestamp) * 1e6,
      });
    }
  }

  return samples;
}

function percentileSorted(sorted: number[], p: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  if (sorted.length === 1) {
    return sorted[0];
  }
  const rank = (p / 100) * (sorted.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  const frac = rank - low;
  return sorted[low] + (sorted[high] - sorted[low]) * frac;
}

/**
 * Compute summary statistics (`count`, `min`, `max`, `mean`, `p50`, `p95`, `p99`).
 */
export function computeStats(values: number[]): SummaryStats {
  if (values.length === 0) {
    return {
      count: 0,
      min: 0,
      max: 0,
      mean: 0,
      p50: 0,
      p95: 0,
      p99: 0,
    };
  }

  const sorted = [...values].sort((a, b) => a - b);
  let sum = 0;
  for (const v of sorted) {
    sum += v;
  }

  return {
    count: sorted.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean: sum / sorted.length,
    p50: percentileSorted(sorted, 50),
    p95: percentileSorted(sorted, 95),
    p99: percentileSorted(sorted, 99),
  };
}

function formatUsLabel(v: number): string {
  if (v >= 1000) {
    return `${(v / 1000).toFixed(2)}ms`;
  }
  if (v >= 10) {
    return `${v.toFixed(1)}µs`;
  }
  return `${v.toFixed(2)}µs`;
}

/**
 * Bin samples into linear or log10 histogram buckets while preserving event indices.
 */
export function computeHistogram(
  samples: Array<{ value: number; eventIndex: number }>,
  options?: { binCount?: number; logScale?: boolean }
): HistogramBin[] {
  if (samples.length === 0) {
    return [];
  }

  const requestedBins = Math.min(60, Math.max(1, Math.floor(options?.binCount ?? 24)));
  const logScale = options?.logScale ?? false;

  if (logScale) {
    const positive = samples.filter((s) => s.value > 0);
    if (positive.length === 0) {
      return [
        {
          label: '0µs',
          min: 0,
          max: 0,
          count: samples.length,
          sampleEventIndices: samples.map((s) => s.eventIndex),
        },
      ];
    }

    let minLog = Math.log10(positive[0].value);
    let maxLog = minLog;
    for (const s of positive) {
      const lv = Math.log10(s.value);
      if (lv < minLog) {
        minLog = lv;
      }
      if (lv > maxLog) {
        maxLog = lv;
      }
    }

    if (Math.abs(maxLog - minLog) < 1e-9) {
      const v = positive[0].value;
      return [
        {
          label: formatUsLabel(v),
          min: v,
          max: v,
          count: positive.length,
          sampleEventIndices: positive.map((s) => s.eventIndex),
        },
      ];
    }

    const binCount = requestedBins;
    const step = (maxLog - minLog) / binCount;
    const bins: HistogramBin[] = Array.from({ length: binCount }, (_, i) => {
      const bMin = 10 ** (minLog + i * step);
      const bMax = 10 ** (minLog + (i + 1) * step);
      return {
        label: `${formatUsLabel(bMin)}–${formatUsLabel(bMax)}`,
        min: bMin,
        max: bMax,
        count: 0,
        sampleEventIndices: [],
      };
    });

    for (const s of positive) {
      const lv = Math.log10(s.value);
      const idx = Math.min(binCount - 1, Math.max(0, Math.floor((lv - minLog) / step)));
      bins[idx].count += 1;
      bins[idx].sampleEventIndices.push(s.eventIndex);
    }

    return bins;
  }

  let minVal = samples[0].value;
  let maxVal = samples[0].value;
  for (const s of samples) {
    if (s.value < minVal) {
      minVal = s.value;
    }
    if (s.value > maxVal) {
      maxVal = s.value;
    }
  }

  if (Math.abs(maxVal - minVal) < 1e-9) {
    return [
      {
        label: formatUsLabel(minVal),
        min: minVal,
        max: maxVal,
        count: samples.length,
        sampleEventIndices: samples.map((s) => s.eventIndex),
      },
    ];
  }

  const binCount = requestedBins;
  const step = (maxVal - minVal) / binCount;
  const bins: HistogramBin[] = Array.from({ length: binCount }, (_, i) => {
    const bMin = minVal + i * step;
    const bMax = minVal + (i + 1) * step;
    return {
      label: `${formatUsLabel(bMin)}–${formatUsLabel(bMax)}`,
      min: bMin,
      max: bMax,
      count: 0,
      sampleEventIndices: [],
    };
  });

  for (const s of samples) {
    const idx = Math.min(binCount - 1, Math.max(0, Math.floor((s.value - minVal) / step)));
    bins[idx].count += 1;
    bins[idx].sampleEventIndices.push(s.eventIndex);
  }

  return bins;
}
