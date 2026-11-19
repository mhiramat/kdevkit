import React from 'react';
import { ConfigLayer } from '../../../src/shared/protocol';

export interface LayerBarProps {
  baseTarget: string;
  layers: ConfigLayer[];
  onUpdateLayers: (baseTarget: string, layers: ConfigLayer[], applyNow?: boolean) => void;
  onInjectLayer: () => void;
  onResetSolverOverlay: () => void;
  onReload: () => void;
}

export const LayerBar: React.FC<LayerBarProps> = ({
  baseTarget,
  layers,
  onUpdateLayers,
  onInjectLayer,
  onResetSolverOverlay,
  onReload,
}) => {
  const handleToggleEnabled = (id: string) => {
    const next = layers.map((l) => (l.id === id ? { ...l, enabled: !l.enabled } : l));
    onUpdateLayers(baseTarget, next, false);
  };

  const handleTogglePin = (id: string) => {
    const next = layers.map((l) => (l.id === id ? { ...l, pinned: !l.pinned } : l));
    onUpdateLayers(baseTarget, next, false);
  };

  const handleMove = (index: number, delta: number) => {
    const targetIdx = index + delta;
    if (targetIdx < 0 || targetIdx >= layers.length) {
      return;
    }
    const next = [...layers];
    const [moved] = next.splice(index, 1);
    next.splice(targetIdx, 0, moved);
    onUpdateLayers(baseTarget, next, false);
  };

  const handleRemove = (id: string) => {
    const next = layers.filter((l) => l.id !== id);
    onUpdateLayers(baseTarget, next, false);
  };

  return (
    <div className="kdev-layer-bar" data-testid="layer-bar">
      <label>
        Base:{' '}
        <select
          value={baseTarget}
          onChange={(e) => onUpdateLayers(e.target.value, layers, false)}
          aria-label="Base Kconfig Target"
        >
          <option value="defconfig">defconfig</option>
          <option value="allnoconfig">allnoconfig</option>
          <option value="tinyconfig">tinyconfig</option>
        </select>
      </label>

      {layers.map((layer, idx) => (
        <div
          key={layer.id}
          className={`kdev-layer-chip ${layer.pinned ? 'pinned' : ''} ${
            !layer.enabled ? 'disabled' : ''
          }`}
          data-testid={`layer-chip-${layer.id}`}
        >
          <input
            type="checkbox"
            checked={layer.enabled}
            onChange={() => handleToggleEnabled(layer.id)}
            title="Enable/disable layer"
            aria-label={`Enable ${layer.id}`}
          />
          {layer.id !== 'solver' && (
            <button
              type="button"
              className="kdev-tri-btn"
              onClick={() => handleTogglePin(layer.id)}
              title={layer.pinned ? 'Pinned (Hard Constraint)' : 'Unpinned (Soft Preference)'}
              aria-label={`Toggle pin ${layer.id}`}
            >
              {layer.pinned ? '🔒' : '🔓'}
            </button>
          )}
          <span title={layer.path}>
            {layer.id}
            {typeof layer.symbolCount === 'number' ? ` (${layer.symbolCount})` : ''}
          </span>
          {layer.id !== 'solver' && (
            <>
              <button
                type="button"
                className="kdev-tri-btn"
                onClick={() => handleMove(idx, -1)}
                disabled={idx === 0}
                title="Move layer earlier"
              >
                ↑
              </button>
              <button
                type="button"
                className="kdev-tri-btn"
                onClick={() => handleMove(idx, 1)}
                disabled={idx >= layers.length - 1}
                title="Move layer later"
              >
                ↓
              </button>
            </>
          )}
          {!layer.readonly && layer.id !== 'qemu' && layer.id !== 'trace' && layer.id !== 'solver' && (
            <button
              type="button"
              className="kdev-tri-btn"
              onClick={() => handleRemove(layer.id)}
              title="Remove layer"
            >
              ×
            </button>
          )}
        </div>
      ))}

      <button
        type="button"
        className="kdev-btn secondary"
        onClick={onInjectLayer}
        data-testid="inject-layer-btn"
      >
        + Inject Config
      </button>
      <button
        type="button"
        className="kdev-btn secondary"
        onClick={onResetSolverOverlay}
        title="Clear solver_overlay.config and re-run configure.sh"
      >
        Reset Overlay
      </button>
      <button
        type="button"
        className="kdev-btn secondary"
        onClick={onReload}
        title="Reload .config from disk"
      >
        ↻
      </button>
    </div>
  );
};
