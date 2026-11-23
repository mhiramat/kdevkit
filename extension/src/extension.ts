import * as vscode from 'vscode';
import { KconfigFileWatcher } from './kconfig/configWatcher';
import { KconfigPanelController } from './kconfig/panelController';
import { KconfigRpcClient } from './kconfig/rpcClient';
import { KprobeController } from './kprobe/kprobeController';
import { QemuRunner } from './qemu/qemuRunner';
import { SelftestController } from './selftest/selftestController';
import { resolveWorkspacePaths, WorkspaceConfigOverrides } from './shared/workspacePaths';

export interface KdevExtensionApi {
  rpcClient: KconfigRpcClient;
  panelController: KconfigPanelController;
  kprobeController: KprobeController;
  selftestController: SelftestController;
  qemuRunner: QemuRunner;
  getLogs: () => string[];
}

function readWorkspaceOverrides(): WorkspaceConfigOverrides {
  const cfg = vscode.workspace.getConfiguration('kdev');
  return {
    kernelSrcDir: cfg.get<string>('kernelSrcDir', 'linux'),
    buildDir: cfg.get<string>('buildDir', 'build/current'),
    arch: cfg.get<string>('arch', 'x86_64'),
    layersFile: cfg.get<string>('layersFile', ''),
    pythonPath: cfg.get<string>('pythonPath', 'backend/.venv/bin/python'),
    autoRestartClangd: cfg.get<boolean>('autoRestartClangd', true),
    perfBin: cfg.get<string>('perfBin', 'perf'),
    traceGroup: cfg.get<string>('kprobe.traceGroup', 'kdev'),
    maxTraceEvents: cfg.get<number>('kprobe.maxTraceEvents', 10000),
    autoLoadTrace: cfg.get<boolean>('kprobe.autoLoadTrace', true),
  };
}

let activeRpcClient: KconfigRpcClient | null = null;

export function activate(context: vscode.ExtensionContext): KdevExtensionApi | undefined {
  const folder = vscode.workspace.workspaceFolders?.[0];
  const workspaceRoot = folder?.uri.fsPath ?? process.cwd();
  const paths = resolveWorkspacePaths(workspaceRoot, readWorkspaceOverrides());

  const outputChannel = vscode.window.createOutputChannel('Kernel Dev: Kconfig');
  context.subscriptions.push(outputChannel);

  const logHistory: string[] = [];
  const logger = (line: string) => {
    logHistory.push(line);
    if (logHistory.length > 500) {
      logHistory.shift();
    }
    outputChannel.appendLine(line);
  };

  let panelController: KconfigPanelController | null = null;

  const rpcClient = new KconfigRpcClient({
    pythonPath: paths.pythonPath,
    workspaceRoot: paths.workspaceRoot,
    logger,
    onStatusChange: (state, message) => {
      panelController?.postToWebview({
        type: 'backendStatus',
        state,
        message,
      });
    },
  });
  activeRpcClient = rpcClient;

  panelController = new KconfigPanelController({
    extensionUri: context.extensionUri,
    paths,
    rpcClient,
    logger,
  });
  context.subscriptions.push(panelController);

  const watcher = new KconfigFileWatcher({
    paths,
    isApplying: () => panelController?.isApplying() ?? false,
    onExternalChange: async () => {
      await panelController?.notifyExternalConfigChanged();
    },
  });
  context.subscriptions.push(watcher);

  context.subscriptions.push(
    vscode.commands.registerCommand('kdev.openKconfigEditor', () => {
      panelController?.openOrReveal();
    }),
    vscode.commands.registerCommand('kdev.restartKconfigBackend', async () => {
      await rpcClient.restart();
      await panelController?.notifyExternalConfigChanged();
      void vscode.window.showInformationMessage('Kconfig backend daemon restarted.');
    }),
    vscode.commands.registerCommand(
      'kdev._applyChangesForTest',
      async (changes: Array<{ symbol: string; value: string }>) => {
        if (!panelController) {
          throw new Error('KconfigPanelController is not initialized');
        }
        return panelController.applyChangesAndSyncClangd(changes);
      }
    )
  );

  const kprobeController = new KprobeController({
    paths,
    logger,
  });

  const qemuRunner = new QemuRunner();
  const selftestController = new SelftestController({
    paths,
    rpcClient,
    panelController,
    kprobeController,
    qemuRunner,
    logger,
  });

  context.subscriptions.push(
    kprobeController,
    selftestController,
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('kdev')) {
        const updatedPaths = resolveWorkspacePaths(workspaceRoot, readWorkspaceOverrides());
        kprobeController.updatePaths(updatedPaths);
        selftestController.updatePaths(updatedPaths);
      }
    })
  );

  return {
    rpcClient,
    panelController,
    kprobeController,
    selftestController,
    qemuRunner,
    getLogs: () => [...logHistory],
  };
}

export async function deactivate(): Promise<void> {
  if (activeRpcClient) {
    await activeRpcClient.dispose();
    activeRpcClient = null;
  }
}
