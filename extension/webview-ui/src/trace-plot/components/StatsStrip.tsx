import React from 'react';
import { SummaryStats } from '../../../../src/kprobe/traceAnalytics';

export interface StatsStripProps {
  eventCount: number;
  totalMatched: number;
  truncated: boolean;
  timeRangeText: string;
  latencyStats?: SummaryStats | null;
  unmatchedEntries?: number;
  unmatchedExits?: number;
}

function fmtUs(v: number): string {
  if (v >= 1000) {
    return `${(v / 1000).toFixed(2)}ms`;
  }
  return `${v.toFixed(1)}µs`;
}

export const StatsStrip: React.FC<StatsStripProps> = ({
  eventCount,
  totalMatched,
  truncated,
  timeRangeText,
  latencyStats,
  unmatchedEntries = 0,
  unmatchedExits = 0,
}) => {
  return (
    <div className="tp-stats-strip">
      <span className="tp-stat">
        Events: <b>{eventCount.toLocaleString()}</b>
        {truncated ? ` (of ${totalMatched.toLocaleString()} — truncated)` : ''}
      </span>
      <span className="tp-stat">
        Range: <b>{timeRangeText}</b>
      </span>
      {latencyStats && latencyStats.count > 0 && (
        <>
          <span className="tp-stat">
            Samples: <b>{latencyStats.count.toLocaleString()}</b>
          </span>
          <span className="tp-stat">
            min: <b>{fmtUs(latencyStats.min)}</b>
          </span>
          <span className="tp-stat">
            p50: <b>{fmtUs(latencyStats.p50)}</b>
          </span>
          <span className="tp-stat">
            p95: <b>{fmtUs(latencyStats.p95)}</b>
          </span>
          <span className="tp-stat">
            p99: <b>{fmtUs(latencyStats.p99)}</b>
          </span>
          <span className="tp-stat">
            max: <b>{fmtUs(latencyStats.max)}</b>
          </span>
        </>
      )}
      {(unmatchedEntries > 0 || unmatchedExits > 0) && (
        <span className="tp-stat tp-warn">
          Unmatched: {unmatchedEntries} entry / {unmatchedExits} exit
        </span>
      )}
    </div>
  );
};
