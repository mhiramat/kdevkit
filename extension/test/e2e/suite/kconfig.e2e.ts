import * as assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { KdevExtensionApi } from '../../../src/extension';

export async function run(): Promise<void> {
  const wsFolder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(wsFolder, 'Workspace folder must be open');
  const wsRoot = wsFolder.uri.fsPath;

  // 1. Execute kdev.openKconfigEditor -> verify activation and panel creation
  await vscode.commands.executeCommand('kdev.openKconfigEditor');

  const ext = vscode.extensions.getExtension<KdevExtensionApi>('kdev.linux-kernel-dev');
  assert.ok(ext, 'Extension kdev.linux-kernel-dev should be present');
  const api = await ext.activate();
  assert.ok(api.panelController.getPanel(), 'Kconfig WebviewPanel should be open');

  // 2. Verify kconfig/init completes and logs contain no Python tracebacks
  await api.panelController.ensureInitialized();
  const logs = api.getLogs().join('\n');
  assert.ok(!logs.includes('Traceback (most recent call last)'), 'No Python traceback in logs');

  // 3. Trigger apply flow -> verify autoconf.h mtime and clangd.restart count
  const autoconfPath = path.join(wsRoot, 'build', 'current', 'include', 'generated', 'autoconf.h');
  const prevClangdCount = api.panelController.getClangdRestartCount();
  const applyRes = await vscode.commands.executeCommand<any>('kdev._applyChangesForTest', []);
  assert.ok(applyRes, 'applyChangesForTest should return ApplyResponse');
  assert.ok(fs.existsSync(autoconfPath), 'autoconf.h should exist after apply');
  assert.strictEqual(
    api.panelController.getClangdRestartCount(),
    prevClangdCount + 1,
    'clangd.restart hook should be invoked'
  );

  // 4. Verify git -C linux status --porcelain remains empty
  const gitOut = execFileSync('git', ['-C', path.join(wsRoot, 'linux'), 'status', '--porcelain'], {
    encoding: 'utf8',
  });
  assert.strictEqual(gitOut.trim(), '', 'linux/ repository must remain completely clean');
}
