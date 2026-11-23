import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  computeHistogram,
  computeInterArrival,
  computePairedLatency,
  computeStats,
  extractNumericFields,
  InterArrivalGrouping,
  suggestLatencyPairs,
} from '../../../src/kprobe/traceAnalytics';
import { KprobeSpec, TraceEvent } from '../../../src/kprobe/types';
import {
  HostToTracePlotMessage,
  TracePlotToHostMessage,
} from '../../../src/shared/tracePlotProtocol';
import { ChartCanvas, ChartCanvasHandle } from './components/ChartCanvas';
import {
  ControlBar,
  LatencyChartKind,
  LatencyMode,
  PlotViewTab,
} from './components/ControlBar';
import { StatsStrip } from './components/StatsStrip';
import { readVscodeChartTheme, TracePlotTheme } from './echartsSetup';
import {
  buildLatencyHistogramOption,
  buildLatencyScatterOption,
  buildTimelineOption,
  buildValueSeriesOption,
  TimelineLaneMode,
} from './optionBuilders';

interface VsCodeApi {
  postMessage(message: TracePlotToHostMessage): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

let cachedApi: VsCodeApi | null = null;
function postToHost(msg: TracePlotToHostMessage): void {
  if (!cachedApi && typeof acquireVsCodeApi === 'function') {
    cachedApi = acquireVsCodeApi();
  }
  cachedApi?.postMessage(msg);
}

export const TracePlotApp: React.FC = () => {
  const chartRef = useRef<ChartCanvasHandle | null>(null);
  const [theme, setTheme] = useState<TracePlotTheme>(() => readVscodeChartTheme());

  const [probes, setProbes] = useState<KprobeSpec[]>([]);
  const [events, setEvents] = useState<TraceEvent[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [totalMatched, setTotalMatched] = useState(0);
  const [selectedEventIndex, setSelectedEventIndex] = useState<number | null>(null);

  const [activeTab, setActiveTab] = useState<PlotViewTab>('timeline');
  const [relativeTime, setRelativeTime] = useState(true);

  // Timeline state
  const [laneMode, setLaneMode] = useState<TimelineLaneMode>('probe');
  const [enabledProbeIds, setEnabledProbeIds] = useState<Set<string>>(new Set());
  const [pidFilter, setPidFilter] = useState('');

  // Values state
  const [selectedFieldKeys, setSelectedFieldKeys] = useState<Set<string>>(new Set());
  const [valueChartType, setValueChartType] = useState<'line' | 'scatter'>('line');
  const [valueLogScale, setValueLogScale] = useState(false);
  const [valueHexFormat, setValueHexFormat] = useState(false);
  const [pointerOffsetFromMin, setPointerOffsetFromMin] = useState(false);

  // Latency state
  const [latencyMode, setLatencyMode] = useState<LatencyMode>('paired');
  const [entryProbeId, setEntryProbeId] = useState('');
  const [exitProbeId, setExitProbeId] = useState('');
  const [interArrivalProbeId, setInterArrivalProbeId] = useState('');
  const [interArrivalGrouping, setInterArrivalGrouping] =
    useState<InterArrivalGrouping>('global');
  const [latencyChartKind, setLatencyChartKind] = useState<LatencyChartKind>('scatter');
  const [latencyLogScale, setLatencyLogScale] = useState(false);

  useEffect(() => {
    const onMessage = (ev: MessageEvent<HostToTracePlotMessage>) => {
      const msg = ev.data;
      if (!msg || typeof msg !== 'object') {
        return;
      }
      if (msg.type === 'traceSnapshot') {
        setProbes(msg.probes);
        setEvents(msg.events);
        setTruncated(msg.truncated);
        setTotalMatched(msg.totalMatched);
        setSelectedEventIndex(msg.selectedEventIndex);
        if (msg.defaultTimebase) {
          setRelativeTime(msg.defaultTimebase === 'relative');
        }

        const ids = new Set<string>();
        for (const e of msg.events) {
          ids.add(e.probeId ?? e.eventName);
        }
        setEnabledProbeIds(ids);

        const fields = extractNumericFields(msg.events);
        if (fields.length > 0) {
          setSelectedFieldKeys((prev) =>
            prev.size > 0 ? prev : new Set([`${fields[0].probeId}.${fields[0].field}`])
          );
          if (fields[0].isHex) {
            setValueHexFormat(true);
          }
        }

        const pairs = suggestLatencyPairs(msg.probes);
        if (pairs.length > 0) {
          setEntryProbeId((prev) => prev || pairs[0].entryProbeId);
          setExitProbeId((prev) => prev || pairs[0].exitProbeId);
        }
        const firstId = Array.from(ids)[0] ?? '';
        if (firstId) {
          setInterArrivalProbeId((prev) => prev || firstId);
        }
      } else if (msg.type === 'highlightEvent') {
        setSelectedEventIndex(msg.eventIndex);
      }
    };

    window.addEventListener('message', onMessage);
    postToHost({ type: 'ready' });
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const availableProbeIds = useMemo(() => {
    const ids = new Set<string>();
    for (const e of events) {
      ids.add(e.probeId ?? e.eventName);
    }
    return Array.from(ids).sort();
  }, [events]);

  const numericFields = useMemo(() => extractNumericFields(events), [events]);
  const suggestedPairs = useMemo(() => suggestLatencyPairs(probes), [probes]);

  const t0 = events.length > 0 ? events[0].timestamp : 0;

  const filteredTimelineEvents = useMemo(() => {
    const needle = pidFilter.trim().toLowerCase();
    return events.filter((ev) => {
      const id = ev.probeId ?? ev.eventName;
      if (enabledProbeIds.size > 0 && !enabledProbeIds.has(id)) {
        return false;
      }
      if (needle) {
        const hay = `${ev.task}-${ev.pid}`.toLowerCase();
        if (!hay.includes(needle)) {
          return false;
        }
      }
      return true;
    });
  }, [events, enabledProbeIds, pidFilter]);

  const latencyComputation = useMemo(() => {
    if (latencyMode === 'paired') {
      if (!entryProbeId || !exitProbeId) {
        return { samples: [], unmatchedEntries: 0, unmatchedExits: 0 };
      }
      return computePairedLatency(events, entryProbeId, exitProbeId);
    }
    if (!interArrivalProbeId) {
      return { samples: [], unmatchedEntries: 0, unmatchedExits: 0 };
    }
    return {
      samples: computeInterArrival(events, interArrivalProbeId, interArrivalGrouping),
      unmatchedEntries: 0,
      unmatchedExits: 0,
    };
  }, [
    events,
    latencyMode,
    entryProbeId,
    exitProbeId,
    interArrivalProbeId,
    interArrivalGrouping,
  ]);

  const latencyStats = useMemo(
    () =>
      activeTab === 'latency'
        ? computeStats(latencyComputation.samples.map((s) => s.durationUs))
        : null,
    [activeTab, latencyComputation.samples]
  );

  const chartOption = useMemo(() => {
    if (activeTab === 'timeline') {
      return buildTimelineOption({
        events: filteredTimelineEvents,
        probes,
        laneMode,
        relativeTime,
        t0,
        selectedEventIndex,
        theme,
      });
    }

    if (activeTab === 'values') {
      const selectedFields = Array.from(selectedFieldKeys)
        .map((key) => {
          const dot = key.indexOf('.');
          return dot > 0
            ? { probeId: key.slice(0, dot), field: key.slice(dot + 1) }
            : null;
        })
        .filter((x): x is { probeId: string; field: string } => x !== null);

      return buildValueSeriesOption({
        events,
        selectedFields,
        fieldInfos: numericFields,
        chartType: valueChartType,
        logScale: valueLogScale,
        formatAsHex: valueHexFormat,
        pointerOffsetFromMin,
        relativeTime,
        t0,
        selectedEventIndex,
        theme,
      });
    }

    if (latencyChartKind === 'histogram') {
      const bins = computeHistogram(
        latencyComputation.samples.map((s) => ({
          value: s.durationUs,
          eventIndex: s.entryEventIndex,
        })),
        { binCount: 24, logScale: latencyLogScale }
      );
      return buildLatencyHistogramOption({ bins, theme });
    }

    return buildLatencyScatterOption({
      samples: latencyComputation.samples,
      stats: latencyStats ?? computeStats([]),
      logScale: latencyLogScale,
      relativeTime,
      t0,
      selectedEventIndex,
      seriesName:
        latencyMode === 'paired'
          ? `${entryProbeId} → ${exitProbeId} (µs)`
          : `${interArrivalProbeId} Δt (µs)`,
      theme,
    });
  }, [
    activeTab,
    filteredTimelineEvents,
    probes,
    laneMode,
    relativeTime,
    t0,
    selectedEventIndex,
    theme,
    events,
    selectedFieldKeys,
    numericFields,
    valueChartType,
    valueLogScale,
    valueHexFormat,
    pointerOffsetFromMin,
    latencyChartKind,
    latencyComputation.samples,
    latencyLogScale,
    latencyStats,
    latencyMode,
    entryProbeId,
    exitProbeId,
    interArrivalProbeId,
  ]);

  const timeRangeText = useMemo(() => {
    if (events.length === 0) {
      return '—';
    }
    const start = relativeTime ? 0 : events[0].timestamp;
    const end = relativeTime
      ? events[events.length - 1].timestamp - t0
      : events[events.length - 1].timestamp;
    return `${start.toFixed(3)}s – ${end.toFixed(3)}s`;
  }, [events, relativeTime, t0]);

  const handleSelectEvent = useCallback((eventIndex: number) => {
    setSelectedEventIndex(eventIndex);
    postToHost({ type: 'selectEvent', eventIndex });
  }, []);

  const handleExportPng = useCallback(() => {
    const dataUrl = chartRef.current?.getDataURL(theme.backgroundColor);
    if (!dataUrl) {
      return;
    }
    postToHost({
      type: 'exportData',
      format: 'png',
      filenameHint: `kdev-trace-${activeTab}.png`,
      content: dataUrl,
    });
  }, [activeTab, theme.backgroundColor]);

  const handleExportCsv = useCallback(() => {
    let csv: string;
    if (activeTab === 'latency') {
      const header = 'entry_index,exit_index,task,pid,cpu,start_ts,end_ts,duration_us,retval';
      const rows = latencyComputation.samples.map((s) =>
        [
          s.entryEventIndex,
          s.exitEventIndex,
          JSON.stringify(s.task),
          s.pid,
          s.cpu,
          s.startTs.toFixed(6),
          s.endTs.toFixed(6),
          s.durationUs.toFixed(3),
          s.retval ?? '',
        ].join(',')
      );
      csv = [header, ...rows].join('\n') + '\n';
    } else {
      const header = 'index,timestamp,probe_id,task,pid,cpu,symbol,args';
      const rows = filteredTimelineEvents.map((e) =>
        [
          e.index,
          e.timestamp.toFixed(6),
          e.probeId ?? e.eventName,
          JSON.stringify(e.task),
          e.pid,
          e.cpu,
          JSON.stringify(e.symbol),
          JSON.stringify(e.argsText),
        ].join(',')
      );
      csv = [header, ...rows].join('\n') + '\n';
    }

    postToHost({
      type: 'exportData',
      format: 'csv',
      filenameHint: `kdev-trace-${activeTab}.csv`,
      content: csv,
    });
  }, [activeTab, filteredTimelineEvents, latencyComputation.samples]);

  return (
    <div className="tp-root">
      <ControlBar
        activeTab={activeTab}
        onChangeTab={setActiveTab}
        relativeTime={relativeTime}
        onToggleRelativeTime={setRelativeTime}
        onReload={() => postToHost({ type: 'requestReloadTrace' })}
        onExportPng={handleExportPng}
        onExportCsv={handleExportCsv}
        laneMode={laneMode}
        onChangeLaneMode={setLaneMode}
        availableProbeIds={availableProbeIds}
        enabledProbeIds={enabledProbeIds}
        onToggleProbeId={(id) =>
          setEnabledProbeIds((prev) => {
            const next = new Set(prev);
            if (next.has(id)) {
              next.delete(id);
            } else {
              next.add(id);
            }
            return next;
          })
        }
        pidFilter={pidFilter}
        onChangePidFilter={setPidFilter}
        numericFields={numericFields}
        selectedFieldKeys={selectedFieldKeys}
        onToggleFieldKey={(key) =>
          setSelectedFieldKeys((prev) => {
            const next = new Set(prev);
            if (next.has(key)) {
              next.delete(key);
            } else {
              next.add(key);
            }
            return next;
          })
        }
        valueChartType={valueChartType}
        onChangeValueChartType={setValueChartType}
        valueLogScale={valueLogScale}
        onToggleValueLogScale={setValueLogScale}
        valueHexFormat={valueHexFormat}
        onToggleValueHexFormat={setValueHexFormat}
        pointerOffsetFromMin={pointerOffsetFromMin}
        onTogglePointerOffset={setPointerOffsetFromMin}
        probes={probes}
        latencyMode={latencyMode}
        onChangeLatencyMode={setLatencyMode}
        entryProbeId={entryProbeId}
        exitProbeId={exitProbeId}
        onChangeEntryProbeId={setEntryProbeId}
        onChangeExitProbeId={setExitProbeId}
        suggestedPairs={suggestedPairs}
        interArrivalProbeId={interArrivalProbeId}
        onChangeInterArrivalProbeId={setInterArrivalProbeId}
        interArrivalGrouping={interArrivalGrouping}
        onChangeInterArrivalGrouping={setInterArrivalGrouping}
        latencyChartKind={latencyChartKind}
        onChangeLatencyChartKind={setLatencyChartKind}
        latencyLogScale={latencyLogScale}
        onToggleLatencyLogScale={setLatencyLogScale}
      />

      <StatsStrip
        eventCount={activeTab === 'timeline' ? filteredTimelineEvents.length : events.length}
        totalMatched={totalMatched}
        truncated={truncated}
        timeRangeText={timeRangeText}
        latencyStats={latencyStats}
        unmatchedEntries={activeTab === 'latency' ? latencyComputation.unmatchedEntries : 0}
        unmatchedExits={activeTab === 'latency' ? latencyComputation.unmatchedExits : 0}
      />

      <div className="tp-chart-wrap">
        <ChartCanvas
          ref={chartRef}
          option={chartOption}
          onSelectEvent={handleSelectEvent}
          onThemeChange={setTheme}
        />
      </div>
    </div>
  );
};
