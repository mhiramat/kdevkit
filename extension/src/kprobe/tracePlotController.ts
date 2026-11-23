import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  HostToTracePlotMessage,
  TracePlotToHostMessage,
} from '../shared/tracePlotProtocol';
import { DisposableLike, ProbeStore } from './probeStore';

export interface TracePlotControllerOptions {
  extensionUri: vscode.Uri;
  workspaceRoot: string;
  store: ProbeStore;
  logger: (line: string) => void;
}

export class TracePlotController implements vscode.Disposable {
  public static readonly viewType = 'kdev.tracePlot';

  private panel: vscode.WebviewPanel | null = null;
  private storeSubs: DisposableLike[] = [];

  private readonly extensionUri: vscode.Uri;
  private readonly workspaceRoot: string;
  private readonly store: ProbeStore;
  private readonly logger: (line: string) => void;

  constructor(options: TracePlotControllerOptions) {
    this.extensionUri = options.extensionUri;
    this.workspaceRoot = options.workspaceRoot;
    this.store = options.store;
    this.logger = options.logger;
  }

  public getPanel(): vscode.WebviewPanel | null {
    return this.panel;
  }

  public openOrReveal(): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside, true);
      this.postSnapshot();
      return;
    }

    const webviewDistUri = vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview');
    const panel = vscode.window.createWebviewPanel(
      TracePlotController.viewType,
      'kdev: Trace Plotter',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [webviewDistUri],
      }
    );

    this.panel = panel;
    panel.webview.html = this.buildWebviewHtml(panel.webview);

    panel.webview.onDidReceiveMessage((msg: TracePlotToHostMessage) => {
      void this.handleWebviewMessage(msg);
    });

    this.subscribeStore();

    panel.onDidDispose(() => {
      this.unsubscribeStore();
      this.panel = null;
    });
  }

  private subscribeStore(): void {
    this.unsubscribeStore();
    this.storeSubs = [
      this.store.onDidChangeProbes(() => this.postSnapshot()),
      this.store.onDidChangeEvents(() => this.postSnapshot()),
      this.store.onDidSelectEvent((eventIndex) => {
        this.postToWebview({
          type: 'highlightEvent',
          eventIndex,
        });
      }),
    ];
  }

  private unsubscribeStore(): void {
    for (const sub of this.storeSubs) {
      sub.dispose();
    }
    this.storeSubs = [];
  }

  private postToWebview(msg: HostToTracePlotMessage): void {
    if (this.panel) {
      void this.panel.webview.postMessage(msg);
    }
  }

  private postSnapshot(): void {
    const defaultTimebase = vscode.workspace
      .getConfiguration('kdev.tracePlot')
      .get<'relative' | 'absolute'>('defaultTimebase', 'relative');

    this.postToWebview({
      type: 'traceSnapshot',
      probes: this.store.getProbes(),
      events: this.store.getEvents(),
      truncated: this.store.isTraceTruncated(),
      totalMatched: this.store.getTotalTraceCount(),
      selectedEventIndex: this.store.getSelectedEventIndex(),
      defaultTimebase,
    });
  }

  private async handleWebviewMessage(msg: TracePlotToHostMessage): Promise<void> {
    switch (msg.type) {
      case 'ready':
        this.postSnapshot();
        break;

      case 'selectEvent': {
        const ev = this.store.getEvents().find((e) => e.index === msg.eventIndex);
        this.store.selectEvent(msg.eventIndex);
        if (ev) {
          await vscode.commands.executeCommand('kdev.kprobe.jumpToEvent', {
            eventIndex: ev.index,
            probeId: ev.probeId ?? ev.eventName,
            viewColumn: vscode.ViewColumn.One,
          });
        }
        break;
      }

      case 'requestReloadTrace':
        await vscode.commands.executeCommand('kdev.kprobe.loadTraceLog');
        break;

      case 'exportData':
        await this.handleExport(msg.format, msg.filenameHint, msg.content);
        break;
    }
  }

  private async handleExport(
    format: 'csv' | 'png',
    filenameHint: string,
    content: string
  ): Promise<void> {
    const defaultUri = vscode.Uri.file(path.join(this.workspaceRoot, filenameHint));
    const filters: Record<string, string[]> =
      format === 'png' ? { 'PNG Image': ['png'] } : { 'CSV File': ['csv'] };

    const targetUri = await vscode.window.showSaveDialog({
      defaultUri,
      filters,
      saveLabel: `Export ${format.toUpperCase()}`,
    });
    if (!targetUri) {
      return;
    }

    try {
      if (format === 'png') {
        const base64 = content.replace(/^data:image\/png;base64,/, '');
        fs.writeFileSync(targetUri.fsPath, Buffer.from(base64, 'base64'));
      } else {
        fs.writeFileSync(targetUri.fsPath, content, 'utf-8');
      }
      void vscode.window.showInformationMessage(`Exported trace plot to ${targetUri.fsPath}`);
    } catch (err) {
      this.logger(`[tracePlot] Export failed: ${String(err)}`);
      void vscode.window.showErrorMessage(
        `Failed to export ${format.toUpperCase()}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  private buildWebviewHtml(webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(32).toString('hex');
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'tracePlot.js')
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'tracePlot.css')
    );

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none';
                 style-src ${webview.cspSource} 'unsafe-inline';
                 img-src ${webview.cspSource} data:;
                 font-src ${webview.cspSource};
                 script-src 'nonce-${nonce}';">
  <title>kdev: Trace Plotter</title>
  <link rel="stylesheet" href="${styleUri}">
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  public dispose(): void {
    this.unsubscribeStore();
    if (this.panel) {
      this.panel.dispose();
      this.panel = null;
    }
  }
}
