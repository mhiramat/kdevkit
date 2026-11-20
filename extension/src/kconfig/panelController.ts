import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  ApplyResponse,
  ConfigLayer,
  HostToWebviewMessage,
  WebviewToHostMessage,
} from '../shared/protocol';
import { ResolvedWorkspacePaths } from '../shared/workspacePaths';
import { linkInjectedConfigLayer } from './layerInjection';
import { KconfigRpcClient, RpcRemoteError } from './rpcClient';

export class KconfigPanelController implements vscode.Disposable {
  public static readonly viewType = 'kdev.kconfigEditor';

  private panel: vscode.WebviewPanel | null = null;
  private initialized = false;
  private applyingCount = 0;
  private clangdRestartCount = 0;

  private readonly extensionUri: vscode.Uri;
  private readonly paths: ResolvedWorkspacePaths;
  private readonly rpcClient: KconfigRpcClient;
  private readonly logger: (line: string) => void;

  constructor(options: {
    extensionUri: vscode.Uri;
    paths: ResolvedWorkspacePaths;
    rpcClient: KconfigRpcClient;
    logger: (line: string) => void;
  }) {
    this.extensionUri = options.extensionUri;
    this.paths = options.paths;
    this.rpcClient = options.rpcClient;
    this.logger = options.logger;
  }

  public isApplying(): boolean {
    return this.applyingCount > 0;
  }

  public getClangdRestartCount(): number {
    return this.clangdRestartCount;
  }

  public getPanel(): vscode.WebviewPanel | null {
    return this.panel;
  }

  public openOrReveal(): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.One);
      return;
    }

    const webviewDistUri = vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview');
    const panel = vscode.window.createWebviewPanel(
      KconfigPanelController.viewType,
      'Linux Kernel Kconfig Editor',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [webviewDistUri],
      }
    );

    this.panel = panel;
    panel.webview.html = this.buildWebviewHtml(panel.webview);

    panel.webview.onDidReceiveMessage((msg: WebviewToHostMessage) => {
      void this.handleWebviewMessage(msg);
    });

    panel.onDidDispose(() => {
      this.panel = null;
    });
  }

  public postToWebview(message: HostToWebviewMessage): void {
    if (this.panel) {
      void this.panel.webview.postMessage(message);
    }
  }

  public async notifyExternalConfigChanged(): Promise<void> {
    if (!this.initialized) {
      return;
    }
    try {
      await this.rpcClient.reloadConfig();
      this.postToWebview({
        type: 'externalConfigChanged',
        changedAt: Date.now(),
      });
    } catch (err: any) {
      this.logger(`[panelController] Failed to reload config on external change: ${err?.message ?? err}`);
    }
  }

  public async ensureInitialized(): Promise<void> {
    if (this.initialized && this.rpcClient.isRunning()) {
      return;
    }
    await this.rpcClient.init({
      workspaceRoot: this.paths.workspaceRoot,
      kernelDir: this.paths.kernelDir,
      buildDir: this.paths.buildDir,
      arch: this.paths.arch,
      layersJsonPath: this.paths.layersJsonPath,
    });
    this.initialized = true;
  }

  private async bootstrapWebviewState(): Promise<void> {
    this.postToWebview({ type: 'initState', status: 'loading' });
    try {
      const initRes = await this.rpcClient.init({
        workspaceRoot: this.paths.workspaceRoot,
        kernelDir: this.paths.kernelDir,
        buildDir: this.paths.buildDir,
        arch: this.paths.arch,
        layersJsonPath: this.paths.layersJsonPath,
      });
      this.initialized = true;

      const [layersRes, treeRes] = await Promise.all([
        this.rpcClient.getLayers(),
        this.rpcClient.getTree(null),
      ]);

      this.postToWebview({
        type: 'initState',
        status: 'ready',
        stats: {
          symbolCount: initRes.symbolCount,
          initTimeMs: initRes.initTimeMs,
          warnings: initRes.warnings,
        },
        baseTarget: layersRes.baseTarget || layersRes.base_target || 'defconfig',
        layers: layersRes.layers,
        rootNodes: treeRes.nodes,
      });
    } catch (err: any) {
      this.logger(`[panelController] Initialization error: ${err?.message ?? err}`);
      this.postToWebview({
        type: 'initState',
        status: 'error',
        error: err?.message ?? String(err),
      });
    }
  }

  private async handleWebviewMessage(msg: WebviewToHostMessage): Promise<void> {
    if (msg.type === 'ready') {
      await this.bootstrapWebviewState();
      return;
    }

    const reqId = msg.reqId;
    try {
      await this.ensureInitialized();

      switch (msg.type) {
        case 'getTree': {
          const payload = await this.rpcClient.getTree(msg.parentId);
          this.postToWebview({ type: 'response', reqId, ok: true, payload });
          break;
        }
        case 'search': {
          const payload = await this.rpcClient.search({
            query: msg.query,
            limit: msg.limit,
            onlyChanged: msg.onlyChanged,
          });
          this.postToWebview({ type: 'response', reqId, ok: true, payload });
          break;
        }
        case 'getSymbolDetail': {
          const payload = await this.rpcClient.getSymbolDetail(msg.symbol);
          this.postToWebview({ type: 'response', reqId, ok: true, payload });
          break;
        }
        case 'solve': {
          const payload = await this.rpcClient.solve({
            requests: msg.requests,
            ignorePins: msg.ignorePins,
          });
          this.postToWebview({ type: 'response', reqId, ok: true, payload });
          break;
        }
        case 'apply': {
          const payload = await this.applyChangesAndSyncClangd(msg.changes);
          this.postToWebview({ type: 'response', reqId, ok: true, payload });
          break;
        }
        case 'updateLayers': {
          this.applyingCount += 1;
          try {
            const payload = await this.rpcClient.setLayers({
              baseTarget: msg.baseTarget,
              layers: msg.layers,
              runConfigure: msg.applyNow ?? false,
            });
            if (msg.applyNow) {
              await this.maybeRestartClangd();
            }
            this.postToWebview({ type: 'response', reqId, ok: true, payload });
          } finally {
            this.applyingCount = Math.max(0, this.applyingCount - 1);
          }
          break;
        }
        case 'pickAndInjectLayer': {
          const payload = await this.pickAndInjectLayer(msg.copyIntoWorkspace);
          this.postToWebview({ type: 'response', reqId, ok: true, payload });
          break;
        }
        case 'resetSolverOverlay': {
          const payload = await this.resetSolverOverlay();
          this.postToWebview({ type: 'response', reqId, ok: true, payload });
          break;
        }
        case 'reloadAll': {
          await this.rpcClient.reloadConfig();
          const [layersRes, treeRes] = await Promise.all([
            this.rpcClient.getLayers(),
            this.rpcClient.getTree(null),
          ]);
          this.postToWebview({
            type: 'response',
            reqId,
            ok: true,
            payload: {
              baseTarget: layersRes.baseTarget || layersRes.base_target || 'defconfig',
              layers: layersRes.layers,
              rootNodes: treeRes.nodes,
            },
          });
          break;
        }
      }
    } catch (err: any) {
      const code = err instanceof RpcRemoteError ? err.code : -32603;
      const data = err instanceof RpcRemoteError ? err.data : undefined;
      this.postToWebview({
        type: 'response',
        reqId,
        ok: false,
        error: {
          code,
          message: err?.message ?? String(err),
          data,
        },
      });
    }
  }

  public async applyChangesAndSyncClangd(
    changes: Array<{ symbol: string; value: string }>
  ): Promise<ApplyResponse> {
    await this.ensureInitialized();
    this.applyingCount += 1;
    try {
      const res = await this.rpcClient.apply(changes);
      await this.maybeRestartClangd();

      if (!res.verified && res.mismatches.length > 0) {
        const summary = res.mismatches
          .slice(0, 5)
          .map((m) => `${m.symbol} (expected ${m.expected}, got ${m.actual})`)
          .join(', ');
        void vscode.window.showWarningMessage(
          `Kconfig post-verification detected mismatches after olddefconfig: ${summary}`
        );
      }

      return res;
    } finally {
      this.applyingCount = Math.max(0, this.applyingCount - 1);
    }
  }

  private async maybeRestartClangd(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('kdev');
    const shouldRestart = cfg.get<boolean>('autoRestartClangd', this.paths.autoRestartClangd);
    if (!shouldRestart) {
      return;
    }
    this.clangdRestartCount += 1;
    try {
      const clangdExt = vscode.extensions.getExtension('llvm-vs-code-extensions.vscode-clangd');
      if (clangdExt?.isActive) {
        await vscode.commands.executeCommand('clangd.restart');
      } else {
        // Attempt command execution if registered in test/custom environment
        const allCommands = await vscode.commands.getCommands(true);
        if (allCommands.includes('clangd.restart')) {
          await vscode.commands.executeCommand('clangd.restart');
        }
      }
    } catch (err: any) {
      this.logger(`[panelController] clangd.restart skipped or failed: ${err?.message ?? err}`);
    }
  }

  private async pickAndInjectLayer(
    copyIntoWorkspace: boolean
  ): Promise<{ canceled: boolean; layers?: ConfigLayer[]; baseTarget?: string }> {
    const selftestsDir = path.join(this.paths.kernelDir, 'tools', 'testing', 'selftests');
    const defaultUri = fs.existsSync(selftestsDir)
      ? vscode.Uri.file(selftestsDir)
      : vscode.Uri.file(this.paths.workspaceRoot);

    // Note: VSCode's showOpenDialog converts filter extensions to '*.<ext>', which on
    // Linux/GTK hides extensionless 'config' files (such as tools/testing/selftests/*/config).
    // Putting '*' first ensures extensionless 'config' files are visible immediately.
    const picked = await vscode.window.showOpenDialog({
      title: 'Select Kconfig Fragment (e.g. tools/testing/selftests/*/config or *.config)',
      defaultUri,
      canSelectMany: false,
      openLabel: 'Inject Config Layer',
      filters: {
        'Kconfig Files (config, *.config)': ['*'],
        '*.config / *.cfg / *.fragment': ['config', 'cfg', 'fragment'],
      },
    });

    if (!picked || picked.length === 0) {
      return { canceled: true };
    }

    const srcFile = picked[0].fsPath;
    const baseName = path.basename(srcFile);
    if (
      baseName !== 'config' &&
      !baseName.endsWith('.config') &&
      !baseName.endsWith('.cfg') &&
      !baseName.endsWith('.fragment')
    ) {
      throw new Error(
        `Invalid config filename '${baseName}': only 'config' or '*.config' / '*.cfg' / '*.fragment' files are allowed.`
      );
    }

    const currentLayersInfo = await this.rpcClient.getLayers();
    const baseTarget = currentLayersInfo.baseTarget || currentLayersInfo.base_target || 'defconfig';

    const { updatedLayers } = linkInjectedConfigLayer({
      srcFile,
      workspaceRoot: this.paths.workspaceRoot,
      kernelDir: this.paths.kernelDir,
      userInjectedDir: this.paths.userInjectedDir,
      existingLayers: currentLayersInfo.layers,
      linkIntoWorkspace: copyIntoWorkspace,
    });

    this.applyingCount += 1;
    try {
      const updated = await this.rpcClient.setLayers({
        baseTarget,
        layers: updatedLayers,
        runConfigure: true,
      });
      await this.maybeRestartClangd();

      return {
        canceled: false,
        baseTarget: updated.baseTarget || updated.base_target || baseTarget,
        layers: updated.layers,
      };
    } finally {
      this.applyingCount = Math.max(0, this.applyingCount - 1);
    }
  }

  private async resetSolverOverlay(): Promise<ApplyResponse> {
    const overlayFile = path.join(this.paths.workspaceRoot, 'configs', 'solver_overlay.config');
    fs.mkdirSync(path.dirname(overlayFile), { recursive: true });
    fs.writeFileSync(
      overlayFile,
      '# Auto-generated by kconfig-server (solver_overlay.config)\n',
      'utf8'
    );
    return this.applyChangesAndSyncClangd([]);
  }

  private buildWebviewHtml(webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(32).toString('hex');
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'kconfig.js')
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'kconfig.css')
    );
    const codiconsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'codicons', 'codicon.css')
    );

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none';
                 style-src ${webview.cspSource} 'unsafe-inline';
                 font-src ${webview.cspSource};
                 script-src 'nonce-${nonce}';">
  <title>Linux Kernel Kconfig Editor</title>
  <link rel="stylesheet" href="${codiconsUri}">
  <link rel="stylesheet" href="${styleUri}">
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  public dispose(): void {
    if (this.panel) {
      this.panel.dispose();
      this.panel = null;
    }
  }
}
