import React from 'react';
import { SolveModalState } from '../state/store';

export interface SolveModalProps {
  modal: SolveModalState;
  onClose: () => void;
  onApply: (changes: Array<{ symbol: string; value: string }>) => void;
  onResolveIgnoringPins: () => void;
}

export const SolveModal: React.FC<SolveModalProps> = ({
  modal,
  onClose,
  onApply,
  onResolveIgnoringPins,
}) => {
  if (!modal.open) {
    return null;
  }

  const response = modal.response;
  const hasPinnedConflict =
    response?.status === 'conflict' &&
    response.conflicts.some((c) => c.kind === 'pinned_layer');

  const requestedChanges =
    response?.changes.filter((c) => c.reason === 'user_request') ?? [];
  const autoDeps =
    response?.changes.filter((c) => c.reason !== 'user_request') ?? [];

  return (
    <div className="kdev-modal-backdrop" data-testid="solve-modal">
      <div className="kdev-modal">
        <div className="kdev-modal-header">
          {modal.loading
            ? 'Solving Kconfig Dependencies...'
            : response?.status === 'conflict'
            ? 'Kconfig Dependency Conflict (UNSAT Core)'
            : 'Kconfig Dependency Resolution Preview'}
        </div>

        <div className="kdev-modal-body">
          {modal.loading && <p>Computing minimal SAT dependency closure...</p>}

          {modal.error && (
            <div className="kdev-conflict-box" data-testid="solve-error">
              <strong>Error:</strong> {modal.error}
            </div>
          )}

          {modal.applyResponse && !modal.applyResponse.verified && (
            <div className="kdev-conflict-box" data-testid="mismatch-warning">
              <strong>Post-Verification Mismatch after olddefconfig:</strong>
              <ul>
                {modal.applyResponse.mismatches.map((m) => (
                  <li key={m.symbol}>
                    CONFIG_{m.symbol}: expected <code>{m.expected}</code>, actual{' '}
                    <code>{m.actual}</code>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {!modal.loading && response?.status === 'ok' && (
            <>
              <div style={{ marginBottom: 10, fontSize: 12, opacity: 0.85 }}>
                Solved in {response.solveTimeMs} ms ({response.changes.length} symbol change
                {response.changes.length === 1 ? '' : 's'}).
              </div>

              {response.changes.length === 0 ? (
                <p>Target symbols already match the requested values.</p>
              ) : (
                <>
                  {requestedChanges.length > 0 && (
                    <div style={{ marginBottom: 12 }}>
                      <strong>Requested Change</strong>
                      <table className="kdev-table">
                        <thead>
                          <tr>
                            <th>Symbol</th>
                            <th>Transition</th>
                            <th>Reason</th>
                          </tr>
                        </thead>
                        <tbody>
                          {requestedChanges.map((c) => (
                            <tr key={c.symbol} data-testid={`diff-row-${c.symbol}`}>
                              <td>CONFIG_{c.symbol}</td>
                              <td>
                                <code>{c.from}</code> → <code>{c.to}</code>
                              </td>
                              <td>{c.reason}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}

                  {autoDeps.length > 0 && (
                    <div>
                      <strong>Auto-Resolved Dependencies ({autoDeps.length} symbols)</strong>
                      <table className="kdev-table">
                        <thead>
                          <tr>
                            <th>Symbol</th>
                            <th>Transition</th>
                            <th>Reason</th>
                          </tr>
                        </thead>
                        <tbody>
                          {autoDeps.map((c) => (
                            <tr key={c.symbol} data-testid={`diff-row-${c.symbol}`}>
                              <td>CONFIG_{c.symbol}</td>
                              <td>
                                <code>{c.from}</code> → <code>{c.to}</code>
                              </td>
                              <td>{c.reason}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </>
              )}
            </>
          )}

          {!modal.loading && response?.status === 'conflict' && (
            <>
              <div className="kdev-conflict-box" data-testid="conflict-details">
                <strong>Conflicting Constraints (UNSAT Core):</strong>
                <ul>
                  {response.conflicts.map((item, idx) => (
                    <li key={`${item.symbol}-${idx}`}>
                      {item.kind === 'pinned_layer' ? (
                        <span>
                          🔒 <strong>CONFIG_{item.symbol}={item.pinnedValue}</strong> is pinned by{' '}
                          <code>{item.layerPath || item.layerId}</code> (layer:{' '}
                          <code>{item.layerId}</code>)
                        </span>
                      ) : (
                        <span>
                          Requested <strong>CONFIG_{item.symbol}={item.requested}</strong>
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>

              {response.diagnostics.length > 0 && (
                <div>
                  <strong>Diagnostics:</strong>
                  <ul>
                    {response.diagnostics.map((d, i) => (
                      <li key={i}>{d}</li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
        </div>

        <div className="kdev-modal-footer">
          <button
            type="button"
            className="kdev-btn secondary"
            onClick={onClose}
            disabled={modal.applying}
            data-testid="modal-cancel-btn"
          >
            Cancel
          </button>

          {!modal.loading && response?.status === 'conflict' && hasPinnedConflict && !modal.ignorePins && (
            <button
              type="button"
              className="kdev-btn"
              onClick={onResolveIgnoringPins}
              disabled={modal.applying}
              data-testid="resolve-ignore-pins-btn"
            >
              Re-solve Ignoring Pins
            </button>
          )}

          {!modal.loading && response?.status === 'ok' && response.changes.length > 0 && (
            <button
              type="button"
              className="kdev-btn"
              disabled={modal.applying}
              onClick={() =>
                onApply(
                  response.changes.map((c) => ({
                    symbol: c.symbol,
                    value: c.to,
                  }))
                )
              }
              data-testid="modal-apply-btn"
            >
              {modal.applying ? 'Applying & Syncing #ifdef...' : 'Apply & Sync #ifdef'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
