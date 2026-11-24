import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { McpStdioClient, McpTimeoutError, McpToolError } from '../../src/mcp/mcpClient';

describe('McpStdioClient (Layer 3 unit)', () => {
  let tmpDir: string;
  let mockServerScript: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kdev-mcp-unit-'));
    mockServerScript = path.join(tmpDir, 'mock-mcp.js');
    fs.writeFileSync(
      mockServerScript,
      `
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    process.stderr.write('diagnostic log on stderr\\n');
    const resp = JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} } } }) + '\\n';
    // Split response into two chunks to test chunked NDJSON framing
    process.stdout.write(resp.slice(0, 15));
    setTimeout(() => process.stdout.write(resp.slice(15)), 10);
  } else if (msg.method === 'tools/list') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'echo' }] } }) + '\\n');
  } else if (msg.method === 'tools/call') {
    const { name, arguments: args } = msg.params;
    if (name === 'slow') {
      setTimeout(() => {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: '{"ok":true}' }] } }) + '\\n');
      }, 400);
    } else if (name === 'fail_tool') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { isError: true, content: [{ type: 'text', text: 'bad input' }] } }) + '\\n');
    } else if (name === 'crash') {
      process.exit(2);
    } else {
      const delay = args.delayMs || 0;
      setTimeout(() => {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify({ echoed: args.value }) }] } }) + '\\n');
      }, delay);
    }
  }
});
`,
      'utf-8'
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('handles chunked NDJSON, out-of-order request correlation, and stderr isolation', async () => {
    const logs: string[] = [];
    const client = new McpStdioClient({
      command: process.execPath,
      args: [mockServerScript],
      logger: (l) => logs.push(l),
    });

    try {
      const tools = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual(['echo']);

      const [r1, r2] = await Promise.all([
        client.callTool<{ echoed: string }>('echo', { value: 'first', delayMs: 60 }),
        client.callTool<{ echoed: string }>('echo', { value: 'second', delayMs: 5 }),
      ]);
      expect(r1.echoed).toBe('first');
      expect(r2.echoed).toBe('second');
      expect(logs.some((l) => l.includes('diagnostic log on stderr'))).toBe(true);
    } finally {
      await client.dispose();
    }
  });

  it('rejects with McpTimeoutError on timeout and McpToolError on tool error', async () => {
    const client = new McpStdioClient({
      command: process.execPath,
      args: [mockServerScript],
      requestTimeoutMs: 100,
    });

    try {
      await expect(client.callTool('slow', {}, 80)).rejects.toBeInstanceOf(McpTimeoutError);
      await expect(client.callTool('fail_tool', {})).rejects.toBeInstanceOf(McpToolError);
    } finally {
      await client.dispose();
    }
  });

  it('recovers cleanly after server crash via automatic restart', async () => {
    const client = new McpStdioClient({
      command: process.execPath,
      args: [mockServerScript],
    });

    try {
      await client.ensureStarted();
      await expect(client.callTool('crash', {})).rejects.toThrow();
      expect(client.isRunning()).toBe(false);

      // Next call automatically restarts and succeeds
      const res = await client.callTool<{ echoed: string }>('echo', { value: 'recovered' });
      expect(res.echoed).toBe('recovered');
    } finally {
      await client.dispose();
    }
  });
});
