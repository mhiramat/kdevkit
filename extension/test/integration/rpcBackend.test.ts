import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { KconfigRpcClient } from '../../src/kconfig/rpcClient';

const WS_ROOT = path.resolve(__dirname, '..', '..', '..');
const PYTHON_BIN = path.join(WS_ROOT, 'backend', '.venv', 'bin', 'python');
const FIXTURE_KCONFIG = path.join(
  WS_ROOT,
  'backend',
  'tests',
  'fixtures',
  'Kconfig.synthetic'
);

function createTempSyntheticWorkspace(): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kdev-ipc-test-'));
  const kernelDir = path.join(tmpDir, 'linux');
  const buildDir = path.join(tmpDir, 'build', 'current');
  const configsDir = path.join(tmpDir, 'configs');
  const scriptsDir = path.join(tmpDir, 'scripts');

  fs.mkdirSync(kernelDir, { recursive: true });
  fs.mkdirSync(buildDir, { recursive: true });
  fs.mkdirSync(configsDir, { recursive: true });
  fs.mkdirSync(scriptsDir, { recursive: true });

  fs.copyFileSync(FIXTURE_KCONFIG, path.join(kernelDir, 'Kconfig'));
  fs.writeFileSync(path.join(configsDir, 'qemu.config'), 'CONFIG_NEG_A=y\n', 'utf8');
  fs.writeFileSync(path.join(configsDir, 'trace.config'), '', 'utf8');
  fs.writeFileSync(path.join(buildDir, 'solver_overlay.config'), '', 'utf8');
  fs.writeFileSync(
    path.join(buildDir, '.config'),
    'CONFIG_NEG_A=y\nCONFIG_CHOICE_OPT_1=y\n',
    'utf8'
  );

  // Stub scripts/configure.sh that merges passed fragments into build/current/.config
  const stubConfigure = `#!/usr/bin/env bash
set -euo pipefail
mkdir -p "\${BUILD_DIR}"
cat "\$@" > "\${BUILD_DIR}/.config"
`;
  const configurePath = path.join(scriptsDir, 'configure.sh');
  fs.writeFileSync(configurePath, stubConfigure, { encoding: 'utf8', mode: 0o755 });

  return tmpDir;
}

describe('Layer 2: Real Node KconfigRpcClient <-> Real Python kconfig_server Integration Tests', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const d of tempDirs.splice(0)) {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  it('executes full init -> tree -> search -> detail -> solve -> conflict -> apply round-trip', async () => {
    const tmpWs = createTempSyntheticWorkspace();
    tempDirs.push(tmpWs);

    const client = new KconfigRpcClient({
      pythonPath: PYTHON_BIN,
      workspaceRoot: WS_ROOT,
    });

    try {
      // 1. Handshake & Tree Traversal
      const initRes = await client.init({
        workspaceRoot: tmpWs,
        kernelDir: path.join(tmpWs, 'linux'),
        buildDir: path.join(tmpWs, 'build', 'current'),
        layersJsonPath: path.join(tmpWs, 'build', 'current', 'layers.json'),
        useMakeProbe: false,
      });
      expect(initRes.symbolCount).toBeGreaterThanOrEqual(10);
      expect(initRes.choiceCount).toBe(1);

      const treeRes = await client.getTree(null);
      expect(treeRes.nodes.length).toBeGreaterThan(0);

      // 2. Search & Detail Round-Trip
      const searchRes = await client.search({ query: 'LIN_' });
      expect(searchRes.items.map((i) => i.symbol)).toEqual(['LIN_A', 'LIN_B', 'LIN_C']);

      const detailRes = await client.getSymbolDetail('CONFIG_LIN_C');
      expect(detailRes.symbol).toBe('LIN_C');
      expect(detailRes.directDepText).toBe('LIN_B');

      // 3. Auto-Solve & UNSAT Conflict Round-Trip
      const solveOk = await client.solve({
        requests: [{ symbol: 'LIN_C', value: 'y' }],
      });
      expect(solveOk.status).toBe('ok');
      expect(solveOk.changes.map((c) => `${c.symbol}:${c.from}->${c.to}`)).toEqual([
        'LIN_C:n->y',
        'LIN_A:n->y',
        'LIN_B:n->y',
      ]);

      // Conflict against pinned NEG_A=y in qemu.config
      const solveConflict = await client.solve({
        requests: [{ symbol: 'NEG_B', value: 'y' }],
        ignorePins: false,
      });
      expect(solveConflict.status).toBe('conflict');
      expect(solveConflict.conflicts.some((c) => c.layerId === 'qemu')).toBe(true);

      // Re-solve with ignorePins: true
      const solveIgnored = await client.solve({
        requests: [{ symbol: 'NEG_B', value: 'y' }],
        ignorePins: true,
      });
      expect(solveIgnored.status).toBe('ok');

      // 4. Apply & Post-Verification Round-Trip
      const applyRes = await client.apply(
        solveOk.changes.map((c) => ({ symbol: c.symbol, value: c.to }))
      );
      expect(applyRes.verified).toBe(true);
      expect(applyRes.mismatches).toEqual([]);

      const overlayText = fs.readFileSync(
        path.join(tmpWs, 'build', 'current', 'solver_overlay.config'),
        'utf8'
      );
      expect(overlayText).toContain('CONFIG_LIN_C=y');
      expect(overlayText).toContain('CONFIG_LIN_B=y');
      expect(overlayText).toContain('CONFIG_LIN_A=y');

      await client.reloadConfig();
      const afterDetail = await client.getSymbolDetail('LIN_C');
      expect(afterDetail.value).toBe('y');
    } finally {
      await client.dispose();
    }
  });

  it.skipIf(process.env.REAL_KERNEL !== '1')(
    'solves against the real kdev-workspace/linux kernel tree when REAL_KERNEL=1',
    async () => {
      const client = new KconfigRpcClient({
        pythonPath: PYTHON_BIN,
        workspaceRoot: WS_ROOT,
      });
      try {
        const initRes = await client.init({
          workspaceRoot: WS_ROOT,
        });
        expect(initRes.symbolCount).toBeGreaterThan(10000);

        const solveRes = await client.solve({
          requests: [{ symbol: 'CONFIG_NET_SCH_FQ', value: 'y' }],
        });
        expect(solveRes.status).toBe('ok');
      } finally {
        await client.dispose();
      }
    }
  );
});
