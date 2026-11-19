import { describe, expect, it } from 'vitest';
import {
  KconfigRpcClient,
  RpcProcessExitedError,
  RpcTimeoutError,
} from '../../src/kconfig/rpcClient';
import { BackendLifecycleState } from '../../src/shared/protocol';

const STUB_SCRIPT = `
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const delayedTimers = [];

rl.on('line', (line) => {
  if (!line.trim()) return;
  const req = JSON.parse(line);
  const { id, method, params } = req;

  if (method === 'test/chunked') {
    const full = JSON.stringify({ jsonrpc: '2.0', id, result: { ok: 'chunked', echo: params.val } }) + '\\n';
    const part1 = full.slice(0, 12);
    const part2 = full.slice(12, 28);
    const part3 = full.slice(28);
    process.stdout.write(part1);
    setTimeout(() => process.stdout.write(part2), 10);
    setTimeout(() => process.stdout.write(part3), 20);
  } else if (method === 'test/delay') {
    const delayMs = params.delayMs || 50;
    const t = setTimeout(() => {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result: { id, tag: params.tag } }) + '\\n');
    }, delayMs);
    delayedTimers.push(t);
  } else if (method === 'test/stderr') {
    process.stderr.write('[stub-warn] warning line 1\\n');
    process.stderr.write('[stub-warn] traceback line 2\\n');
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result: { clean: true } }) + '\\n');
  } else if (method === 'test/crash') {
    process.exit(137);
  } else if (method === 'kconfig/init') {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id,
      result: {
        symbolCount: 5,
        choiceCount: 1,
        initTimeMs: 1.0,
        encodeTimeMs: 1.0,
        warnings: [],
        layers: { version: 1, baseTarget: 'defconfig', layers: [] }
      }
    }) + '\\n');
  } else {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result: { method, params } }) + '\\n');
  }
});

rl.on('close', () => {
  for (const t of delayedTimers) clearTimeout(t);
  process.exit(0);
});
`;

function createStubClient(overrides: Partial<ConstructorParameters<typeof KconfigRpcClient>[0]> = {}) {
  return new KconfigRpcClient({
    pythonPath: process.execPath,
    args: ['-e', STUB_SCRIPT],
    workspaceRoot: process.cwd(),
    timeouts: { defaultMs: 300, initMs: 1000, applyMs: 1000 },
    ...overrides,
  });
}

describe('Layer 1: KconfigRpcClient Protocol & Transport Unit Tests', () => {
  it('handles chunked / split NDJSON and multiple responses cleanly', async () => {
    const client = createStubClient();
    try {
      const r1 = await client.request<{ ok: string; echo: number }>('test/chunked', {
        val: 42,
      });
      const r2 = await client.request<{ method: string }>('test/echo', { a: 1 });
      expect(r1).toEqual({ ok: 'chunked', echo: 42 });
      expect(r2.method).toBe('test/echo');
    } finally {
      await client.dispose();
    }
  });

  it('correlates out-of-order responses by request id', async () => {
    const client = createStubClient();
    try {
      const pSlow = client.request<{ id: number; tag: string }>('test/delay', {
        delayMs: 80,
        tag: 'first-sent-slow',
      });
      const pFast = client.request<{ id: number; tag: string }>('test/delay', {
        delayMs: 10,
        tag: 'second-sent-fast',
      });

      const [resSlow, resFast] = await Promise.all([pSlow, pFast]);
      expect(resSlow.tag).toBe('first-sent-slow');
      expect(resFast.tag).toBe('second-sent-fast');
      expect(resSlow.id).toBeLessThan(resFast.id);
    } finally {
      await client.dispose();
    }
  });

  it('isolates stderr warnings from stdout JSON-RPC responses', async () => {
    const logs: string[] = [];
    const client = createStubClient({
      logger: (line) => logs.push(line),
    });
    try {
      const res = await client.request<{ clean: boolean }>('test/stderr', {});
      expect(res).toEqual({ clean: true });
      // Allow readline stderr flush
      await new Promise((r) => setTimeout(r, 30));
      expect(logs).toContain('[stub-warn] warning line 1');
      expect(logs).toContain('[stub-warn] traceback line 2');
    } finally {
      await client.dispose();
    }
  });

  it('rejects with RpcTimeoutError when request exceeds configured timeout', async () => {
    const client = createStubClient({
      timeouts: { defaultMs: 60 },
    });
    try {
      await expect(
        client.request('test/delay', { delayMs: 400, tag: 'too-slow' })
      ).rejects.toThrow(RpcTimeoutError);
    } finally {
      await client.dispose();
    }
  });

  it('detects daemon crash, emits stopped status, and recovers via restart()', async () => {
    const states: BackendLifecycleState[] = [];
    const client = createStubClient({
      onStatusChange: (s) => states.push(s),
    });
    try {
      await client.init({ workspaceRoot: process.cwd() });
      await expect(client.request('test/crash', {})).rejects.toThrow(
        RpcProcessExitedError
      );
      expect(states).toContain('stopped');

      const reinit = await client.restart();
      expect(reinit?.symbolCount).toBe(5);
      const afterRestart = await client.request<{ method: string }>('test/ping', {});
      expect(afterRestart.method).toBe('test/ping');
    } finally {
      await client.dispose();
    }
  });

  it('disposes gracefully by closing stdin without orphan processes', async () => {
    const client = createStubClient();
    await client.request('test/ping', {});
    expect(client.isRunning()).toBe(true);
    await client.dispose();
    expect(client.getState()).toBe('stopped');
    expect(client.isRunning()).toBe(false);
  });
});
