import {
  ApplyResponse,
  BackendLifecycleState,
  ConfigLayer,
  KconfigNode,
  SearchItem,
  SolveResponse,
  SymbolDetail,
} from '../../../src/shared/protocol';

export interface SolveModalState {
  open: boolean;
  loading: boolean;
  applying: boolean;
  requests: Array<{ symbol: string; value: string }>;
  ignorePins: boolean;
  response: SolveResponse | null;
  applyResponse: ApplyResponse | null;
  error: string | null;
}

export interface KconfigUiState {
  status: 'loading' | 'ready' | 'error';
  error?: string;
  backendState: BackendLifecycleState;
  backendMessage?: string;
  stats?: {
    symbolCount: number;
    initTimeMs: number;
    warnings: string[];
  };
  baseTarget: string;
  layers: ConfigLayer[];
  rootNodes: KconfigNode[];
  treeCache: Record<string, KconfigNode[]>;
  expandedMenuIds: string[];
  selectedMenuId: string | null;
  selectedSymbol: string | null;
  symbolDetail: SymbolDetail | null;
  searchQuery: string;
  onlyChanged: boolean;
  searchResults: SearchItem[] | null;
  solveModal: SolveModalState;
  lastExternalChangeAt: number | null;
}

export const initialSolveModalState: SolveModalState = {
  open: false,
  loading: false,
  applying: false,
  requests: [],
  ignorePins: false,
  response: null,
  applyResponse: null,
  error: null,
};

export const initialUiState: KconfigUiState = {
  status: 'loading',
  backendState: 'starting',
  baseTarget: 'defconfig',
  layers: [],
  rootNodes: [],
  treeCache: {},
  expandedMenuIds: [],
  selectedMenuId: null,
  selectedSymbol: null,
  symbolDetail: null,
  searchQuery: '',
  onlyChanged: false,
  searchResults: null,
  solveModal: initialSolveModalState,
  lastExternalChangeAt: null,
};

export type KconfigUiAction =
  | {
      type: 'INIT_STATE';
      status: 'loading' | 'ready' | 'error';
      error?: string;
      stats?: { symbolCount: number; initTimeMs: number; warnings: string[] };
      baseTarget?: string;
      layers?: ConfigLayer[];
      rootNodes?: KconfigNode[];
    }
  | { type: 'BACKEND_STATUS'; state: BackendLifecycleState; message?: string }
  | { type: 'TREE_LOADED'; parentId: string | null; nodes: KconfigNode[] }
  | { type: 'TOGGLE_MENU_EXPAND'; menuId: string }
  | { type: 'SELECT_MENU'; menuId: string | null }
  | { type: 'SELECT_SYMBOL'; symbol: string | null; detail?: SymbolDetail | null }
  | { type: 'SYMBOL_DETAIL_LOADED'; detail: SymbolDetail }
  | { type: 'SET_SEARCH'; query: string; onlyChanged: boolean }
  | { type: 'SEARCH_RESULTS_LOADED'; items: SearchItem[] | null }
  | { type: 'LAYERS_UPDATED'; baseTarget: string; layers: ConfigLayer[] }
  | {
      type: 'SOLVE_START';
      requests: Array<{ symbol: string; value: string }>;
      ignorePins?: boolean;
    }
  | { type: 'SOLVE_SUCCESS'; response: SolveResponse }
  | { type: 'SOLVE_ERROR'; error: string }
  | { type: 'SOLVE_CLOSE' }
  | { type: 'APPLY_START' }
  | {
      type: 'APPLY_SUCCESS';
      applyResponse: ApplyResponse;
      appliedChanges: Array<{ symbol: string; value: string }>;
    }
  | { type: 'APPLY_ERROR'; error: string }
  | { type: 'EXTERNAL_CONFIG_CHANGED'; changedAt: number };

function patchNodeValues(
  nodes: KconfigNode[],
  changeMap: Map<string, string>
): KconfigNode[] {
  return nodes.map((node) => {
    if (node.kind === 'symbol' && node.name && changeMap.has(node.name)) {
      return { ...node, value: changeMap.get(node.name)! };
    }
    return node;
  });
}

export function kconfigUiReducer(
  state: KconfigUiState,
  action: KconfigUiAction
): KconfigUiState {
  switch (action.type) {
    case 'INIT_STATE': {
      const rootNodes = action.rootNodes ?? state.rootNodes;
      const firstMenu = rootNodes.find((n) => n.kind === 'menu')?.id ?? null;
      return {
        ...state,
        status: action.status,
        error: action.error,
        backendState: action.status === 'ready' ? 'running' : state.backendState,
        stats: action.stats ?? state.stats,
        baseTarget: action.baseTarget ?? state.baseTarget,
        layers: action.layers ?? state.layers,
        rootNodes,
        selectedMenuId: state.selectedMenuId ?? firstMenu,
      };
    }

    case 'BACKEND_STATUS':
      return {
        ...state,
        backendState: action.state,
        backendMessage: action.message,
      };

    case 'TREE_LOADED': {
      if (action.parentId === null) {
        return { ...state, rootNodes: action.nodes };
      }
      return {
        ...state,
        treeCache: {
          ...state.treeCache,
          [action.parentId]: action.nodes,
        },
      };
    }

    case 'TOGGLE_MENU_EXPAND': {
      const exists = state.expandedMenuIds.includes(action.menuId);
      const nextExpanded = exists
        ? state.expandedMenuIds.filter((id) => id !== action.menuId)
        : [...state.expandedMenuIds, action.menuId];
      return {
        ...state,
        expandedMenuIds: nextExpanded,
        selectedMenuId: action.menuId,
      };
    }

    case 'SELECT_MENU':
      return {
        ...state,
        selectedMenuId: action.menuId,
      };

    case 'SELECT_SYMBOL':
      return {
        ...state,
        selectedSymbol: action.symbol,
        symbolDetail: action.detail !== undefined ? action.detail : state.symbolDetail,
      };

    case 'SYMBOL_DETAIL_LOADED':
      return {
        ...state,
        selectedSymbol: action.detail.symbol,
        symbolDetail: action.detail,
      };

    case 'SET_SEARCH':
      return {
        ...state,
        searchQuery: action.query,
        onlyChanged: action.onlyChanged,
        searchResults:
          !action.query.trim() && !action.onlyChanged ? null : state.searchResults,
      };

    case 'SEARCH_RESULTS_LOADED':
      return {
        ...state,
        searchResults: action.items,
      };

    case 'LAYERS_UPDATED':
      return {
        ...state,
        baseTarget: action.baseTarget,
        layers: action.layers,
      };

    case 'SOLVE_START':
      return {
        ...state,
        solveModal: {
          open: true,
          loading: true,
          applying: false,
          requests: action.requests,
          ignorePins: action.ignorePins ?? false,
          response: null,
          applyResponse: null,
          error: null,
        },
      };

    case 'SOLVE_SUCCESS':
      return {
        ...state,
        solveModal: {
          ...state.solveModal,
          loading: false,
          response: action.response,
          error: null,
        },
      };

    case 'SOLVE_ERROR':
      return {
        ...state,
        solveModal: {
          ...state.solveModal,
          loading: false,
          error: action.error,
        },
      };

    case 'SOLVE_CLOSE':
      return {
        ...state,
        solveModal: initialSolveModalState,
      };

    case 'APPLY_START':
      return {
        ...state,
        solveModal: {
          ...state.solveModal,
          applying: true,
          error: null,
        },
      };

    case 'APPLY_SUCCESS': {
      const changeMap = new Map<string, string>();
      for (const c of action.appliedChanges) {
        changeMap.set(c.symbol, c.value);
      }

      const patchedRoot = patchNodeValues(state.rootNodes, changeMap);
      const patchedCache: Record<string, KconfigNode[]> = {};
      for (const [pid, nodes] of Object.entries(state.treeCache)) {
        patchedCache[pid] = patchNodeValues(nodes, changeMap);
      }

      const patchedSearch = state.searchResults
        ? state.searchResults.map((item) =>
            changeMap.has(item.symbol)
              ? { ...item, value: changeMap.get(item.symbol)! }
              : item
          )
        : null;

      const patchedDetail =
        state.symbolDetail && changeMap.has(state.symbolDetail.symbol)
          ? {
              ...state.symbolDetail,
              value: changeMap.get(state.symbolDetail.symbol)!,
            }
          : state.symbolDetail;

      const hasMismatches =
        !action.applyResponse.verified && action.applyResponse.mismatches.length > 0;

      return {
        ...state,
        rootNodes: patchedRoot,
        treeCache: patchedCache,
        searchResults: patchedSearch,
        symbolDetail: patchedDetail,
        solveModal: hasMismatches
          ? {
              ...state.solveModal,
              applying: false,
              applyResponse: action.applyResponse,
            }
          : initialSolveModalState,
      };
    }

    case 'APPLY_ERROR':
      return {
        ...state,
        solveModal: {
          ...state.solveModal,
          applying: false,
          error: action.error,
        },
      };

    case 'EXTERNAL_CONFIG_CHANGED':
      return {
        ...state,
        lastExternalChangeAt: action.changedAt,
      };

    default:
      return state;
  }
}
