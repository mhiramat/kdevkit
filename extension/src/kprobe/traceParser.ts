import * as fs from 'node:fs';
import { extractEventNamesFromDefinitions } from './perfProbe';
import { KprobeSpec, TraceEvent, TraceParseResult } from './types';

const TRACE_LINE_RE =
  /^\s*(.+?)-(\d+)\s+\[(\d+)\]\s+(\S+)\s+(\d+\.\d+):\s+([a-zA-Z0-9_]+):\s+\(([^)]+)\)\s*(.*)$/;

const ARG_PAIR_RE = /([a-zA-Z_][a-zA-Z0-9_]*)=("(?:\\.|[^"])*"|\S+)/g;

/**
 * Parse trailing key=value arguments from a Tracefs event line.
 */
export function parseArgsMap(argsText: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!argsText) {
    return result;
  }
  ARG_PAIR_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ARG_PAIR_RE.exec(argsText)) !== null) {
    result[match[1]] = match[2];
  }
  return result;
}

function buildProbeLookup(probes: KprobeSpec[]): {
  byId: Map<string, KprobeSpec>;
  byDefEventName: Map<string, KprobeSpec>;
} {
  const byId = new Map<string, KprobeSpec>();
  const byDefEventName = new Map<string, KprobeSpec>();

  for (const probe of probes) {
    byId.set(probe.id, probe);
    for (const evName of extractEventNamesFromDefinitions(probe.definitions)) {
      if (!byDefEventName.has(evName)) {
        byDefEventName.set(evName, probe);
      }
    }
  }

  return { byId, byDefEventName };
}

function resolveProbeId(
  eventName: string,
  lookup: { byId: Map<string, KprobeSpec>; byDefEventName: Map<string, KprobeSpec> }
): string | undefined {
  if (lookup.byId.has(eventName)) {
    return eventName;
  }

  const fromDef = lookup.byDefEventName.get(eventName);
  if (fromDef) {
    return fromDef.id;
  }

  // Strip inline instance suffix (e.g. "p1_1" -> "p1")
  const strippedInline = eventName.replace(/_\d+$/, '');
  if (strippedInline !== eventName) {
    if (lookup.byId.has(strippedInline)) {
      return strippedInline;
    }
    const defMatch = lookup.byDefEventName.get(strippedInline);
    if (defMatch) {
      return defMatch.id;
    }
  }

  // Strip perf's automatic kretprobe suffix (e.g. "p2__return" or "p2__return_1" -> "p2")
  const strippedReturn = strippedInline.replace(/__return$/, '');
  if (strippedReturn !== strippedInline && lookup.byId.has(strippedReturn)) {
    return strippedReturn;
  }

  return undefined;
}

/**
 * Parse Tracefs `trace.log` content into structured `TraceEvent` objects.
 */
export function parseTraceLog(
  content: string,
  probes: KprobeSpec[],
  maxEvents = 10000
): TraceParseResult {
  const lookup = buildProbeLookup(probes);
  const events: TraceEvent[] = [];
  let totalMatched = 0;

  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trimStart();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const match = line.match(TRACE_LINE_RE);
    if (!match) {
      continue;
    }

    totalMatched += 1;
    if (events.length >= maxEvents) {
      continue;
    }

    const task = match[1].trim();
    const pid = Number.parseInt(match[2], 10);
    const cpu = Number.parseInt(match[3], 10);
    const flags = match[4];
    const timestamp = Number.parseFloat(match[5]);
    const eventName = match[6];
    const symbol = match[7].trim();
    const argsText = match[8].trim();

    events.push({
      index: totalMatched,
      task,
      pid,
      cpu,
      flags,
      timestamp,
      eventName,
      probeId: resolveProbeId(eventName, lookup),
      symbol,
      argsText,
      argsMap: parseArgsMap(argsText),
    });
  }

  return {
    events,
    totalMatched,
    truncated: totalMatched > maxEvents,
  };
}

/**
 * Read and parse a Tracefs log file from disk.
 */
export function parseTraceLogFile(
  filePath: string,
  probes: KprobeSpec[],
  maxEvents = 10000
): TraceParseResult {
  if (!fs.existsSync(filePath)) {
    return { events: [], totalMatched: 0, truncated: false };
  }
  const content = fs.readFileSync(filePath, 'utf-8');
  return parseTraceLog(content, probes, maxEvents);
}
