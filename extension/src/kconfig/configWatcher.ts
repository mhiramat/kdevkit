import * as vscode from 'vscode';
import { ResolvedWorkspacePaths } from '../shared/workspacePaths';

export class KconfigFileWatcher implements vscode.Disposable {
  private readonly watchers: vscode.FileSystemWatcher[] = [];
  private debounceTimer: NodeJS.Timeout | null = null;
  private readonly isApplying: () => boolean;
  private readonly onExternalChange: () => Promise<void>;
  private readonly debounceMs: number;

  constructor(options: {
    paths: ResolvedWorkspacePaths;
    isApplying: () => boolean;
    onExternalChange: () => Promise<void>;
    debounceMs?: number;
  }) {
    this.isApplying = options.isApplying;
    this.onExternalChange = options.onExternalChange;
    this.debounceMs = options.debounceMs ?? 500;

    const dotConfigPattern = new vscode.RelativePattern(
      options.paths.buildDir,
      '.config'
    );
    const layersPattern = new vscode.RelativePattern(
      options.paths.workspaceRoot,
      'configs/layers.json'
    );

    for (const pattern of [dotConfigPattern, layersPattern]) {
      const watcher = vscode.workspace.createFileSystemWatcher(pattern);
      watcher.onDidChange(() => this.scheduleTrigger());
      watcher.onDidCreate(() => this.scheduleTrigger());
      watcher.onDidDelete(() => this.scheduleTrigger());
      this.watchers.push(watcher);
    }
  }

  private scheduleTrigger(): void {
    if (this.isApplying()) {
      return;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      if (!this.isApplying()) {
        void this.onExternalChange();
      }
    }, this.debounceMs);
  }

  public dispose(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    for (const w of this.watchers) {
      w.dispose();
    }
    this.watchers.length = 0;
  }
}
