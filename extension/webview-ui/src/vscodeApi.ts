import { HostToWebviewMessage, WebviewToHostMessage } from '../../src/shared/protocol';

export interface VsCodeWebviewApi {
  postMessage(message: WebviewToHostMessage): void;
  getState<T = unknown>(): T | undefined;
  setState<T = unknown>(newState: T): T;
}

declare global {
  function acquireVsCodeApi(): VsCodeWebviewApi;
}

let cachedApi: VsCodeWebviewApi | null = null;

export function setMockVsCodeApi(mockApi: VsCodeWebviewApi | null): void {
  cachedApi = mockApi;
}

export function getVsCodeApi(): VsCodeWebviewApi {
  if (cachedApi) {
    return cachedApi;
  }
  if (typeof acquireVsCodeApi === 'function') {
    cachedApi = acquireVsCodeApi();
    return cachedApi;
  }
  let memoryState: unknown;
  cachedApi = {
    postMessage: () => {},
    getState: <T>() => memoryState as T | undefined,
    setState: <T>(s: T) => {
      memoryState = s;
      return s;
    },
  };
  return cachedApi;
}

export function postToHost(message: WebviewToHostMessage): void {
  getVsCodeApi().postMessage(message);
}

export function addHostMessageListener(
  listener: (message: HostToWebviewMessage) => void
): () => void {
  const handler = (event: MessageEvent<HostToWebviewMessage>) => {
    if (event.data && typeof event.data === 'object' && 'type' in event.data) {
      listener(event.data);
    }
  };
  window.addEventListener('message', handler);
  return () => window.removeEventListener('message', handler);
}
