// @vitest-environment jsdom
import React, { act } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  HostToWebviewMessage,
  WebviewToHostMessage,
} from '../../src/shared/protocol';
import { App } from '../../webview-ui/src/App';
import { setMockVsCodeApi } from '../../webview-ui/src/vscodeApi';

function dispatchHostMessage(msg: HostToWebviewMessage) {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data: msg }));
  });
}

describe('Layer 3b: Webview React Component Interaction Tests', () => {
  let postedMessages: WebviewToHostMessage[] = [];

  beforeEach(() => {
    postedMessages = [];
    setMockVsCodeApi({
      postMessage: (msg) => {
        postedMessages.push(msg);
      },
      getState: () => undefined,
      setState: (s) => s,
    });
  });

  afterEach(() => {
    cleanup();
    setMockVsCodeApi(null);
  });

  it('toggles a dimmed symbol, previews diff in SolveModal, resolves pinned conflicts, and applies', async () => {
    render(<App />);

    // App sends { type: 'ready' } on mount
    expect(postedMessages[0]).toEqual({ type: 'ready' });

    // Host sends initState
    dispatchHostMessage({
      type: 'initState',
      status: 'ready',
      baseTarget: 'defconfig',
      layers: [
        { id: 'qemu', path: 'configs/qemu.config', enabled: true, pinned: true, symbolCount: 2 },
        { id: 'solver', path: 'configs/solver_overlay.config', enabled: true, pinned: false, readonly: true },
      ],
      rootNodes: [
        {
          id: 'sym_lin_c',
          kind: 'symbol',
          name: 'LIN_C',
          prompt: 'Linear C (dependency blocked)',
          type: 'bool',
          value: 'n',
          visible: false,
        },
        {
          id: 'sym_neg_b',
          kind: 'symbol',
          name: 'NEG_B',
          prompt: 'Negation B',
          type: 'bool',
          value: 'n',
          visible: false,
        },
      ],
    });

    await waitFor(() => {
      expect(screen.getByTestId('kconfig-app')).toBeDefined();
    });

    // Click [Y] on dimmed symbol LIN_C
    const btnLinCY = screen.getByTestId('btn-LIN_C-y');
    fireEvent.click(btnLinCY);

    const solveMsg = postedMessages.find(
      (m) => m.type === 'solve'
    ) as Extract<WebviewToHostMessage, { type: 'solve' }>;
    expect(solveMsg).toBeDefined();
    expect(solveMsg.requests).toEqual([{ symbol: 'LIN_C', value: 'y' }]);
    expect(solveMsg.ignorePins).toBe(false);

    // Host responds with conflict against pinned layer 'qemu'
    dispatchHostMessage({
      type: 'response',
      reqId: solveMsg.reqId,
      ok: true,
      payload: {
        status: 'conflict',
        solveTimeMs: 2.5,
        changes: [],
        conflicts: [
          { kind: 'user_request', symbol: 'LIN_C', requested: 'y' },
          {
            kind: 'pinned_layer',
            symbol: 'NEG_A',
            pinnedValue: 'y',
            layerId: 'qemu',
            layerPath: 'configs/qemu.config',
          },
        ],
        diagnostics: ['Request conflicts with pinned layer qemu'],
      },
    });

    await waitFor(() => {
      expect(screen.getByTestId('conflict-details')).toBeDefined();
    });

    // Click "Re-solve Ignoring Pins"
    const ignorePinsBtn = screen.getByTestId('resolve-ignore-pins-btn');
    fireEvent.click(ignorePinsBtn);

    const resolveIgnoreMsg = postedMessages
      .filter((m) => m.type === 'solve')
      .pop() as Extract<WebviewToHostMessage, { type: 'solve' }>;
    expect(resolveIgnoreMsg.ignorePins).toBe(true);

    // Host responds with status: 'ok' and prerequisite diff
    dispatchHostMessage({
      type: 'response',
      reqId: resolveIgnoreMsg.reqId,
      ok: true,
      payload: {
        status: 'ok',
        solveTimeMs: 3.2,
        changes: [
          { symbol: 'LIN_C', from: 'n', to: 'y', reason: 'user_request' },
          { symbol: 'LIN_B', from: 'n', to: 'y', reason: 'required_by:LIN_C' },
          { symbol: 'LIN_A', from: 'n', to: 'y', reason: 'required_by:LIN_B' },
        ],
        conflicts: [],
        diagnostics: [],
      },
    });

    await waitFor(() => {
      expect(screen.getByTestId('diff-row-LIN_C')).toBeDefined();
      expect(screen.getByTestId('diff-row-LIN_B')).toBeDefined();
      expect(screen.getByTestId('diff-row-LIN_A')).toBeDefined();
    });

    // Click "Apply & Sync #ifdef"
    const applyBtn = screen.getByTestId('modal-apply-btn');
    fireEvent.click(applyBtn);

    const applyMsg = postedMessages.find(
      (m) => m.type === 'apply'
    ) as Extract<WebviewToHostMessage, { type: 'apply' }>;
    expect(applyMsg).toBeDefined();
    expect(applyMsg.changes).toEqual([
      { symbol: 'LIN_C', value: 'y' },
      { symbol: 'LIN_B', value: 'y' },
      { symbol: 'LIN_A', value: 'y' },
    ]);

    // Host returns verified: true
    dispatchHostMessage({
      type: 'response',
      reqId: applyMsg.reqId,
      ok: true,
      payload: {
        verified: true,
        mismatches: [],
        configureWarnings: [],
      },
    });

    await waitFor(() => {
      expect(screen.queryByTestId('solve-modal')).toBeNull();
    });
  });
});
