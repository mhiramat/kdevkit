import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  ResolvedWorkspacePaths,
  toKernelRelativePath,
} from '../shared/workspacePaths';
import {
  PerfProbeError,
  generateDefinitions,
  queryAvailableVars,
  queryProbeableLines,
  validateCustomExpr,
  writeTracefsSetup,
} from './perfProbe';
import { ProbeStore } from './probeStore';
import { parseTraceLogFile } from './traceParser';
import {
  ConfiguredKprobesProvider,
  JumpToEventArgs,
  KprobeTreeItem,
  TraceEventsProvider,
} from './treeViews';
import { KprobeSpec, PerfProbeOptions, TraceEvent } from './types';

function makeSvgUri(svg: string): vscode.Uri {
  return vscode.Uri.parse(`data:image/svg+xml;utf8,${encodeURIComponent(svg)}`);
}

const VALID_GUTTER_SVG = makeSvgUri(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><polygon points="8,1 15,8 8,15 1,8" fill="#e5a50a" stroke="#6d4c00" stroke-width="1"/></svg>'
);

const DISABLED_GUTTER_SVG = makeSvgUri(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="5.5" fill="none" stroke="#888888" stroke-width="1.8"/></svg>'
);

const STALE_GUTTER_SVG = makeSvgUri(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><polygon points="8,1.5 14.5,13.5 1.5,13.5" fill="#cca700" stroke="#f14c4c" stroke-width="1.3"/><rect x="7.3" y="5.5" width="1.4" height="4.2" fill="#1e1e1e"/><circle cx="8" cy="11.5" r="0.9" fill="#1e1e1e"/></svg>'
);

export interface KprobeControllerOptions {
  paths: ResolvedWorkspacePaths;
  logger: (line: string) => void;
}

export class KprobeController implements vscode.Disposable {
  public readonly store: ProbeStore;
  public readonly probesViewProvider: ConfiguredKprobesProvider;
  public readonly eventsViewProvider: TraceEventsProvider;

  private readonly disposables: vscode.Disposable[] = [];
  private readonly statusBarItem: vscode.StatusBarItem;
  private readonly validGutterDecoration: vscode.TextEditorDecorationType;
  private readonly disabledGutterDecoration: vscode.TextEditorDecorationType;
  private readonly staleGutterDecoration: vscode.TextEditorDecorationType;
  private readonly inlineTextDecoration: vscode.TextEditorDecorationType;

  private traceDebounceTimer: NodeJS.Timeout | undefined;
  private vmlinuxDebounceTimer: NodeJS.Timeout | undefined;
  private paths: ResolvedWorkspacePaths;
  private readonly logger: (line: string) => void;

  constructor(options: KprobeControllerOptions) {
    this.paths = options.paths;
    this.logger = options.logger;
    this.store = new ProbeStore(this.paths.probesJsonPath);

    this.validGutterDecoration = vscode.window.createTextEditorDecorationType({
      gutterIconPath: VALID_GUTTER_SVG,
      gutterIconSize: 'contain',
      overviewRulerColor: '#e5a50a',
      overviewRulerLane: vscode.OverviewRulerLane.Right,
    });

    this.disabledGutterDecoration = vscode.window.createTextEditorDecorationType({
      gutterIconPath: DISABLED_GUTTER_SVG,
      gutterIconSize: 'contain',
    });

    this.staleGutterDecoration = vscode.window.createTextEditorDecorationType({
      gutterIconPath: STALE_GUTTER_SVG,
      gutterIconSize: 'contain',
      overviewRulerColor: '#f14c4c',
      overviewRulerLane: vscode.OverviewRulerLane.Right,
    });

    this.inlineTextDecoration = vscode.window.createTextEditorDecorationType({
      after: {
        margin: '0 0 0 1.5em',
        color: new vscode.ThemeColor('editorCodeLens.foreground'),
        fontStyle: 'italic',
      },
    });

    this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
    this.statusBarItem.command = 'kdev.kprobe.loadTraceLog';
    this.statusBarItem.tooltip = 'Click to reload trace.log';
    this.disposables.push(
      this.validGutterDecoration,
      this.disabledGutterDecoration,
      this.staleGutterDecoration,
      this.inlineTextDecoration,
      this.statusBarItem
    );

    this.probesViewProvider = new ConfiguredKprobesProvider(this.store);
    this.eventsViewProvider = new TraceEventsProvider(this.store);
    this.disposables.push(
      this.probesViewProvider,
      this.eventsViewProvider,
      vscode.window.registerTreeDataProvider('kdev.kprobe.probesView', this.probesViewProvider),
      vscode.window.registerTreeDataProvider('kdev.kprobe.eventsView', this.eventsViewProvider)
    );

    const storeSub1 = this.store.onDidChangeProbes(() => this.refreshAllDecorations());
    const storeSub2 = this.store.onDidChangeEvents(() => this.refreshAllDecorations());
    const storeSub3 = this.store.onDidSelectEvent(() => this.refreshAllDecorations());
    this.disposables.push(storeSub1, storeSub2, storeSub3);

    this.registerHoverProvider();
    this.registerEditorListeners();
    this.registerFileWatchers();
    this.registerCommands();

    this.initializeState();
  }

  public updatePaths(paths: ResolvedWorkspacePaths): void {
    this.paths = paths;
    this.refreshAllDecorations();
  }

  public ensureSetupScriptExported(): void {
    this.persistAndWriteScript();
  }

  public reloadTraceLogSilent(): void {
    this.loadTraceLogInternal(true);
  }

  private getPerfOptions(): PerfProbeOptions {
    return {
      perfBin: this.paths.perfBin,
      vmlinuxPath: this.paths.vmlinuxPath,
      kernelDir: this.paths.kernelDir,
    };
  }

  private getCurrentVmlinuxMtime(): number {
    try {
      return fs.statSync(this.paths.vmlinuxPath).mtimeMs;
    } catch {
      return 0;
    }
  }

  private initializeState(): void {
    try {
      this.store.load();
      const vmlinuxMtime = this.getCurrentVmlinuxMtime();
      if (vmlinuxMtime > 0) {
        this.store.checkStaleness(vmlinuxMtime);
      }
      if (this.paths.autoLoadTrace && fs.existsSync(this.paths.traceLogPath)) {
        this.loadTraceLogInternal(true);
      }
      this.refreshAllDecorations();
    } catch (err) {
      this.logger(`[kprobe] Failed to initialize probe store: ${String(err)}`);
    }
  }

  private persistAndWriteScript(): void {
    this.store.save();
    writeTracefsSetup(this.paths.setupScriptPath, this.store.getProbes(), this.paths.traceGroup);
  }

  private registerHoverProvider(): void {
    const provider = vscode.languages.registerHoverProvider('c', {
      provideHover: (document, position) => {
        const fileRel = toKernelRelativePath(this.paths.kernelDir, document.uri.fsPath);
        if (!fileRel) {
          return undefined;
        }
        const probes = this.store.getProbesAtLine(fileRel, position.line + 1);
        if (probes.length === 0) {
          return undefined;
        }

        const md = new vscode.MarkdownString();
        md.isTrusted = true;

        for (let i = 0; i < probes.length; i += 1) {
          const probe = probes[i];
          if (i > 0) {
            md.appendMarkdown('\n---\n\n');
          }
          md.appendMarkdown(
            `### Kprobe \`${probe.group}:${probe.id}\` (${probe.kind}) — **${probe.status.toUpperCase()}**${probe.enabled ? '' : ' *(disabled)*'}\n\n`
          );
          if (probe.lastError) {
            md.appendMarkdown(`> Error: ${probe.lastError}\n\n`);
          }
          if (probe.definitions.length > 0) {
            md.appendCodeblock(probe.definitions.join('\n'), 'text');
          }

          const hits = this.store.getEventsForProbe(probe.id);
          if (hits.length > 0) {
            const recent = hits.slice(-10).reverse();
            md.appendMarkdown(
              `\n**Recent Hits (${recent.length} of ${hits.length})**\n\n`
            );
            md.appendMarkdown('| # | Timestamp | Task-PID | CPU | Captured Values |\n');
            md.appendMarkdown('| ---: | ---: | :--- | ---: | :--- |\n');
            for (const ev of recent) {
              const vals = (ev.argsText || ev.symbol).replace(/\|/g, '\\|');
              md.appendMarkdown(
                `| ${ev.index} | ${ev.timestamp.toFixed(6)}s | \`${ev.task}-${ev.pid}\` | ${ev.cpu} | \`${vals}\` |\n`
              );
            }
          } else {
            md.appendMarkdown('\n*No trace events recorded yet.*\n');
          }
        }

        md.appendMarkdown(
          '\n\n[Re-resolve](command:kdev.kprobe.reResolveAll) | [Remove](command:kdev.kprobe.removeAtCursor)'
        );
        return new vscode.Hover(md);
      },
    });
    this.disposables.push(provider);
  }

  private registerEditorListeners(): void {
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor) {
          this.applyDecorationsToEditor(editor);
        }
      }),
      vscode.window.onDidChangeVisibleTextEditors((editors) => {
        for (const editor of editors) {
          this.applyDecorationsToEditor(editor);
        }
      }),
      vscode.workspace.onDidChangeTextDocument((event) => {
        const fileRel = toKernelRelativePath(this.paths.kernelDir, event.document.uri.fsPath);
        if (!fileRel) {
          return;
        }
        let shifted = false;
        for (const change of event.contentChanges) {
          const oldLineSpan = change.range.end.line - change.range.start.line;
          const newLineSpan = change.text.split('\n').length - 1;
          const delta = newLineSpan - oldLineSpan;
          if (delta !== 0) {
            const didShift = this.store.adjustLinesForDocumentEdit(
              fileRel,
              change.range.start.line + 1,
              delta
            );
            if (didShift) {
              shifted = true;
            }
          }
        }
        if (shifted) {
          this.store.save();
          this.refreshAllDecorations();
        }
      })
    );
  }

  private registerFileWatchers(): void {
    const tracePattern = new vscode.RelativePattern(this.paths.sharedDir, 'trace.log');
    const traceWatcher = vscode.workspace.createFileSystemWatcher(tracePattern);
    const onTraceTouched = () => {
      if (!this.paths.autoLoadTrace) {
        return;
      }
      if (this.traceDebounceTimer) {
        clearTimeout(this.traceDebounceTimer);
      }
      this.traceDebounceTimer = setTimeout(() => {
        this.loadTraceLogInternal(true);
      }, 300);
    };
    traceWatcher.onDidChange(onTraceTouched);
    traceWatcher.onDidCreate(onTraceTouched);
    this.disposables.push(traceWatcher);

    const vmlinuxPattern = new vscode.RelativePattern(this.paths.buildDir, 'vmlinux');
    const vmlinuxWatcher = vscode.workspace.createFileSystemWatcher(vmlinuxPattern);
    const onVmlinuxTouched = () => {
      if (this.vmlinuxDebounceTimer) {
        clearTimeout(this.vmlinuxDebounceTimer);
      }
      this.vmlinuxDebounceTimer = setTimeout(() => {
        void this.handleVmlinuxUpdated();
      }, 1000);
    };
    vmlinuxWatcher.onDidChange(onVmlinuxTouched);
    vmlinuxWatcher.onDidCreate(onVmlinuxTouched);
    this.disposables.push(vmlinuxWatcher);
  }

  private async handleVmlinuxUpdated(): Promise<void> {
    const mtime = this.getCurrentVmlinuxMtime();
    if (mtime <= 0) {
      return;
    }
    const staleCount = this.store.checkStaleness(mtime);
    if (staleCount > 0) {
      this.store.save();
      this.refreshAllDecorations();
      const action = await vscode.window.showInformationMessage(
        `vmlinux was rebuilt: ${staleCount} Kprobe(s) may have stale offsets.`,
        'Re-resolve Now'
      );
      if (action === 'Re-resolve Now') {
        await this.reResolveAll();
      }
    }
  }

  private loadTraceLogInternal(silent: boolean): void {
    if (!fs.existsSync(this.paths.traceLogPath)) {
      if (!silent) {
        void vscode.window.showWarningMessage(
          `Trace log not found at ${this.paths.traceLogPath}. Run QEMU first.`
        );
      }
      return;
    }

    const result = parseTraceLogFile(
      this.paths.traceLogPath,
      this.store.getProbes(),
      this.paths.maxTraceEvents
    );
    this.store.setEvents(result);

    const truncSuffix = result.truncated ? ` (truncated from ${result.totalMatched})` : '';
    this.statusBarItem.text = `$(pulse) kdev: ${result.events.length} trace events loaded${truncSuffix}`;
    this.statusBarItem.show();
    this.logger(`[kprobe] Loaded ${result.events.length} trace events from ${this.paths.traceLogPath}${truncSuffix}`);

    if (result.truncated) {
      void vscode.window.showWarningMessage(
        `trace.log had ${result.totalMatched} events; showing the first ${result.events.length} (kdev.kprobe.maxTraceEvents).`
      );
    } else if (!silent) {
      void vscode.window.showInformationMessage(
        `Loaded ${result.events.length} trace events from trace.log.`
      );
    }
  }

  private refreshAllDecorations(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      this.applyDecorationsToEditor(editor);
    }
  }

  private formatInlineText(probe: KprobeSpec, selectedEvent: TraceEvent | undefined): string {
    const hits = this.store.getEventsForProbe(probe.id);

    if (selectedEvent && selectedEvent.probeId === probe.id) {
      const payload = selectedEvent.argsText || selectedEvent.symbol;
      return `  ◀ [SELECTED #${selectedEvent.index}/${hits.length} @ ${selectedEvent.timestamp.toFixed(6)}s] ${selectedEvent.task}-${selectedEvent.pid} | ${payload}`;
    }

    if (hits.length > 0) {
      const last = hits[hits.length - 1];
      const payload = last.argsText || last.symbol;
      return `  ◀ [${hits.length} hits | last @ ${last.timestamp.toFixed(6)}s] ${payload}`;
    }

    if (probe.status === 'stale') {
      return `  ◀ [${probe.group}:${probe.id} STALE — re-resolve]`;
    }
    if (probe.status === 'error') {
      return `  ◀ [${probe.group}:${probe.id} ERROR — re-resolve]`;
    }

    const allVars = [...probe.vars, ...probe.customExprs];
    const varsText = allVars.length > 0 ? ` vars: ${allVars.join(', ')}` : '';
    const disabledTag = probe.enabled ? '' : ' (disabled)';
    return `  ◀ [${probe.group}:${probe.id}${disabledTag}]${varsText}`;
  }

  private applyDecorationsToEditor(editor: vscode.TextEditor): void {
    const fileRel = toKernelRelativePath(this.paths.kernelDir, editor.document.uri.fsPath);
    if (!fileRel) {
      editor.setDecorations(this.validGutterDecoration, []);
      editor.setDecorations(this.disabledGutterDecoration, []);
      editor.setDecorations(this.staleGutterDecoration, []);
      editor.setDecorations(this.inlineTextDecoration, []);
      return;
    }

    const probes = this.store.getProbesForFile(fileRel);
    const validRanges: vscode.Range[] = [];
    const disabledRanges: vscode.Range[] = [];
    const staleRanges: vscode.Range[] = [];
    const inlineDecorations: vscode.DecorationOptions[] = [];

    const selectedEvent = this.store.getSelectedEvent();
    const lineCount = editor.document.lineCount;

    // Group probes by line so multiple probes on the same line combine cleanly
    const byLine = new Map<number, KprobeSpec[]>();
    for (const probe of probes) {
      if (probe.line < 1 || probe.line > lineCount) {
        continue;
      }
      const list = byLine.get(probe.line) ?? [];
      list.push(probe);
      byLine.set(probe.line, list);
    }

    for (const [lineNum, lineProbes] of byLine.entries()) {
      const zeroLine = lineNum - 1;
      const lineText = editor.document.lineAt(zeroLine);
      const gutterRange = new vscode.Range(zeroLine, 0, zeroLine, 0);

      const hasStaleOrError = lineProbes.some((p) => p.status === 'stale' || p.status === 'error');
      const hasEnabled = lineProbes.some((p) => p.enabled);

      if (hasStaleOrError) {
        staleRanges.push(gutterRange);
      } else if (hasEnabled) {
        validRanges.push(gutterRange);
      } else {
        disabledRanges.push(gutterRange);
      }

      const inlineText = lineProbes
        .map((p) => this.formatInlineText(p, selectedEvent))
        .join(' ');
      const endPos = lineText.range.end;
      inlineDecorations.push({
        range: new vscode.Range(endPos, endPos),
        renderOptions: {
          after: {
            contentText: inlineText,
          },
        },
      });
    }

    editor.setDecorations(this.validGutterDecoration, validRanges);
    editor.setDecorations(this.disabledGutterDecoration, disabledRanges);
    editor.setDecorations(this.staleGutterDecoration, staleRanges);
    editor.setDecorations(this.inlineTextDecoration, inlineDecorations);
  }

  private registerCommands(): void {
    this.disposables.push(
      vscode.commands.registerCommand('kdev.kprobe.addAtCursor', () => this.addAtCursor()),
      vscode.commands.registerCommand('kdev.kprobe.addReturnProbe', () => this.addReturnProbe()),
      vscode.commands.registerCommand('kdev.kprobe.removeAtCursor', () => this.removeAtCursor()),
      vscode.commands.registerCommand(
        'kdev.kprobe.toggleProbe',
        (item?: KprobeTreeItem | string) => this.toggleProbe(item)
      ),
      vscode.commands.registerCommand(
        'kdev.kprobe.editProbeVars',
        (item?: KprobeTreeItem | string) => this.editProbeVars(item)
      ),
      vscode.commands.registerCommand(
        'kdev.kprobe.deleteProbe',
        (item?: KprobeTreeItem | string) => this.deleteProbe(item)
      ),
      vscode.commands.registerCommand('kdev.kprobe.reResolveAll', () => this.reResolveAll()),
      vscode.commands.registerCommand('kdev.kprobe.exportSetupScript', () =>
        this.exportSetupScript()
      ),
      vscode.commands.registerCommand('kdev.kprobe.loadTraceLog', () =>
        this.loadTraceLogInternal(false)
      ),
      vscode.commands.registerCommand('kdev.kprobe.filterEvents', () => this.filterEvents()),
      vscode.commands.registerCommand('kdev.kprobe.clearAll', () => this.clearAll()),
      vscode.commands.registerCommand(
        'kdev.kprobe.jumpToEvent',
        (args?: JumpToEventArgs) => this.jumpToEvent(args)
      )
    );
  }

  private ensureVmlinuxExists(): boolean {
    if (!fs.existsSync(this.paths.vmlinuxPath)) {
      void vscode.window.showErrorMessage(
        `vmlinux not found at ${this.paths.vmlinuxPath}. Build the kernel first.`
      );
      return false;
    }
    return true;
  }

  private getActiveKernelLocation():
    | { editor: vscode.TextEditor; fileRel: string; line: number }
    | undefined {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      void vscode.window.showWarningMessage('Open a Linux kernel C source file first.');
      return undefined;
    }
    const fileRel = toKernelRelativePath(this.paths.kernelDir, editor.document.uri.fsPath);
    if (!fileRel) {
      void vscode.window.showWarningMessage(
        `Active file is outside the configured kernel directory (${this.paths.kernelDir}).`
      );
      return undefined;
    }
    return {
      editor,
      fileRel,
      line: editor.selection.active.line + 1,
    };
  }

  private async pickVarsAndCustomExprs(
    fileRel: string,
    line: number,
    preselectedVars: string[] = [],
    initialCustomExprs: string[] = []
  ): Promise<{ vars: string[]; customExprs: string[] } | undefined> {
    const available = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Querying DWARF variables at ${fileRel}:${line}...`,
      },
      () => queryAvailableVars(this.getPerfOptions(), fileRel, line)
    );

    let selectedVars: string[] = [];
    if (available.length > 0) {
      const preSet = new Set(preselectedVars);
      const items: vscode.QuickPickItem[] = available.map((v) => ({
        label: v.name,
        description: v.type,
        picked: preSet.has(v.name),
      }));
      const picked = await vscode.window.showQuickPick(items, {
        canPickMany: true,
        title: `Select variables to capture at ${fileRel}:${line}`,
        placeHolder: 'Pick local variables (optional) and press Enter',
      });
      if (!picked) {
        return undefined;
      }
      selectedVars = picked.map((p) => p.label);
    }

    const customInput = await vscode.window.showInputBox({
      title: `Custom perf probe expressions at ${fileRel}:${line} (optional)`,
      prompt: 'Space-separated expressions, e.g. file->f_flags $retval (leave empty for none)',
      value: initialCustomExprs.join(' '),
      validateInput: (val) => {
        const trimmed = val.trim();
        if (!trimmed) {
          return undefined;
        }
        for (const token of trimmed.split(/\s+/)) {
          try {
            validateCustomExpr(token);
          } catch (err) {
            return err instanceof Error ? err.message : String(err);
          }
        }
        return undefined;
      },
    });
    if (customInput === undefined) {
      return undefined;
    }

    const customExprs = customInput.trim() ? customInput.trim().split(/\s+/) : [];
    return { vars: selectedVars, customExprs };
  }

  private async addAtCursor(): Promise<void> {
    if (!this.ensureVmlinuxExists()) {
      return;
    }
    const loc = this.getActiveKernelLocation();
    if (!loc) {
      return;
    }

    let targetLine = loc.line;
    const selection = await this.pickVarsAndCustomExprs(loc.fileRel, targetLine);
    if (!selection) {
      return;
    }

    const probeId = this.store.allocateNextProbeId();
    const group = this.paths.traceGroup;
    let definitions: string[];

    try {
      definitions = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Resolving Kprobe ${group}:${probeId} at ${loc.fileRel}:${targetLine}...`,
        },
        () =>
          generateDefinitions(this.getPerfOptions(), {
            id: probeId,
            group,
            kind: 'kprobe',
            file: loc.fileRel,
            line: targetLine,
            vars: selection.vars,
            customExprs: selection.customExprs,
          })
      );
    } catch (err) {
      this.logger(`[kprobe] Direct resolution failed at ${loc.fileRel}:${targetLine}: ${String(err)}`);
      const nearby = await queryProbeableLines(this.getPerfOptions(), loc.fileRel, targetLine, 5);
      if (nearby.length === 0) {
        void vscode.window.showErrorMessage(
          `Failed to resolve Kprobe at ${loc.fileRel}:${targetLine}: ${err instanceof Error ? err.message : String(err)}`
        );
        return;
      }

      const pick = await vscode.window.showQuickPick(
        nearby.map((n) => ({
          label: `Line ${n.line}`,
          description: n.code.trim(),
          lineNum: n.line,
        })),
        {
          title: `Line ${targetLine} is not directly probeable. Select a nearby probeable line:`,
          placeHolder: 'Choose a fallback line from perf probe -L',
        }
      );
      if (!pick) {
        return;
      }

      targetLine = pick.lineNum;
      try {
        definitions = await generateDefinitions(this.getPerfOptions(), {
          id: probeId,
          group,
          kind: 'kprobe',
          file: loc.fileRel,
          line: targetLine,
          vars: selection.vars,
          customExprs: selection.customExprs,
        });
      } catch (retryErr) {
        void vscode.window.showErrorMessage(
          `Failed to resolve Kprobe at fallback line ${loc.fileRel}:${targetLine}: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`
        );
        return;
      }
    }

    const spec: KprobeSpec = {
      id: probeId,
      group,
      kind: 'kprobe',
      enabled: true,
      file: loc.fileRel,
      line: targetLine,
      vars: selection.vars,
      customExprs: selection.customExprs,
      definitions,
      vmlinuxMtimeMs: this.getCurrentVmlinuxMtime(),
      status: 'valid',
    };

    this.store.addProbe(spec);
    this.persistAndWriteScript();
    void vscode.window.showInformationMessage(
      `Added Kprobe ${group}:${probeId} at ${loc.fileRel}:${targetLine} (${definitions.length} Tracefs def).`
    );
  }

  private async detectEnclosingFunctionName(
    document: vscode.TextDocument,
    lineZeroBased: number
  ): Promise<string> {
    try {
      const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
        'vscode.executeDocumentSymbolProvider',
        document.uri
      );
      if (Array.isArray(symbols)) {
        const findContaining = (list: vscode.DocumentSymbol[]): string | undefined => {
          for (const sym of list) {
            if (
              sym.kind === vscode.SymbolKind.Function &&
              sym.range.start.line <= lineZeroBased &&
              sym.range.end.line >= lineZeroBased
            ) {
              return sym.name.replace(/\(.*/, '').trim();
            }
            const nested = findContaining(sym.children);
            if (nested) {
              return nested;
            }
          }
          return undefined;
        };
        const found = findContaining(symbols);
        if (found) {
          return found;
        }
      }
    } catch {
      // Fall back to heuristic text scan below.
    }

    // Heuristic upward scan for C function signature
    for (let l = lineZeroBased; l >= Math.max(0, lineZeroBased - 200); l -= 1) {
      const text = document.lineAt(l).text;
      const match = text.match(/^(?:[a-zA-Z_][a-zA-Z0-9_\s*]*\s+)?([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/);
      if (
        match &&
        !['if', 'for', 'while', 'switch', 'return', 'sizeof'].includes(match[1]) &&
        !text.trimStart().startsWith('*') &&
        !text.trimStart().startsWith('//')
      ) {
        return match[1];
      }
    }
    return '';
  }

  private async addReturnProbe(): Promise<void> {
    if (!this.ensureVmlinuxExists()) {
      return;
    }
    const loc = this.getActiveKernelLocation();
    if (!loc) {
      return;
    }

    const guessedFunc = await this.detectEnclosingFunctionName(
      loc.editor.document,
      loc.line - 1
    );
    const funcName = await vscode.window.showInputBox({
      title: 'Add Kretprobe ($retval)',
      prompt: 'Kernel function name to probe on return',
      value: guessedFunc,
      validateInput: (val) =>
        /^[a-zA-Z_][a-zA-Z0-9_.]*$/.test(val.trim())
          ? undefined
          : 'Enter a valid C function symbol name',
    });
    if (!funcName) {
      return;
    }

    const customInput = await vscode.window.showInputBox({
      title: `Additional expressions for ${funcName.trim()}%return (optional)`,
      prompt: '$retval is captured automatically. Add extra space-separated expressions if desired.',
      value: '',
      validateInput: (val) => {
        const trimmed = val.trim();
        if (!trimmed) {
          return undefined;
        }
        for (const token of trimmed.split(/\s+/)) {
          try {
            validateCustomExpr(token);
          } catch (err) {
            return err instanceof Error ? err.message : String(err);
          }
        }
        return undefined;
      },
    });
    if (customInput === undefined) {
      return;
    }

    const customExprs = customInput.trim() ? customInput.trim().split(/\s+/) : [];
    const probeId = this.store.allocateNextProbeId();
    const group = this.paths.traceGroup;

    let definitions: string[];
    try {
      definitions = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Resolving Kretprobe ${group}:${probeId} on ${funcName.trim()}%return...`,
        },
        () =>
          generateDefinitions(this.getPerfOptions(), {
            id: probeId,
            group,
            kind: 'kretprobe',
            file: loc.fileRel,
            line: loc.line,
            funcName: funcName.trim(),
            vars: [],
            customExprs,
          })
      );
    } catch (err) {
      void vscode.window.showErrorMessage(
        `Failed to resolve Kretprobe on ${funcName.trim()}: ${err instanceof Error ? err.message : String(err)}`
      );
      return;
    }

    const spec: KprobeSpec = {
      id: probeId,
      group,
      kind: 'kretprobe',
      enabled: true,
      file: loc.fileRel,
      line: loc.line,
      funcName: funcName.trim(),
      vars: [],
      customExprs: customExprs.includes('$retval') ? customExprs : ['$retval', ...customExprs],
      definitions,
      vmlinuxMtimeMs: this.getCurrentVmlinuxMtime(),
      status: 'valid',
    };

    this.store.addProbe(spec);
    this.persistAndWriteScript();
    void vscode.window.showInformationMessage(
      `Added Kretprobe ${group}:${probeId} on ${funcName.trim()}%return.`
    );
  }

  private async removeAtCursor(): Promise<void> {
    const loc = this.getActiveKernelLocation();
    if (!loc) {
      return;
    }
    const probes = this.store.getProbesAtLine(loc.fileRel, loc.line);
    if (probes.length === 0) {
      void vscode.window.showInformationMessage(
        `No Kprobe configured at ${loc.fileRel}:${loc.line}.`
      );
      return;
    }

    let targetId = probes[0].id;
    if (probes.length > 1) {
      const picked = await vscode.window.showQuickPick(
        probes.map((p) => ({
          label: p.id,
          description: `${p.kind} (${[...p.vars, ...p.customExprs].join(', ') || 'no vars'})`,
        })),
        { title: 'Select Kprobe to remove' }
      );
      if (!picked) {
        return;
      }
      targetId = picked.label;
    }

    this.store.removeProbe(targetId);
    this.persistAndWriteScript();
  }

  private async resolveProbeIdArg(item?: KprobeTreeItem | string): Promise<string | undefined> {
    if (typeof item === 'string') {
      return item;
    }
    if (item instanceof KprobeTreeItem) {
      return item.probe.id;
    }
    const probes = this.store.getProbes();
    if (probes.length === 0) {
      void vscode.window.showInformationMessage('No Kprobes configured.');
      return undefined;
    }
    const picked = await vscode.window.showQuickPick(
      probes.map((p) => ({
        label: p.id,
        description: `${p.file}:${p.line}`,
      })),
      { title: 'Select a Kprobe' }
    );
    return picked?.label;
  }

  private async toggleProbe(item?: KprobeTreeItem | string): Promise<void> {
    const id = await this.resolveProbeIdArg(item);
    if (!id) {
      return;
    }
    this.store.toggleProbe(id);
    this.persistAndWriteScript();
  }

  private async deleteProbe(item?: KprobeTreeItem | string): Promise<void> {
    const id = await this.resolveProbeIdArg(item);
    if (!id) {
      return;
    }
    this.store.removeProbe(id);
    this.persistAndWriteScript();
  }

  private async editProbeVars(item?: KprobeTreeItem | string): Promise<void> {
    if (!this.ensureVmlinuxExists()) {
      return;
    }
    const id = await this.resolveProbeIdArg(item);
    if (!id) {
      return;
    }
    const probe = this.store.getProbeById(id);
    if (!probe) {
      return;
    }

    let nextVars = probe.vars;
    let nextCustom = probe.customExprs;

    if (probe.kind === 'kretprobe') {
      const customInput = await vscode.window.showInputBox({
        title: `Edit expressions for ${probe.id} (${probe.funcName}%return)`,
        value: probe.customExprs.join(' '),
        validateInput: (val) => {
          const trimmed = val.trim();
          if (!trimmed) {
            return undefined;
          }
          for (const token of trimmed.split(/\s+/)) {
            try {
              validateCustomExpr(token);
            } catch (err) {
              return err instanceof Error ? err.message : String(err);
            }
          }
          return undefined;
        },
      });
      if (customInput === undefined) {
        return;
      }
      nextCustom = customInput.trim() ? customInput.trim().split(/\s+/) : ['$retval'];
      nextVars = [];
    } else {
      const selection = await this.pickVarsAndCustomExprs(
        probe.file,
        probe.line,
        probe.vars,
        probe.customExprs
      );
      if (!selection) {
        return;
      }
      nextVars = selection.vars;
      nextCustom = selection.customExprs;
    }

    try {
      const definitions = await generateDefinitions(this.getPerfOptions(), {
        id: probe.id,
        group: probe.group,
        kind: probe.kind,
        file: probe.file,
        line: probe.line,
        funcName: probe.funcName,
        vars: nextVars,
        customExprs: nextCustom,
        module: probe.module,
      });

      this.store.updateProbe(probe.id, (cur) => ({
        ...cur,
        vars: nextVars,
        customExprs: nextCustom,
        definitions,
        vmlinuxMtimeMs: this.getCurrentVmlinuxMtime(),
        status: 'valid',
        lastError: undefined,
      }));
      this.persistAndWriteScript();
    } catch (err) {
      void vscode.window.showErrorMessage(
        `Failed to update Kprobe ${probe.id}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  public async reResolveAll(): Promise<void> {
    if (!this.ensureVmlinuxExists()) {
      return;
    }
    const probes = this.store.getProbes();
    if (probes.length === 0) {
      void vscode.window.showInformationMessage('No Kprobes to re-resolve.');
      return;
    }

    const vmlinuxMtime = this.getCurrentVmlinuxMtime();
    let okCount = 0;
    let errCount = 0;

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Re-resolving ${probes.length} Kprobe(s)...`,
      },
      async () => {
        for (const probe of probes) {
          try {
            const definitions = await generateDefinitions(this.getPerfOptions(), {
              id: probe.id,
              group: probe.group,
              kind: probe.kind,
              file: probe.file,
              line: probe.line,
              funcName: probe.funcName,
              vars: probe.vars,
              customExprs: probe.customExprs,
              module: probe.module,
            });
            this.store.updateProbe(probe.id, (cur) => ({
              ...cur,
              definitions,
              vmlinuxMtimeMs: vmlinuxMtime,
              status: 'valid',
              lastError: undefined,
            }));
            okCount += 1;
          } catch (err) {
            const msg = err instanceof PerfProbeError ? err.message : String(err);
            this.store.updateProbe(probe.id, (cur) => ({
              ...cur,
              status: 'error',
              lastError: msg,
            }));
            errCount += 1;
          }
        }
      }
    );

    this.persistAndWriteScript();
    if (errCount > 0) {
      void vscode.window.showWarningMessage(
        `Re-resolved ${okCount} Kprobe(s); ${errCount} failed (hover or check Configured Kprobes).`
      );
    } else {
      void vscode.window.showInformationMessage(`Re-resolved all ${okCount} Kprobe(s).`);
    }
  }

  private async exportSetupScript(): Promise<void> {
    this.persistAndWriteScript();
    const action = await vscode.window.showInformationMessage(
      `Exported ${this.paths.setupScriptPath}`,
      'Open Script'
    );
    if (action === 'Open Script') {
      const doc = await vscode.workspace.openTextDocument(this.paths.setupScriptPath);
      await vscode.window.showTextDocument(doc);
    }
  }

  private async filterEvents(): Promise<void> {
    const probes = this.store.getProbes();
    const current = this.store.getEventFilter();

    const items: Array<vscode.QuickPickItem & { action: 'clear' | 'text' | 'probe'; probeId?: string }> = [
      {
        label: '$(clear-all) Clear Filter',
        description: 'Show all loaded trace events',
        action: 'clear',
      },
      {
        label: '$(search) Filter by Text...',
        description: current.text ? `Current: "${current.text}"` : 'Match task, symbol, or args',
        action: 'text',
      },
      ...probes.map((p) => ({
        label: `$(pulse) Probe ${p.id}`,
        description: `${p.file}:${p.line} (${this.store.getHitCount(p.id)} hits)`,
        action: 'probe' as const,
        probeId: p.id,
      })),
    ];

    const picked = await vscode.window.showQuickPick(items, {
      title: 'Filter Trace Events',
    });
    if (!picked) {
      return;
    }

    if (picked.action === 'clear') {
      this.store.setEventFilter({});
      return;
    }
    if (picked.action === 'probe') {
      this.store.setEventFilter({ ...current, probeId: picked.probeId });
      return;
    }

    const text = await vscode.window.showInputBox({
      title: 'Filter Trace Events by Text',
      prompt: 'Enter substring to match task, event name, symbol, or arguments (empty to clear)',
      value: current.text ?? '',
    });
    if (text === undefined) {
      return;
    }
    this.store.setEventFilter({ ...current, text: text.trim() || undefined });
  }

  private async clearAll(): Promise<void> {
    if (this.store.getProbes().length === 0) {
      return;
    }
    const confirm = await vscode.window.showWarningMessage(
      'Clear all configured Kprobes?',
      { modal: true },
      'Clear All'
    );
    if (confirm !== 'Clear All') {
      return;
    }
    this.store.clearProbes();
    this.persistAndWriteScript();
  }

  private async jumpToEvent(args?: JumpToEventArgs): Promise<void> {
    if (!args) {
      return;
    }
    if (typeof args.eventIndex === 'number') {
      this.store.selectEvent(args.eventIndex);
    }

    let fileRel = args.file;
    let line = args.line;
    if ((!fileRel || !line) && args.probeId) {
      const probe = this.store.getProbeById(args.probeId);
      if (probe) {
        fileRel = probe.file;
        line = probe.line;
      }
    }

    if (!fileRel || !line) {
      return;
    }

    const absPath = path.join(this.paths.kernelDir, ...fileRel.split('/'));
    if (!fs.existsSync(absPath)) {
      void vscode.window.showWarningMessage(`Kernel source file not found: ${absPath}`);
      return;
    }

    const doc = await vscode.workspace.openTextDocument(absPath);
    const editor = await vscode.window.showTextDocument(doc, {
      preview: false,
      viewColumn: args.viewColumn,
    });
    const zeroLine = Math.max(0, Math.min(line - 1, doc.lineCount - 1));
    const pos = new vscode.Position(zeroLine, 0);
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
    this.applyDecorationsToEditor(editor);
  }

  public dispose(): void {
    if (this.traceDebounceTimer) {
      clearTimeout(this.traceDebounceTimer);
    }
    if (this.vmlinuxDebounceTimer) {
      clearTimeout(this.vmlinuxDebounceTimer);
    }
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
