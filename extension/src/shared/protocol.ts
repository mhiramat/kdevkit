export type TriVal = 'n' | 'm' | 'y';
export type SymType = 'bool' | 'tristate' | 'int' | 'hex' | 'string' | 'unknown';

export interface ConfigLayer {
  id: string;
  path: string;
  enabled: boolean;
  pinned: boolean;
  readonly?: boolean;
  symbolCount?: number;
  exists?: boolean;
}

export interface LayersPayload {
  version: number;
  baseTarget: string;
  base_target?: string;
  layers: ConfigLayer[];
}

export interface KconfigNode {
  id: string;
  kind: 'menu' | 'symbol' | 'choice' | 'comment';
  name: string | null;
  prompt: string;
  type?: SymType | 'menu';
  value?: string;
  visible: boolean;
  pinnedBy?: string | null;
  hasChildren?: boolean;
}

export interface SearchItem {
  symbol: string;
  prompt: string;
  type: SymType;
  value: string;
  visible: boolean;
  pinnedBy: string | null;
  matchLocation: string;
  menuPath: string[];
}

export interface SymbolEdge {
  symbol: string;
  condition: string;
}

export interface SymbolDetail {
  symbol: string;
  prompt: string;
  prompts: Array<{ text: string; condition: string }>;
  help: string;
  value: string;
  type: SymType;
  visible: boolean;
  pinnedBy: string | null;
  directDepText: string;
  selects: SymbolEdge[];
  selectedBy: SymbolEdge[];
  menuPath: string[];
  choiceId: string | null;
}

export interface SolveChange {
  symbol: string;
  from: string;
  to: string;
  oldValue?: string;
  newValue?: string;
  reason: string;
}

export interface SolveConflict {
  kind: 'user_request' | 'pinned_layer';
  symbol: string;
  requested?: string;
  pinnedValue?: string;
  layerId?: string;
  layerPath?: string;
}

export interface SolveResponse {
  status: 'ok' | 'conflict';
  solveTimeMs: number;
  changes: SolveChange[];
  conflicts: SolveConflict[];
  diagnostics: string[];
  warnings?: string[];
}

export interface ApplyResponse {
  verified: boolean;
  mismatches: Array<{ symbol: string; expected: string; actual: string }>;
  configureWarnings: string[];
  overlayPath?: string;
}

export interface InitResponse {
  symbolCount: number;
  choiceCount: number;
  initTimeMs: number;
  encodeTimeMs: number;
  warnings: string[];
  layers: LayersPayload;
}

export type BackendLifecycleState = 'starting' | 'running' | 'restarting' | 'stopped';

// Webview -> Extension Host
export type WebviewToHostMessage =
  | { type: 'ready' }
  | { type: 'getTree'; reqId: string; parentId: string | null }
  | { type: 'search'; reqId: string; query: string; limit?: number; onlyChanged?: boolean }
  | { type: 'getSymbolDetail'; reqId: string; symbol: string }
  | { type: 'solve'; reqId: string; requests: Array<{ symbol: string; value: string }>; ignorePins?: boolean }
  | { type: 'apply'; reqId: string; changes: Array<{ symbol: string; value: string }> }
  | { type: 'updateLayers'; reqId: string; baseTarget: string; layers: ConfigLayer[]; applyNow?: boolean }
  | { type: 'pickAndInjectLayer'; reqId: string; copyIntoWorkspace: boolean }
  | { type: 'resetSolverOverlay'; reqId: string }
  | { type: 'reloadAll'; reqId: string };

// Extension Host -> Webview
export type HostToWebviewMessage =
  | {
      type: 'initState';
      status: 'loading' | 'ready' | 'error';
      error?: string;
      stats?: { symbolCount: number; initTimeMs: number; warnings: string[] };
      baseTarget?: string;
      layers?: ConfigLayer[];
      rootNodes?: KconfigNode[];
    }
  | { type: 'response'; reqId: string; ok: true; payload: unknown }
  | { type: 'response'; reqId: string; ok: false; error: { code: number; message: string; data?: unknown } }
  | { type: 'externalConfigChanged'; changedAt: number }
  | { type: 'backendStatus'; state: BackendLifecycleState; message?: string }
  | {
      type: 'openSolvePreview';
      requests: Array<{ symbol: string; value: string }>;
      response: SolveResponse;
    };
