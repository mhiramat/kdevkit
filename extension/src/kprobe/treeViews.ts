import * as vscode from 'vscode';
import { ProbeStore } from './probeStore';
import { KprobeSpec, TraceEvent } from './types';

export interface JumpToEventArgs {
  file?: string;
  line?: number;
  eventIndex?: number;
  probeId?: string;
  viewColumn?: vscode.ViewColumn;
}

export class KprobeTreeItem extends vscode.TreeItem {
  constructor(
    public readonly probe: KprobeSpec,
    hitCount: number
  ) {
    super(`${probe.id}  ${probe.file}:${probe.line}`, vscode.TreeItemCollapsibleState.None);

    const exprs = [...probe.vars, ...probe.customExprs];
    const varsDesc = exprs.length > 0 ? exprs.join(', ') : 'no vars';
    const retPrefix = probe.kind === 'kretprobe' ? 'ret ' : '';
    const statusSuffix =
      probe.status === 'stale'
        ? ' [STALE]'
        : probe.status === 'error'
          ? ' [ERROR]'
          : !probe.enabled
            ? ' [OFF]'
            : '';

    this.description = `${retPrefix}${varsDesc} · ${hitCount} hits${statusSuffix}`;
    this.contextValue =
      probe.status === 'stale' || probe.status === 'error'
        ? 'kprobeStale'
        : probe.enabled
          ? 'kprobeEnabled'
          : 'kprobeDisabled';

    if (probe.status === 'error') {
      this.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground'));
    } else if (probe.status === 'stale') {
      this.iconPath = new vscode.ThemeIcon(
        'warning',
        new vscode.ThemeColor('editorWarning.foreground')
      );
    } else if (!probe.enabled) {
      this.iconPath = new vscode.ThemeIcon(
        'circle-outline',
        new vscode.ThemeColor('disabledForeground')
      );
    } else {
      this.iconPath = new vscode.ThemeIcon(
        'circle-filled',
        new vscode.ThemeColor('charts.yellow')
      );
    }

    const tooltipLines = [
      `**${probe.group}:${probe.id}** (${probe.kind})`,
      `Location: \`${probe.file}:${probe.line}\``,
      `Status: \`${probe.status}\` (${probe.enabled ? 'enabled' : 'disabled'})`,
    ];
    if (probe.funcName) {
      tooltipLines.push(`Function: \`${probe.funcName}\``);
    }
    if (probe.lastError) {
      tooltipLines.push(`Last Error: ${probe.lastError}`);
    }
    if (probe.definitions.length > 0) {
      tooltipLines.push('', '```text', ...probe.definitions, '```');
    }
    this.tooltip = new vscode.MarkdownString(tooltipLines.join('\n\n'));

    this.command = {
      command: 'kdev.kprobe.jumpToEvent',
      title: 'Jump to Probe',
      arguments: [{ file: probe.file, line: probe.line, probeId: probe.id } satisfies JumpToEventArgs],
    };
  }
}

export class ConfiguredKprobesProvider implements vscode.TreeDataProvider<KprobeTreeItem>, vscode.Disposable {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<KprobeTreeItem | undefined | void>();
  public readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private readonly disposables: Array<{ dispose(): void }> = [];

  constructor(private readonly store: ProbeStore) {
    this.disposables.push(
      this.store.onDidChangeProbes(() => this.refresh()),
      this.store.onDidChangeEvents(() => this.refresh())
    );
  }

  public refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  public getTreeItem(element: KprobeTreeItem): vscode.TreeItem {
    return element;
  }

  public getChildren(): KprobeTreeItem[] {
    return this.store
      .getProbes()
      .map((probe) => new KprobeTreeItem(probe, this.store.getHitCount(probe.id)));
  }

  public dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this._onDidChangeTreeData.dispose();
  }
}

export class TraceEventBannerItem extends vscode.TreeItem {
  constructor(label: string, description: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = description;
    this.iconPath = new vscode.ThemeIcon('info');
    this.contextValue = 'traceBanner';
    this.command = {
      command: 'kdev.kprobe.filterEvents',
      title: 'Filter Trace Events',
    };
  }
}

export class TraceEventTreeItem extends vscode.TreeItem {
  constructor(
    public readonly event: TraceEvent,
    probe: KprobeSpec | undefined,
    isSelected: boolean
  ) {
    super(
      `#${event.index} [${event.timestamp.toFixed(6)}s] ${event.eventName}`,
      vscode.TreeItemCollapsibleState.None
    );

    this.description = event.argsText || event.symbol;
    this.contextValue = 'traceEvent';
    this.iconPath = isSelected
      ? new vscode.ThemeIcon('debug-breakpoint-log', new vscode.ThemeColor('charts.yellow'))
      : new vscode.ThemeIcon('pulse');

    const argLines = Object.entries(event.argsMap).map(([k, v]) => `- \`${k}\` = \`${v}\``);
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**Event #${event.index}** (\`${event.eventName}\`)\n\n`);
    md.appendMarkdown(`- Task: \`${event.task}-${event.pid}\`\n`);
    md.appendMarkdown(`- CPU: \`${event.cpu}\` | Flags: \`${event.flags}\`\n`);
    md.appendMarkdown(`- Timestamp: \`${event.timestamp.toFixed(6)}s\`\n`);
    md.appendMarkdown(`- Symbol: \`${event.symbol}\`\n`);
    if (probe) {
      md.appendMarkdown(`- Source: \`${probe.file}:${probe.line}\`\n`);
    }
    if (argLines.length > 0) {
      md.appendMarkdown(`\n**Captured Values**\n${argLines.join('\n')}\n`);
    }
    this.tooltip = md;

    const jumpArgs: JumpToEventArgs = {
      file: probe?.file,
      line: probe?.line,
      eventIndex: event.index,
      probeId: probe?.id,
    };

    this.command = {
      command: 'kdev.kprobe.jumpToEvent',
      title: 'Jump to Trace Event',
      arguments: [jumpArgs],
    };
  }
}

type EventsTreeNode = TraceEventBannerItem | TraceEventTreeItem;

export class TraceEventsProvider implements vscode.TreeDataProvider<EventsTreeNode>, vscode.Disposable {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<EventsTreeNode | undefined | void>();
  public readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private readonly disposables: Array<{ dispose(): void }> = [];

  constructor(private readonly store: ProbeStore) {
    this.disposables.push(
      this.store.onDidChangeProbes(() => this.refresh()),
      this.store.onDidChangeEvents(() => this.refresh()),
      this.store.onDidSelectEvent(() => this.refresh())
    );
  }

  public refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  public getTreeItem(element: EventsTreeNode): vscode.TreeItem {
    return element;
  }

  public getChildren(): EventsTreeNode[] {
    const items: EventsTreeNode[] = [];
    const filter = this.store.getEventFilter();
    const filtered = this.store.getFilteredEvents();

    const bannerParts: string[] = [];
    if (filter.probeId) {
      bannerParts.push(`probe=${filter.probeId}`);
    }
    if (filter.text) {
      bannerParts.push(`text="${filter.text}"`);
    }
    if (this.store.isTraceTruncated()) {
      bannerParts.push(
        `truncated (${this.store.getEvents().length}/${this.store.getTotalTraceCount()})`
      );
    }

    if (bannerParts.length > 0) {
      items.push(
        new TraceEventBannerItem(
          `Showing ${filtered.length} events`,
          bannerParts.join(' · ')
        )
      );
    }

    const selectedIndex = this.store.getSelectedEventIndex();
    for (const ev of filtered) {
      const probe = ev.probeId ? this.store.getProbeById(ev.probeId) : undefined;
      items.push(new TraceEventTreeItem(ev, probe, ev.index === selectedIndex));
    }

    return items;
  }

  public dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this._onDidChangeTreeData.dispose();
  }
}
