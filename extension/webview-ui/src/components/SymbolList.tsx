import React, { useState } from 'react';
import { KconfigNode, SearchItem, SymType, TriVal } from '../../../src/shared/protocol';

export interface SymbolRowItem {
  symbol: string;
  prompt: string;
  type: SymType;
  value: string;
  visible: boolean;
  pinnedBy?: string | null;
}

export interface SymbolListProps {
  items: SymbolRowItem[];
  selectedSymbol: string | null;
  onSelectSymbol: (symbol: string) => void;
  onRequestSolve: (symbol: string, value: TriVal) => void;
  onApplyNonBool: (symbol: string, value: string) => void;
}

export function nodesToSymbolRows(nodes: KconfigNode[]): SymbolRowItem[] {
  const rows: SymbolRowItem[] = [];
  for (const node of nodes) {
    if (node.kind === 'symbol' && node.name) {
      rows.push({
        symbol: node.name,
        prompt: node.prompt,
        type: (node.type as SymType) || 'bool',
        value: node.value ?? 'n',
        visible: node.visible,
        pinnedBy: node.pinnedBy ?? null,
      });
    }
  }
  return rows;
}

export function searchItemsToSymbolRows(items: SearchItem[]): SymbolRowItem[] {
  return items.map((item) => ({
    symbol: item.symbol,
    prompt: item.prompt,
    type: item.type,
    value: item.value,
    visible: item.visible,
    pinnedBy: item.pinnedBy,
  }));
}

export const SymbolList: React.FC<SymbolListProps> = ({
  items,
  selectedSymbol,
  onSelectSymbol,
  onRequestSolve,
  onApplyNonBool,
}) => {
  const [draftValues, setDraftValues] = useState<Record<string, string>>({});

  if (items.length === 0) {
    return (
      <div className="kdev-pane-symbols" data-testid="symbol-list">
        <p style={{ opacity: 0.7 }}>No symbols in current view.</p>
      </div>
    );
  }

  return (
    <div className="kdev-pane-symbols" data-testid="symbol-list">
      {items.map((item) => {
        const isBoolOrTri = item.type === 'bool' || item.type === 'tristate';
        const isSelected = selectedSymbol === item.symbol;
        const draftVal = draftValues[item.symbol] ?? item.value;

        return (
          <div
            key={item.symbol}
            className={`kdev-symbol-row ${isSelected ? 'selected' : ''} ${
              !item.visible ? 'invisible' : ''
            }`}
            onClick={() => onSelectSymbol(item.symbol)}
            data-testid={`symbol-row-${item.symbol}`}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600 }}>
                <span>CONFIG_{item.symbol}</span>
                {item.pinnedBy && (
                  <span
                    style={{ fontSize: 11, color: 'var(--kdev-warn-fg)' }}
                    data-testid={`pin-badge-${item.symbol}`}
                  >
                    🔒 {item.pinnedBy}
                  </span>
                )}
                {!item.visible && (
                  <span
                    style={{ fontSize: 11, opacity: 0.8 }}
                    title="Dependencies currently unmet; clicking Y/M will auto-resolve prerequisites"
                  >
                    (auto-resolve)
                  </span>
                )}
              </div>
              <div style={{ fontSize: 12, opacity: 0.85, marginTop: 2 }}>
                {item.prompt || '(no prompt)'}
              </div>
            </div>

            {isBoolOrTri ? (
              <div
                className="kdev-tristate-group"
                onClick={(e) => e.stopPropagation()}
              >
                <button
                  type="button"
                  className={`kdev-tri-btn ${item.value === 'n' ? 'active' : ''}`}
                  onClick={() => onRequestSolve(item.symbol, 'n')}
                  data-testid={`btn-${item.symbol}-n`}
                >
                  N
                </button>
                {item.type === 'tristate' && (
                  <button
                    type="button"
                    className={`kdev-tri-btn ${item.value === 'm' ? 'active' : ''}`}
                    onClick={() => onRequestSolve(item.symbol, 'm')}
                    data-testid={`btn-${item.symbol}-m`}
                  >
                    M
                  </button>
                )}
                <button
                  type="button"
                  className={`kdev-tri-btn ${item.value === 'y' ? 'active' : ''}`}
                  onClick={() => onRequestSolve(item.symbol, 'y')}
                  data-testid={`btn-${item.symbol}-y`}
                >
                  Y
                </button>
              </div>
            ) : (
              <div
                style={{ display: 'flex', gap: 4 }}
                onClick={(e) => e.stopPropagation()}
              >
                <input
                  type="text"
                  className="kdev-search-input"
                  style={{ width: 110 }}
                  value={draftVal}
                  onChange={(e) =>
                    setDraftValues((prev) => ({
                      ...prev,
                      [item.symbol]: e.target.value,
                    }))
                  }
                  aria-label={`Value for ${item.symbol}`}
                />
                <button
                  type="button"
                  className="kdev-btn"
                  onClick={() => onApplyNonBool(item.symbol, draftVal)}
                >
                  Save
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};
