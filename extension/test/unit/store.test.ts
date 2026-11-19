import { describe, expect, it } from 'vitest';
import {
  initialUiState,
  kconfigUiReducer,
} from '../../webview-ui/src/state/store';

describe('Layer 3a: Webview State Reducer (store.ts)', () => {
  it('initializes ready state, tree nodes, and layers', () => {
    const next = kconfigUiReducer(initialUiState, {
      type: 'INIT_STATE',
      status: 'ready',
      baseTarget: 'defconfig',
      layers: [{ id: 'qemu', path: 'configs/qemu.config', enabled: true, pinned: true }],
      rootNodes: [
        {
          id: 'node_1',
          kind: 'menu',
          name: null,
          prompt: 'Networking',
          visible: true,
          hasChildren: true,
        },
      ],
    });
    expect(next.status).toBe('ready');
    expect(next.selectedMenuId).toBe('node_1');
    expect(next.layers).toHaveLength(1);
  });

  it('handles SOLVE_START -> SOLVE_SUCCESS (conflict) -> SOLVE_START (ignorePins) -> APPLY_SUCCESS', () => {
    let state = kconfigUiReducer(initialUiState, {
      type: 'INIT_STATE',
      status: 'ready',
      rootNodes: [
        {
          id: 'node_sym',
          kind: 'symbol',
          name: 'NEG_B',
          prompt: 'Negation B',
          type: 'bool',
          value: 'n',
          visible: false,
        },
      ],
    });

    state = kconfigUiReducer(state, {
      type: 'SOLVE_START',
      requests: [{ symbol: 'NEG_B', value: 'y' }],
      ignorePins: false,
    });
    expect(state.solveModal.open).toBe(true);
    expect(state.solveModal.loading).toBe(true);

    state = kconfigUiReducer(state, {
      type: 'SOLVE_SUCCESS',
      response: {
        status: 'conflict',
        solveTimeMs: 4.2,
        changes: [],
        conflicts: [
          { kind: 'user_request', symbol: 'NEG_B', requested: 'y' },
          {
            kind: 'pinned_layer',
            symbol: 'NEG_A',
            pinnedValue: 'y',
            layerId: 'qemu',
            layerPath: 'configs/qemu.config',
          },
        ],
        diagnostics: ['Conflict with pinned layer qemu'],
      },
    });
    expect(state.solveModal.loading).toBe(false);
    expect(state.solveModal.response?.status).toBe('conflict');

    // Re-solve ignoring pins
    state = kconfigUiReducer(state, {
      type: 'SOLVE_START',
      requests: [{ symbol: 'NEG_B', value: 'y' }],
      ignorePins: true,
    });
    expect(state.solveModal.ignorePins).toBe(true);

    state = kconfigUiReducer(state, {
      type: 'SOLVE_SUCCESS',
      response: {
        status: 'ok',
        solveTimeMs: 3.1,
        changes: [
          { symbol: 'NEG_B', from: 'n', to: 'y', reason: 'user_request' },
          { symbol: 'NEG_A', from: 'y', to: 'n', reason: 'required_by:NEG_B' },
        ],
        conflicts: [],
        diagnostics: [],
      },
    });

    state = kconfigUiReducer(state, { type: 'APPLY_START' });
    expect(state.solveModal.applying).toBe(true);

    state = kconfigUiReducer(state, {
      type: 'APPLY_SUCCESS',
      applyResponse: { verified: true, mismatches: [], configureWarnings: [] },
      appliedChanges: [
        { symbol: 'NEG_B', value: 'y' },
        { symbol: 'NEG_A', value: 'n' },
      ],
    });
    expect(state.solveModal.open).toBe(false);
    expect(state.rootNodes[0].value).toBe('y');
  });

  it('keeps modal open and records mismatches when applyResponse.verified is false', () => {
    let state = kconfigUiReducer(initialUiState, {
      type: 'SOLVE_START',
      requests: [{ symbol: 'FOO', value: 'y' }],
    });
    state = kconfigUiReducer(state, {
      type: 'APPLY_SUCCESS',
      applyResponse: {
        verified: false,
        mismatches: [{ symbol: 'FOO', expected: 'y', actual: 'n' }],
        configureWarnings: ['WARNING: dropped'],
      },
      appliedChanges: [{ symbol: 'FOO', value: 'y' }],
    });
    expect(state.solveModal.open).toBe(true);
    expect(state.solveModal.applyResponse?.verified).toBe(false);
  });

  it('preserves expandedMenuIds when EXTERNAL_CONFIG_CHANGED is dispatched', () => {
    let state = kconfigUiReducer(initialUiState, {
      type: 'TOGGLE_MENU_EXPAND',
      menuId: 'menu_net',
    });
    expect(state.expandedMenuIds).toEqual(['menu_net']);

    state = kconfigUiReducer(state, {
      type: 'EXTERNAL_CONFIG_CHANGED',
      changedAt: 123456,
    });
    expect(state.expandedMenuIds).toEqual(['menu_net']);
    expect(state.lastExternalChangeAt).toBe(123456);
  });
});
