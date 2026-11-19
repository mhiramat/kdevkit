import React, { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import {
  ApplyResponse,
  ConfigLayer,
  HostToWebviewMessage,
  KconfigNode,
  LayersPayload,
  SearchItem,
  SolveResponse,
  SymbolDetail,
  TriVal,
} from '../../src/shared/protocol';
import { DetailPane } from './components/DetailPane';
import { LayerBar } from './components/LayerBar';
import { MenuTree } from './components/MenuTree';
import { SearchBar } from './components/SearchBar';
import { SolveModal } from './components/SolveModal';
import {
  nodesToSymbolRows,
  searchItemsToSymbolRows,
  SymbolList,
} from './components/SymbolList';
import { initialUiState, kconfigUiReducer } from './state/store';
import { addHostMessageListener, postToHost } from './vscodeApi';

export const App: React.FC = () => {
  const [state, dispatch] = useReducer(kconfigUiReducer, initialUiState);
  const reqCounterRef = useRef(1);
  const pendingHandlersRef = useRef<
    Map<
      string,
      {
        onSuccess: (payload: any) => void;
        onError?: (err: { code: number; message: string }) => void;
      }
    >
  >(new Map());

  const sendRequest = useCallback(
    (
      buildMsg: (reqId: string) => any,
      onSuccess: (payload: any) => void,
      onError?: (err: { code: number; message: string }) => void
    ) => {
      const reqId = `req_${reqCounterRef.current++}`;
      pendingHandlersRef.current.set(reqId, { onSuccess, onError });
      postToHost(buildMsg(reqId));
    },
    []
  );

  const refreshTreeAndLayers = useCallback(
    (expandedIds: string[]) => {
      sendRequest(
        (reqId) => ({ type: 'reloadAll', reqId }),
        (payload: {
          baseTarget: string;
          layers: ConfigLayer[];
          rootNodes: KconfigNode[];
        }) => {
          dispatch({
            type: 'LAYERS_UPDATED',
            baseTarget: payload.baseTarget,
            layers: payload.layers,
          });
          dispatch({
            type: 'TREE_LOADED',
            parentId: null,
            nodes: payload.rootNodes,
          });
          for (const menuId of expandedIds) {
            sendRequest(
              (reqId) => ({ type: 'getTree', reqId, parentId: menuId }),
              (treeRes: { nodes: KconfigNode[] }) => {
                dispatch({
                  type: 'TREE_LOADED',
                  parentId: menuId,
                  nodes: treeRes.nodes,
                });
              }
            );
          }
        }
      );
    },
    [sendRequest]
  );

  useEffect(() => {
    const unsubscribe = addHostMessageListener((msg: HostToWebviewMessage) => {
      switch (msg.type) {
        case 'initState':
          dispatch({
            type: 'INIT_STATE',
            status: msg.status,
            error: msg.error,
            stats: msg.stats,
            baseTarget: msg.baseTarget,
            layers: msg.layers,
            rootNodes: msg.rootNodes,
          });
          if (msg.status === 'ready' && msg.rootNodes && msg.rootNodes.length > 0) {
            const firstMenu = msg.rootNodes.find((n) => n.kind === 'menu');
            if (firstMenu) {
              sendRequest(
                (reqId) => ({ type: 'getTree', reqId, parentId: firstMenu.id }),
                (res: { nodes: KconfigNode[] }) => {
                  dispatch({
                    type: 'TREE_LOADED',
                    parentId: firstMenu.id,
                    nodes: res.nodes,
                  });
                }
              );
            }
          }
          break;

        case 'backendStatus':
          dispatch({
            type: 'BACKEND_STATUS',
            state: msg.state,
            message: msg.message,
          });
          break;

        case 'externalConfigChanged':
          dispatch({
            type: 'EXTERNAL_CONFIG_CHANGED',
            changedAt: msg.changedAt,
          });
          break;

        case 'response': {
          const handler = pendingHandlersRef.current.get(msg.reqId);
          pendingHandlersRef.current.delete(msg.reqId);
          if (!handler) {
            return;
          }
          if (msg.ok) {
            handler.onSuccess(msg.payload);
          } else {
            handler.onError?.(msg.error);
          }
          break;
        }
      }
    });

    postToHost({ type: 'ready' });
    return unsubscribe;
  }, [sendRequest]);

  // Trigger refresh when externalConfigChanged arrives without losing expanded menus
  useEffect(() => {
    if (state.lastExternalChangeAt !== null) {
      refreshTreeAndLayers(state.expandedMenuIds);
    }
  }, [state.lastExternalChangeAt]);

  const handleToggleMenu = useCallback(
    (menuId: string) => {
      dispatch({ type: 'TOGGLE_MENU_EXPAND', menuId });
      if (!state.treeCache[menuId]) {
        sendRequest(
          (reqId) => ({ type: 'getTree', reqId, parentId: menuId }),
          (res: { nodes: KconfigNode[] }) => {
            dispatch({
              type: 'TREE_LOADED',
              parentId: menuId,
              nodes: res.nodes,
            });
          }
        );
      }
    },
    [sendRequest, state.treeCache]
  );

  const handleSelectSymbol = useCallback(
    (symbol: string) => {
      dispatch({ type: 'SELECT_SYMBOL', symbol });
      sendRequest(
        (reqId) => ({ type: 'getSymbolDetail', reqId, symbol }),
        (detail: SymbolDetail) => {
          dispatch({ type: 'SYMBOL_DETAIL_LOADED', detail });
        }
      );
    },
    [sendRequest]
  );

  const handleSearchChange = useCallback(
    (query: string, onlyChanged: boolean) => {
      dispatch({ type: 'SET_SEARCH', query, onlyChanged });
      if (!query.trim() && !onlyChanged) {
        return;
      }
      sendRequest(
        (reqId) => ({
          type: 'search',
          reqId,
          query,
          limit: 100,
          onlyChanged,
        }),
        (res: { items: SearchItem[] }) => {
          dispatch({ type: 'SEARCH_RESULTS_LOADED', items: res.items });
        }
      );
    },
    [sendRequest]
  );

  const runSolve = useCallback(
    (requests: Array<{ symbol: string; value: string }>, ignorePins: boolean) => {
      dispatch({ type: 'SOLVE_START', requests, ignorePins });
      sendRequest(
        (reqId) => ({
          type: 'solve',
          reqId,
          requests,
          ignorePins,
        }),
        (res: SolveResponse) => {
          dispatch({ type: 'SOLVE_SUCCESS', response: res });
        },
        (err) => {
          dispatch({ type: 'SOLVE_ERROR', error: err.message });
        }
      );
    },
    [sendRequest]
  );

  const handleRequestSolve = useCallback(
    (symbol: string, value: TriVal) => {
      runSolve([{ symbol, value }], false);
    },
    [runSolve]
  );

  const handleResolveIgnoringPins = useCallback(() => {
    if (state.solveModal.requests.length > 0) {
      runSolve(state.solveModal.requests, true);
    }
  }, [runSolve, state.solveModal.requests]);

  const handleApplyChanges = useCallback(
    (changes: Array<{ symbol: string; value: string }>) => {
      dispatch({ type: 'APPLY_START' });
      sendRequest(
        (reqId) => ({ type: 'apply', reqId, changes }),
        (res: ApplyResponse) => {
          dispatch({
            type: 'APPLY_SUCCESS',
            applyResponse: res,
            appliedChanges: changes,
          });
        },
        (err) => {
          dispatch({ type: 'APPLY_ERROR', error: err.message });
        }
      );
    },
    [sendRequest]
  );

  const handleUpdateLayers = useCallback(
    (baseTarget: string, layers: ConfigLayer[], applyNow = false) => {
      sendRequest(
        (reqId) => ({
          type: 'updateLayers',
          reqId,
          baseTarget,
          layers,
          applyNow,
        }),
        (res: LayersPayload) => {
          dispatch({
            type: 'LAYERS_UPDATED',
            baseTarget: res.baseTarget || res.base_target || baseTarget,
            layers: res.layers,
          });
        }
      );
    },
    [sendRequest]
  );

  const handleInjectLayer = useCallback(() => {
    sendRequest(
      (reqId) => ({
        type: 'pickAndInjectLayer',
        reqId,
        copyIntoWorkspace: true,
      }),
      (res: { canceled: boolean; baseTarget?: string; layers?: ConfigLayer[] }) => {
        if (!res.canceled && res.layers) {
          dispatch({
            type: 'LAYERS_UPDATED',
            baseTarget: res.baseTarget ?? state.baseTarget,
            layers: res.layers,
          });
        }
      }
    );
  }, [sendRequest, state.baseTarget]);

  const handleResetSolverOverlay = useCallback(() => {
    sendRequest(
      (reqId) => ({ type: 'resetSolverOverlay', reqId }),
      () => {
        refreshTreeAndLayers(state.expandedMenuIds);
      }
    );
  }, [refreshTreeAndLayers, sendRequest, state.expandedMenuIds]);

  const displayedSymbolItems = useMemo(() => {
    if (state.searchResults !== null) {
      return searchItemsToSymbolRows(state.searchResults);
    }
    const activeNodes =
      state.selectedMenuId && state.treeCache[state.selectedMenuId]
        ? state.treeCache[state.selectedMenuId]
        : state.rootNodes;
    return nodesToSymbolRows(activeNodes);
  }, [
    state.rootNodes,
    state.searchResults,
    state.selectedMenuId,
    state.treeCache,
  ]);

  if (state.status === 'loading') {
    return (
      <div className="kdev-app" style={{ padding: 24 }} data-testid="loading-screen">
        <h3>Initializing Linux Kernel Kconfig Backend...</h3>
        <p>Parsing Kconfig tree and compiling base SAT CNF clauses.</p>
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <div className="kdev-app" style={{ padding: 24 }} data-testid="error-screen">
        <h3>Kconfig Initialization Failed</h3>
        <p style={{ color: 'var(--kdev-err-fg)' }}>{state.error}</p>
      </div>
    );
  }

  return (
    <div className="kdev-app" data-testid="kconfig-app">
      <LayerBar
        baseTarget={state.baseTarget}
        layers={state.layers}
        onUpdateLayers={handleUpdateLayers}
        onInjectLayer={handleInjectLayer}
        onResetSolverOverlay={handleResetSolverOverlay}
        onReload={() => refreshTreeAndLayers(state.expandedMenuIds)}
      />

      <SearchBar
        query={state.searchQuery}
        onlyChanged={state.onlyChanged}
        onSearchChange={handleSearchChange}
      />

      <div className="kdev-main-grid">
        <MenuTree
          rootNodes={state.rootNodes}
          treeCache={state.treeCache}
          expandedMenuIds={state.expandedMenuIds}
          selectedMenuId={state.selectedMenuId}
          onToggleMenu={handleToggleMenu}
          onSelectSymbol={handleSelectSymbol}
        />

        <SymbolList
          items={displayedSymbolItems}
          selectedSymbol={state.selectedSymbol}
          onSelectSymbol={handleSelectSymbol}
          onRequestSolve={handleRequestSolve}
          onApplyNonBool={(symbol, value) =>
            handleApplyChanges([{ symbol, value }])
          }
        />

        <DetailPane
          detail={state.symbolDetail}
          onSelectSymbol={handleSelectSymbol}
        />
      </div>

      <SolveModal
        modal={state.solveModal}
        onClose={() => dispatch({ type: 'SOLVE_CLOSE' })}
        onApply={handleApplyChanges}
        onResolveIgnoringPins={handleResolveIgnoringPins}
      />
    </div>
  );
};
