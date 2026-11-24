import * as vscode from 'vscode';
import { BranchInfo, BranchRole, StackCommit, StackInspection } from './types';

export class BranchCategoryItem extends vscode.TreeItem {
  constructor(
    public readonly role: BranchRole,
    label: string,
    count: number,
    collapsibleState: vscode.TreeItemCollapsibleState
  ) {
    super(label, collapsibleState);
    this.description = `${count}`;
    this.contextValue = `branchCategory_${role}`;
    this.iconPath =
      role === 'topic'
        ? new vscode.ThemeIcon('git-branch')
        : role === 'review'
          ? new vscode.ThemeIcon('eye')
          : role === 'maintainer'
            ? new vscode.ThemeIcon('shield')
            : new vscode.ThemeIcon('repo');
  }
}

export class BranchTreeItem extends vscode.TreeItem {
  constructor(public readonly branch: BranchInfo) {
    super(branch.name, vscode.TreeItemCollapsibleState.None);

    const badges: string[] = [];
    if (branch.isCurrent) {
      badges.push('active');
    }
    if (typeof branch.aheadCount === 'number' && branch.aheadCount > 0) {
      badges.push(`+${branch.aheadCount}`);
    }
    if (branch.version) {
      badges.push(`v${branch.version}`);
    }
    if (branch.cadence) {
      badges.push(branch.cadence);
    }

    this.description = badges.join(' · ');
    this.contextValue =
      branch.role === 'topic'
        ? 'branchTopic'
        : branch.role === 'review'
          ? 'branchReview'
          : branch.role === 'maintainer'
            ? 'branchMaintainer'
            : 'branchOther';

    this.iconPath = branch.isCurrent
      ? new vscode.ThemeIcon('check', new vscode.ThemeColor('charts.green'))
      : new vscode.ThemeIcon('git-branch');

    const tip = [
      `**${branch.name}** (${branch.role})`,
      branch.baseRef ? `Base: \`${branch.baseRef}\`` : '',
      branch.upstreamRef ? `Upstream: \`${branch.upstreamRef}\`` : '',
      branch.cadence ? `Cadence: \`${branch.cadence}\`` : '',
      branch.sourceMsgId ? `Message-ID: \`${branch.sourceMsgId}\`` : '',
    ].filter(Boolean);
    this.tooltip = new vscode.MarkdownString(tip.join('\n\n'));
  }
}

export class ActionHintItem extends vscode.TreeItem {
  constructor(label: string, commandId: string, iconId = 'settings-gear', description?: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = description;
    this.iconPath = new vscode.ThemeIcon(iconId);
    this.contextValue = 'actionHint';
    this.command = { command: commandId, title: label };
  }
}

type BranchesTreeNode = BranchCategoryItem | BranchTreeItem | ActionHintItem;

export class KernelBranchesProvider implements vscode.TreeDataProvider<BranchesTreeNode>, vscode.Disposable {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<BranchesTreeNode | undefined | void>();
  public readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private branches: BranchInfo[] = [];

  public setBranches(branches: BranchInfo[]): void {
    this.branches = branches;
    this._onDidChangeTreeData.fire();
  }

  public getTreeItem(element: BranchesTreeNode): vscode.TreeItem {
    return element;
  }

  public getChildren(element?: BranchesTreeNode): BranchesTreeNode[] {
    if (!element) {
      const countOf = (role: BranchRole) => this.branches.filter((b) => b.role === role).length;
      return [
        new BranchCategoryItem('topic', 'Topics', countOf('topic'), vscode.TreeItemCollapsibleState.Expanded),
        new BranchCategoryItem('review', 'Reviews', countOf('review'), vscode.TreeItemCollapsibleState.Expanded),
        new BranchCategoryItem('maintainer', 'Maintainer', countOf('maintainer'), vscode.TreeItemCollapsibleState.Expanded),
        new BranchCategoryItem('other', 'Other', countOf('other'), vscode.TreeItemCollapsibleState.Collapsed),
      ];
    }

    if (element instanceof BranchCategoryItem) {
      const items = this.branches
        .filter((b) => b.role === element.role)
        .map((b) => new BranchTreeItem(b));

      if (element.role === 'maintainer' && items.length === 0) {
        return [
          new ActionHintItem(
            'Configure Maintainer Branches...',
            'kdev.git.configureMaintainerBranches',
            'settings-gear',
            'kdev.git.maintainerPrefixes'
          ),
        ];
      }
      return items;
    }

    return [];
  }

  public dispose(): void {
    this._onDidChangeTreeData.dispose();
  }
}

export class StackBannerItem extends vscode.TreeItem {
  constructor(
    label: string,
    description: string,
    icon: vscode.ThemeIcon,
    commandId?: string
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = description;
    this.iconPath = icon;
    this.contextValue = 'stackBanner';
    if (commandId) {
      this.command = { command: commandId, title: label };
    }
  }
}

export class StackCommitItem extends vscode.TreeItem {
  constructor(
    public readonly commit: StackCommit,
    totalCount: number
  ) {
    super(`[${commit.index}/${totalCount}] ${commit.subject}`, vscode.TreeItemCollapsibleState.None);

    const flags: string[] = [commit.shortSha];
    if (commit.published) {
      flags.push('published');
    }
    if (!commit.hasSignedOffBy) {
      flags.push('no SoB');
    }
    this.description = flags.join(' · ');
    this.contextValue = commit.published ? 'stackCommitPublished' : 'stackCommitEditable';

    if (commit.published) {
      this.iconPath = new vscode.ThemeIcon('lock', new vscode.ThemeColor('charts.blue'));
    } else if (!commit.hasSignedOffBy) {
      this.iconPath = new vscode.ThemeIcon(
        'warning',
        new vscode.ThemeColor('editorWarning.foreground')
      );
    } else {
      this.iconPath = new vscode.ThemeIcon('git-commit');
    }

    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${commit.subject}**\n\n`);
    md.appendMarkdown(`- Commit: \`${commit.sha}\`\n`);
    md.appendMarkdown(`- Author: ${commit.author} (${commit.date})\n`);
    md.appendMarkdown(`- Signed-off-by: ${commit.hasSignedOffBy ? 'present' : '**MISSING**'}\n`);
    md.appendMarkdown(`- Published: ${commit.published ? 'Yes (protected)' : 'No (editable)'}\n`);
    this.tooltip = md;
  }
}

type StackTreeNode = StackBannerItem | StackCommitItem | ActionHintItem;

export class PatchStackProvider implements vscode.TreeDataProvider<StackTreeNode>, vscode.Disposable {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<StackTreeNode | undefined | void>();
  public readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private inspection: StackInspection | null = null;

  public setInspection(inspection: StackInspection | null): void {
    this.inspection = inspection;
    this._onDidChangeTreeData.fire();
  }

  public getTreeItem(element: StackTreeNode): vscode.TreeItem {
    return element;
  }

  public getChildren(): StackTreeNode[] {
    if (!this.inspection) {
      return [
        new StackBannerItem(
          'No Linux Git repository detected',
          'Check kdev.kernelSrcDir',
          new vscode.ThemeIcon('info')
        ),
      ];
    }

    const nodes: StackTreeNode[] = [];
    const ins = this.inspection;

    if (ins.opState !== 'clean') {
      nodes.push(
        new StackBannerItem(
          `${ins.opState.toUpperCase()} in Progress (${ins.conflictingFiles.length} conflict(s))`,
          ins.conflictingFiles.join(', ') || 'Resolve conflicts then Continue or Abort',
          new vscode.ThemeIcon('warning', new vscode.ThemeColor('errorForeground'))
        ),
        new ActionHintItem('Continue Rebase / Apply', 'kdev.git.continueConflict', 'play'),
        new ActionHintItem('Skip Conflicting Patch', 'kdev.git.skipConflict', 'debug-step-over'),
        new ActionHintItem('Abort Rebase / Apply', 'kdev.git.abortConflict', 'stop-circle')
      );
    }

    const headerDesc = [
      `base: ${ins.baseRef}`,
      `${ins.commits.length} patch(es)`,
      ins.undoCount > 0 ? `undo: ${ins.undoCount}` : '',
      ins.isDirty ? 'dirty' : '',
    ]
      .filter(Boolean)
      .join(' · ');

    nodes.push(
      new StackBannerItem(
        ins.branch || '(detached HEAD)',
        headerDesc,
        new vscode.ThemeIcon('git-branch')
      )
    );

    if (ins.poppedCount > 0) {
      nodes.push(
        new ActionHintItem(
          `Push Popped Commit (${ins.poppedCount} popped)`,
          'kdev.git.pushCommit',
          'fold-up'
        )
      );
    }

    // Top-of-stack at top (StGit intuition)
    const reversed = [...ins.commits].reverse();
    for (const commit of reversed) {
      nodes.push(new StackCommitItem(commit, ins.commits.length));
    }

    return nodes;
  }

  public dispose(): void {
    this._onDidChangeTreeData.dispose();
  }
}
