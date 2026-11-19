import React from 'react';
import { SymbolDetail } from '../../../src/shared/protocol';

export interface DetailPaneProps {
  detail: SymbolDetail | null;
  onSelectSymbol: (symbol: string) => void;
}

export const DetailPane: React.FC<DetailPaneProps> = ({ detail, onSelectSymbol }) => {
  if (!detail) {
    return (
      <div className="kdev-pane-detail" data-testid="detail-pane">
        <p style={{ opacity: 0.7 }}>Select a Kconfig symbol to inspect dependencies and help.</p>
      </div>
    );
  }

  return (
    <div className="kdev-pane-detail" data-testid="detail-pane">
      <h3 style={{ marginTop: 0, marginBottom: 6 }}>CONFIG_{detail.symbol}</h3>
      {detail.prompt && (
        <div style={{ fontWeight: 600, marginBottom: 8 }}>{detail.prompt}</div>
      )}

      <div style={{ fontSize: 12, lineHeight: 1.6, marginBottom: 12 }}>
        <div>
          <strong>Type:</strong> {detail.type}
        </div>
        <div>
          <strong>Current Value:</strong> <code>{detail.value || 'n'}</code>
        </div>
        <div>
          <strong>Prompt Visible:</strong> {detail.visible ? 'Yes' : 'No (dependencies unmet)'}
        </div>
        {detail.pinnedBy && (
          <div style={{ color: 'var(--kdev-warn-fg)' }}>
            <strong>Pinned By Layer:</strong> 🔒 {detail.pinnedBy}
          </div>
        )}
        {detail.menuPath.length > 0 && (
          <div>
            <strong>Menu Path:</strong> {detail.menuPath.join(' → ')}
          </div>
        )}
      </div>

      <div style={{ marginBottom: 12 }}>
        <strong>Depends on:</strong>
        <pre
          style={{
            padding: 8,
            backgroundColor: 'var(--kdev-sidebar-bg)',
            border: '1px solid var(--kdev-border)',
            borderRadius: 4,
            whiteSpace: 'pre-wrap',
            fontSize: 12,
          }}
        >
          {detail.directDepText || 'y'}
        </pre>
      </div>

      {detail.selects.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <strong>Selects:</strong>
          <ul style={{ margin: '4px 0', paddingLeft: 18 }}>
            {detail.selects.map((s) => (
              <li key={`${s.symbol}-${s.condition}`}>
                <a
                  href="#"
                  onClick={(e) => {
                    e.preventDefault();
                    onSelectSymbol(s.symbol);
                  }}
                >
                  {s.symbol}
                </a>
                {s.condition !== 'y' ? ` if ${s.condition}` : ''}
              </li>
            ))}
          </ul>
        </div>
      )}

      {detail.selectedBy.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <strong>Selected by:</strong>
          <ul style={{ margin: '4px 0', paddingLeft: 18 }}>
            {detail.selectedBy.map((s) => (
              <li key={`${s.symbol}-${s.condition}`}>
                <a
                  href="#"
                  onClick={(e) => {
                    e.preventDefault();
                    onSelectSymbol(s.symbol);
                  }}
                >
                  {s.symbol}
                </a>
                {s.condition !== 'y' ? ` if ${s.condition}` : ''}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div>
        <strong>Help:</strong>
        <pre
          style={{
            padding: 8,
            backgroundColor: 'var(--kdev-sidebar-bg)',
            border: '1px solid var(--kdev-border)',
            borderRadius: 4,
            whiteSpace: 'pre-wrap',
            fontSize: 12,
          }}
        >
          {detail.help || 'No help text available.'}
        </pre>
      </div>
    </div>
  );
};
