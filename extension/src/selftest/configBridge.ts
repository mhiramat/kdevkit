import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { KconfigPanelController } from '../kconfig/panelController';
import { KconfigRpcClient } from '../kconfig/rpcClient';
import { ConfigLayer } from '../shared/protocol';
import { ResolvedWorkspacePaths } from '../shared/workspacePaths';
import { checkTargetConfig } from './discovery';
import { ConfigCheckResult } from './types';

function sanitizeLayerId(target: string, archSuffix?: string): string {
  const clean = target
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
  return archSuffix ? `selftest-${clean}-${archSuffix}` : `selftest-${clean}`;
}

/**
 * Symlink a selftest target's `config` (and optional `config.<arch>`) into
 * `build/current/user_injected/selftest-<target>.config` and compute the updated
 * `layers.json` entries (inserted immediately before `solver` / `solver_overlay.config`).
 */
export function stageSelftestConfigLayers(options: {
  target: string;
  configPaths: string[];
  workspaceRoot: string;
  userInjectedDir: string;
  existingLayers: ConfigLayer[];
}): {
  addedLayerIds: string[];
  updatedLayers: ConfigLayer[];
} {
  fs.mkdirSync(options.userInjectedDir, { recursive: true });
  const updated = [...options.existingLayers];
  const addedLayerIds: string[] = [];

  for (const cfgPath of options.configPaths) {
    const absSrc = path.resolve(cfgPath);
    if (!fs.existsSync(absSrc)) {
      continue;
    }

    const baseName = path.basename(absSrc);
    const archSuffix =
      baseName.startsWith('config.') ? baseName.slice('config.'.length) : undefined;
    const layerId = sanitizeLayerId(options.target, archSuffix);
    const destPath = path.join(options.userInjectedDir, `${layerId}.config`);

    const existingStat = fs.lstatSync(destPath, { throwIfNoEntry: false });
    if (existingStat) {
      fs.unlinkSync(destPath);
    }

    const relFromWs = path.relative(options.workspaceRoot, absSrc);
    const symlinkTarget = !relFromWs.startsWith('..')
      ? path.relative(path.dirname(destPath), absSrc)
      : absSrc;
    fs.symlinkSync(symlinkTarget, destPath);

    const storedRelPath = path
      .relative(options.workspaceRoot, destPath)
      .split(path.sep)
      .join('/');

    const layerEntry: ConfigLayer = {
      id: layerId,
      path: storedRelPath,
      enabled: true,
      pinned: false,
      readonly: false,
    };

    const existingIdx = updated.findIndex((l) => l.id === layerId);
    if (existingIdx >= 0) {
      updated[existingIdx] = layerEntry;
    } else {
      const solverIdx = updated.findIndex(
        (l) => l.id === 'solver' || l.path.endsWith('solver_overlay.config')
      );
      if (solverIdx >= 0) {
        updated.splice(solverIdx, 0, layerEntry);
      } else {
        updated.push(layerEntry);
      }
    }
    addedLayerIds.push(layerId);
  }

  return {
    addedLayerIds,
    updatedLayers: updated,
  };
}

/**
 * Full Phase 3A Kconfig synchronization workflow for a selftest target:
 * 1. Check `config` / `config.<arch>` against `build/current/.config`.
 * 2. Symlink into `build/current/user_injected/` and register in `layers.json`.
 * 3. Invoke `kconfig/solve` for missing symbols and open Kconfig Editor Panel
 *    with the `SolveModal` diff preview.
 * 4. When applied, offer a one-click kernel + initramfs rebuild prompt.
 */
export async function syncSelftestTargetConfig(options: {
  target: string;
  paths: ResolvedWorkspacePaths;
  rpcClient: KconfigRpcClient;
  panelController: KconfigPanelController;
  logger: (line: string) => void;
  onApplied?: () => void;
}): Promise<ConfigCheckResult> {
  const { target, paths, rpcClient, panelController, logger, onApplied } = options;

  const check = checkTargetConfig({
    kernelDir: paths.kernelDir,
    target,
    dotConfigPath: paths.dotConfigPath,
    arch: paths.arch,
  });

  if (check.status === 'no-config-file') {
    void vscode.window.showInformationMessage(
      `Selftest target '${target}' does not define a Kconfig 'config' file.`
    );
    return check;
  }

  if (check.status === 'satisfied') {
    void vscode.window.showInformationMessage(
      `All Kconfig requirements for selftest '${target}' are already satisfied in .config.`
    );
    return check;
  }

  await panelController.ensureInitialized();

  const currentLayersInfo = await rpcClient.getLayers();
  const baseTarget =
    currentLayersInfo.baseTarget || currentLayersInfo.base_target || 'defconfig';

  const { addedLayerIds, updatedLayers } = stageSelftestConfigLayers({
    target,
    configPaths: check.configPaths,
    workspaceRoot: paths.workspaceRoot,
    userInjectedDir: paths.userInjectedDir,
    existingLayers: currentLayersInfo.layers,
  });

  logger(
    `[selftest] Staged Kconfig layer(s) for '${target}': ${addedLayerIds.join(', ')}`
  );

  await rpcClient.setLayers({
    baseTarget,
    layers: updatedLayers,
    runConfigure: false,
  });

  const requests = check.missing.map((m) => ({
    symbol: m.symbol,
    value: m.required,
  }));

  const solveResponse = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Solving ${requests.length} Kconfig prerequisite(s) for selftest '${target}'...`,
    },
    () => rpcClient.solve({ requests, ignorePins: false })
  );

  // Register a one-shot apply listener to prompt for kernel & initramfs rebuild
  const applySub = panelController.onDidApplyConfig(() => {
    applySub.dispose();
    onApplied?.();
    void (async () => {
      const choice = await vscode.window.showInformationMessage(
        'Selftest config applied. Rebuild Kernel & Modules now?',
        'Rebuild Kernel & Initramfs',
        'Later'
      );
      if (choice === 'Rebuild Kernel & Initramfs') {
        const terminal = vscode.window.createTerminal({
          name: 'kdev: Kernel Rebuild',
          cwd: paths.workspaceRoot,
        });
        terminal.show();
        terminal.sendText('./scripts/build_kernel.sh && ./scripts/build_initramfs.sh');
      }
    })();
  });

  panelController.openWithSolvePreview(requests, solveResponse);
  return check;
}
