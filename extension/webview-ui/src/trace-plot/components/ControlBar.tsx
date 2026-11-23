import React from 'react';
import {
  InterArrivalGrouping,
  NumericFieldInfo,
  SuggestedLatencyPair,
} from '../../../../src/kprobe/traceAnalytics';
import { KprobeSpec } from '../../../../src/kprobe/types';
import { TimelineLaneMode } from '../optionBuilders';

export type PlotViewTab = 'timeline' | 'values' | 'latency';
export type LatencyMode = 'paired' | 'inter-arrival';
export type LatencyChartKind = 'scatter' | 'histogram';

export interface ControlBarProps {
  activeTab: PlotViewTab;
  onChangeTab: (tab: PlotViewTab) => void;
  relativeTime: boolean;
  onToggleRelativeTime: (val: boolean) => void;
  onReload: () => void;
  onExportPng: () => void;
  onExportCsv: () => void;

  // Timeline controls
  laneMode: TimelineLaneMode;
  onChangeLaneMode: (mode: TimelineLaneMode) => void;
  availableProbeIds: string[];
  enabledProbeIds: Set<string>;
  onToggleProbeId: (id: string) => void;
  pidFilter: string;
  onChangePidFilter: (val: string) => void;

  // Values controls
  numericFields: NumericFieldInfo[];
  selectedFieldKeys: Set<string>;
  onToggleFieldKey: (key: string) => void;
  valueChartType: 'line' | 'scatter';
  onChangeValueChartType: (t: 'line' | 'scatter') => void;
  valueLogScale: boolean;
  onToggleValueLogScale: (v: boolean) => void;
  valueHexFormat: boolean;
  onToggleValueHexFormat: (v: boolean) => void;
  pointerOffsetFromMin: boolean;
  onTogglePointerOffset: (v: boolean) => void;

  // Latency controls
  probes: KprobeSpec[];
  latencyMode: LatencyMode;
  onChangeLatencyMode: (m: LatencyMode) => void;
  entryProbeId: string;
  exitProbeId: string;
  onChangeEntryProbeId: (id: string) => void;
  onChangeExitProbeId: (id: string) => void;
  suggestedPairs: SuggestedLatencyPair[];
  interArrivalProbeId: string;
  onChangeInterArrivalProbeId: (id: string) => void;
  interArrivalGrouping: InterArrivalGrouping;
  onChangeInterArrivalGrouping: (g: InterArrivalGrouping) => void;
  latencyChartKind: LatencyChartKind;
  onChangeLatencyChartKind: (k: LatencyChartKind) => void;
  latencyLogScale: boolean;
  onToggleLatencyLogScale: (v: boolean) => void;
}

export const ControlBar: React.FC<ControlBarProps> = (props) => {
  const hasPointer64 = props.numericFields.some(
    (f) => f.isPointer64 && props.selectedFieldKeys.has(`${f.probeId}.${f.field}`)
  );

  return (
    <div className="tp-controls">
      <div className="tp-header-row">
        <div className="tp-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={props.activeTab === 'timeline'}
            className={`tp-tab ${props.activeTab === 'timeline' ? 'active' : ''}`}
            onClick={() => props.onChangeTab('timeline')}
          >
            Timeline
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={props.activeTab === 'values'}
            className={`tp-tab ${props.activeTab === 'values' ? 'active' : ''}`}
            onClick={() => props.onChangeTab('values')}
          >
            Values
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={props.activeTab === 'latency'}
            className={`tp-tab ${props.activeTab === 'latency' ? 'active' : ''}`}
            onClick={() => props.onChangeTab('latency')}
          >
            Latency
          </button>
        </div>

        <div className="tp-actions">
          <label className="tp-checkbox">
            <input
              type="checkbox"
              checked={props.relativeTime}
              onChange={(e) => props.onToggleRelativeTime(e.target.checked)}
            />
            Relative t-t0
          </label>
          <button type="button" className="tp-btn" onClick={props.onReload} title="Reload trace.log">
            Reload
          </button>
          <button type="button" className="tp-btn" onClick={props.onExportPng} title="Export chart as PNG">
            PNG
          </button>
          <button type="button" className="tp-btn" onClick={props.onExportCsv} title="Export data as CSV">
            CSV
          </button>
        </div>
      </div>

      <div className="tp-subbar">
        {props.activeTab === 'timeline' && (
          <>
            <label className="tp-field">
              Lane:
              <select
                value={props.laneMode}
                onChange={(e) => props.onChangeLaneMode(e.target.value as TimelineLaneMode)}
              >
                <option value="probe">Probe ID</option>
                <option value="cpu">CPU</option>
                <option value="task">Task (PID)</option>
              </select>
            </label>
            <div className="tp-chip-group">
              {props.availableProbeIds.map((id) => (
                <label key={id} className="tp-chip">
                  <input
                    type="checkbox"
                    checked={props.enabledProbeIds.has(id)}
                    onChange={() => props.onToggleProbeId(id)}
                  />
                  {id}
                </label>
              ))}
            </div>
            <label className="tp-field">
              PID/Task:
              <input
                type="text"
                className="tp-input"
                placeholder="Filter PID or task..."
                value={props.pidFilter}
                onChange={(e) => props.onChangePidFilter(e.target.value)}
              />
            </label>
          </>
        )}

        {props.activeTab === 'values' && (
          <>
            <div className="tp-chip-group">
              {props.numericFields.length === 0 ? (
                <span className="tp-muted">No numeric args detected in trace events</span>
              ) : (
                props.numericFields.map((f) => {
                  const key = `${f.probeId}.${f.field}`;
                  return (
                    <label key={key} className="tp-chip">
                      <input
                        type="checkbox"
                        checked={props.selectedFieldKeys.has(key)}
                        onChange={() => props.onToggleFieldKey(key)}
                      />
                      {key}
                    </label>
                  );
                })
              )}
            </div>
            <label className="tp-field">
              Chart:
              <select
                value={props.valueChartType}
                onChange={(e) =>
                  props.onChangeValueChartType(e.target.value as 'line' | 'scatter')
                }
              >
                <option value="line">Line</option>
                <option value="scatter">Scatter</option>
              </select>
            </label>
            <label className="tp-checkbox">
              <input
                type="checkbox"
                checked={props.valueLogScale}
                onChange={(e) => props.onToggleValueLogScale(e.target.checked)}
              />
              Log Y
            </label>
            <label className="tp-checkbox">
              <input
                type="checkbox"
                checked={props.valueHexFormat}
                onChange={(e) => props.onToggleValueHexFormat(e.target.checked)}
              />
              Hex
            </label>
            {hasPointer64 && (
              <label className="tp-checkbox">
                <input
                  type="checkbox"
                  checked={props.pointerOffsetFromMin}
                  onChange={(e) => props.onTogglePointerOffset(e.target.checked)}
                />
                Offset from Min Ptr
              </label>
            )}
          </>
        )}

        {props.activeTab === 'latency' && (
          <>
            <label className="tp-field">
              Mode:
              <select
                value={props.latencyMode}
                onChange={(e) => props.onChangeLatencyMode(e.target.value as LatencyMode)}
              >
                <option value="paired">Entry → Exit</option>
                <option value="inter-arrival">Inter-Arrival</option>
              </select>
            </label>

            {props.latencyMode === 'paired' ? (
              <>
                <label className="tp-field">
                  Entry:
                  <select
                    value={props.entryProbeId}
                    onChange={(e) => props.onChangeEntryProbeId(e.target.value)}
                  >
                    <option value="">-- select --</option>
                    {props.availableProbeIds.map((id) => (
                      <option key={id} value={id}>
                        {id}
                      </option>
                    ))}
                  </select>
                </label>
                <span className="tp-muted">→</span>
                <label className="tp-field">
                  Exit:
                  <select
                    value={props.exitProbeId}
                    onChange={(e) => props.onChangeExitProbeId(e.target.value)}
                  >
                    <option value="">-- select --</option>
                    {props.availableProbeIds.map((id) => (
                      <option key={id} value={id}>
                        {id}
                      </option>
                    ))}
                  </select>
                </label>
              </>
            ) : (
              <>
                <label className="tp-field">
                  Probe:
                  <select
                    value={props.interArrivalProbeId}
                    onChange={(e) => props.onChangeInterArrivalProbeId(e.target.value)}
                  >
                    <option value="">-- select --</option>
                    {props.availableProbeIds.map((id) => (
                      <option key={id} value={id}>
                        {id}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="tp-field">
                  Group:
                  <select
                    value={props.interArrivalGrouping}
                    onChange={(e) =>
                      props.onChangeInterArrivalGrouping(
                        e.target.value as InterArrivalGrouping
                      )
                    }
                  >
                    <option value="global">Global</option>
                    <option value="per-pid">Per PID</option>
                    <option value="per-cpu">Per CPU</option>
                  </select>
                </label>
              </>
            )}

            <label className="tp-field">
              View:
              <select
                value={props.latencyChartKind}
                onChange={(e) =>
                  props.onChangeLatencyChartKind(e.target.value as LatencyChartKind)
                }
              >
                <option value="scatter">Scatter</option>
                <option value="histogram">Histogram</option>
              </select>
            </label>
            <label className="tp-checkbox">
              <input
                type="checkbox"
                checked={props.latencyLogScale}
                onChange={(e) => props.onToggleLatencyLogScale(e.target.checked)}
              />
              Log Scale
            </label>
          </>
        )}
      </div>
    </div>
  );
};
