import { KprobeSpec, TraceEvent } from '../kprobe/types';

// Webview -> Extension Host
export type TracePlotToHostMessage =
  | { type: 'ready' }
  | { type: 'selectEvent'; eventIndex: number }
  | { type: 'requestReloadTrace' }
  | {
      type: 'exportData';
      format: 'csv' | 'png';
      filenameHint: string;
      content: string;
    };

// Extension Host -> Webview
export type HostToTracePlotMessage =
  | {
      type: 'traceSnapshot';
      probes: KprobeSpec[];
      events: TraceEvent[];
      truncated: boolean;
      totalMatched: number;
      selectedEventIndex: number | null;
      defaultTimebase?: 'relative' | 'absolute';
    }
  | { type: 'highlightEvent'; eventIndex: number | null };
