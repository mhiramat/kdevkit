import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { UndineDMcpClient } from '../mcp/undinedClient';
import { ResolvedWorkspacePaths } from '../shared/workspacePaths';
import { runGit } from './gitRunner';
import { GitStackEngine } from './gitStackEngine';
import {
  applyMboxToMaintainerBranch,
  extractBaseCommitFromMbox,
  extractMessageId,
  fetchMboxViaB4,
  importReviewBranchFromMbox,
} from './importEngine';
import { formatPatchesForSeries, runPreflightChecks } from './preflight';
import {
  buildPullRequestContext,
  expandPrSkillCommand,
  writePullRequestContext,
} from './prSkillBridge';
import { SeriesStore } from './seriesStore';
import {
  BranchTreeItem,
  KernelBranchesProvider,
  PatchStackProvider,
  StackCommitItem,
} from './treeViews';
import { BranchClassificationConfig, BranchRole, StackInspection } from './types';

export interface PatchStackControllerOptions {
  paths: ResolvedWorkspacePaths;
  logger: (line: string) => void;
}

export class PatchStackController implements vscode.Disposable {
  public readonly branchesProvider: KernelBranchesProvider;
  public readonly stackProvider: PatchStackProvider;

  private paths: ResolvedWorkspacePaths;
  private readonly logger: (line: string) => void;
  private engine: GitStackEngine;
  private seriesStore: SeriesStore;
  private undinedClient: UndineDMcpClient;
  private readonly diagnostics: vscode.DiagnosticCollection;
  private readonly statusBarItem: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];
  private refreshTimer: NodeJS.Timeout | undefined;
  private lastInspection: StackInspection | null = null;

  constructor(options: PatchStackControllerOptions) {
    this.paths = options.paths;
    this.logger = options.logger;

    this.engine = new GitStackEngine(this.paths.kernelDir);
    this.seriesStore = new SeriesStore(this.paths.gitStateDir);
    this.undinedClient = this.createUndineDClient();

    this.branchesProvider = new KernelBranchesProvider();
    this.stackProvider = new PatchStackProvider();
    this.diagnostics = vscode.languages.createDiagnosticCollection('kdev-checkpatch');

    this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 45);
    this.statusBarItem.command = 'kdev.git.refreshViews';
    this.statusBarItem.tooltip = 'kdevkit Patch Stack (click to refresh)';

    this.disposables.push(
      this.branchesProvider,
      this.stackProvider,
      this.diagnostics,
      this.statusBarItem,
      vscode.window.registerTreeDataProvider('kdev.git.branchesView', this.branchesProvider),
      vscode.window.registerTreeDataProvider('kdev.git.stackView', this.stackProvider)
    );

    this.registerCommands();
    this.registerGitWatcher();
    void this.refreshAll();
  }

  private createUndineDClient(): UndineDMcpClient {
    return new UndineDMcpClient({
      undinedBin: this.paths.undinedBin,
      configPath: this.paths.undinedConfigPath || undefined,
      webBaseUrl: this.paths.undinedWebBaseUrl,
      logger: this.logger,
    });
  }

  private getClassificationConfig(): BranchClassificationConfig {
    return {
      topicPrefix: this.paths.gitTopicPrefix,
      reviewPrefix: this.paths.gitReviewPrefix,
      maintainerPrefixes: this.paths.gitMaintainerPrefixes,
      fixesSuffixes: this.paths.gitFixesSuffixes,
      nextSuffixes: this.paths.gitNextSuffixes,
    };
  }

  public updatePaths(paths: ResolvedWorkspacePaths): void {
    const undinedChanged =
      paths.undinedBin !== this.paths.undinedBin ||
      paths.undinedConfigPath !== this.paths.undinedConfigPath ||
      paths.undinedWebBaseUrl !== this.paths.undinedWebBaseUrl;

    this.paths = paths;
    this.engine = new GitStackEngine(this.paths.kernelDir);
    this.seriesStore = new SeriesStore(this.paths.gitStateDir);

    if (undinedChanged) {
      void this.undinedClient.dispose();
      this.undinedClient = this.createUndineDClient();
    }

    void this.refreshAll();
  }

  private registerGitWatcher(): void {
    if (!fs.existsSync(this.paths.kernelDir)) {
      return;
    }
    const gitWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(this.paths.kernelDir, '.git/{HEAD,index,refs/heads/**}')
    );
    const scheduleRefresh = () => {
      if (this.refreshTimer) {
        clearTimeout(this.refreshTimer);
      }
      this.refreshTimer = setTimeout(() => {
        void this.refreshAll();
      }, 400);
    };
    gitWatcher.onDidChange(scheduleRefresh);
    gitWatcher.onDidCreate(scheduleRefresh);
    gitWatcher.onDidDelete(scheduleRefresh);
    this.disposables.push(gitWatcher);
  }

  public async refreshAll(): Promise<void> {
    if (!fs.existsSync(path.join(this.paths.kernelDir, '.git'))) {
      this.branchesProvider.setBranches([]);
      this.stackProvider.setInspection(null);
      this.statusBarItem.hide();
      return;
    }

    try {
      const cfg = this.getClassificationConfig();
      const [branches, inspection] = await Promise.all([
        this.engine.listBranches(cfg),
        this.engine.inspectStack(cfg),
      ]);
      this.lastInspection = inspection;
      this.branchesProvider.setBranches(branches);
      this.stackProvider.setInspection(inspection);

      if (inspection.opState !== 'clean') {
        this.statusBarItem.text = `$(warning) kdev: ${inspection.opState} conflicts (${inspection.conflictingFiles.length})`;
      } else if (inspection.branch) {
        this.statusBarItem.text = `$(git-branch) ${inspection.branch} (+${inspection.commits.length})`;
      } else {
        this.statusBarItem.text = '$(git-branch) detached HEAD';
      }
      this.statusBarItem.show();
    } catch (err) {
      this.logger(`[patchstack] Refresh failed: ${String(err)}`);
    }
  }

  private registerCommands(): void {
    this.disposables.push(
      vscode.commands.registerCommand('kdev.git.refreshViews', () => this.refreshAll()),
      vscode.commands.registerCommand('kdev.git.newTopicBranch', () => this.newTopicBranch()),
      vscode.commands.registerCommand('kdev.git.checkoutBranch', (item?: BranchTreeItem | string) =>
        this.checkoutBranch(item)
      ),
      vscode.commands.registerCommand('kdev.git.setBranchRole', (item?: BranchTreeItem | string) =>
        this.setBranchRole(item)
      ),
      vscode.commands.registerCommand('kdev.git.configureMaintainerBranches', () =>
        this.configureMaintainerBranches()
      ),
      vscode.commands.registerCommand('kdev.git.refreshCommit', (item?: StackCommitItem | string) =>
        this.refreshCommit(item)
      ),
      vscode.commands.registerCommand('kdev.git.rewordCommit', (item?: StackCommitItem | string) =>
        this.rewordCommit(item)
      ),
      vscode.commands.registerCommand('kdev.git.moveCommitUp', (item?: StackCommitItem) =>
        this.moveCommitRelative(item, +1)
      ),
      vscode.commands.registerCommand('kdev.git.moveCommitDown', (item?: StackCommitItem) =>
        this.moveCommitRelative(item, -1)
      ),
      vscode.commands.registerCommand('kdev.git.dropCommit', (item?: StackCommitItem | string) =>
        this.dropCommit(item)
      ),
      vscode.commands.registerCommand(
        'kdev.git.movePatchesToBranch',
        (item?: StackCommitItem | string) => this.movePatchesToBranch(item)
      ),
      vscode.commands.registerCommand('kdev.git.undoStack', () => this.undoStack()),
      vscode.commands.registerCommand('kdev.git.popCommit', () => this.popCommit()),
      vscode.commands.registerCommand('kdev.git.pushCommit', () => this.pushCommit()),
      vscode.commands.registerCommand('kdev.git.continueConflict', () => this.continueConflict()),
      vscode.commands.registerCommand('kdev.git.skipConflict', () => this.skipConflict()),
      vscode.commands.registerCommand('kdev.git.abortConflict', () => this.abortConflict()),
      vscode.commands.registerCommand('kdev.git.editCoverLetter', () => this.editCoverLetter()),
      vscode.commands.registerCommand('kdev.git.bumpSeriesVersion', () => this.bumpSeriesVersion()),
      vscode.commands.registerCommand('kdev.git.runPreflight', () => this.runPreflight()),
      vscode.commands.registerCommand('kdev.git.stageSeriesToUndineD', () =>
        this.stageSeriesToUndineD()
      ),
      vscode.commands.registerCommand('kdev.git.importReviewBranch', () =>
        this.importReviewBranch()
      ),
      vscode.commands.registerCommand('kdev.git.applyToMaintainerBranch', () =>
        this.applyToMaintainerBranch()
      ),
      vscode.commands.registerCommand(
        'kdev.git.preparePullRequestContext',
        (item?: BranchTreeItem | string) => this.preparePullRequestContext(item)
      ),
      vscode.commands.registerCommand(
        'kdev.git.runPullRequestSkill',
        (item?: BranchTreeItem | string) => this.runPullRequestSkill(item)
      )
    );
  }

  private async resolveCommitSha(item?: StackCommitItem | string): Promise<string | undefined> {
    if (typeof item === 'string') {
      return item;
    }
    if (item instanceof StackCommitItem) {
      return item.commit.sha;
    }
    const ins = this.lastInspection ?? (await this.engine.inspectStack(this.getClassificationConfig()));
    if (ins.commits.length === 0) {
      void vscode.window.showInformationMessage('No commits in current patch stack.');
      return undefined;
    }
    const picked = await vscode.window.showQuickPick(
      [...ins.commits].reverse().map((c) => ({
        label: `[${c.index}/${ins.commits.length}] ${c.subject}`,
        description: c.shortSha,
        sha: c.sha,
      })),
      { title: 'Select stack commit' }
    );
    return picked?.sha;
  }

  private async resolveBranchName(item?: BranchTreeItem | string): Promise<string | undefined> {
    if (typeof item === 'string') {
      return item;
    }
    if (item instanceof BranchTreeItem) {
      return item.branch.name;
    }
    const branches = await this.engine.listBranches(this.getClassificationConfig());
    const picked = await vscode.window.showQuickPick(
      branches.map((b) => ({
        label: b.name,
        description: `${b.role}${b.isCurrent ? ' (active)' : ''}`,
      })),
      { title: 'Select branch' }
    );
    return picked?.label;
  }

  private async confirmPublishedOverride(sha: string): Promise<boolean> {
    const ins = this.lastInspection ?? (await this.engine.inspectStack(this.getClassificationConfig()));
    const commit = ins.commits.find((c) => c.sha === sha || c.shortSha === sha);
    if (!commit?.published) {
      return false;
    }
    const answer = await vscode.window.showWarningMessage(
      `Commit ${commit.shortSha} ("${commit.subject}") is already published on upstream. Rewriting published history requires force-push. Continue anyway?`,
      { modal: true },
      'Override & Rewrite'
    );
    return answer === 'Override & Rewrite';
  }

  private async newTopicBranch(): Promise<void> {
    const prefix = this.paths.gitTopicPrefix || 'topic/';
    const suffix = await vscode.window.showInputBox({
      title: 'Create New Topic Branch',
      prompt: `Enter topic slug (prefix "${prefix}" is prepended automatically if omitted)`,
      placeHolder: 'fprobe-cleanup',
    });
    if (!suffix?.trim()) {
      return;
    }
    const branchName = suffix.startsWith(prefix) ? suffix.trim() : `${prefix}${suffix.trim()}`;
    const baseRef = await vscode.window.showInputBox({
      title: `Base ref for ${branchName}`,
      value: 'HEAD',
      prompt: 'Enter base branch, tag, or commit SHA (e.g. torvalds/master, HEAD)',
    });
    if (!baseRef?.trim()) {
      return;
    }

    try {
      await this.engine.createBranch(branchName, baseRef.trim(), 'topic');
      this.seriesStore.loadOrCreateMetadata(branchName, baseRef.trim());
      await this.refreshAll();
      void vscode.window.showInformationMessage(`Created topic branch ${branchName}.`);
    } catch (err) {
      void vscode.window.showErrorMessage(`Failed to create topic branch: ${String(err)}`);
    }
  }

  private async checkoutBranch(item?: BranchTreeItem | string): Promise<void> {
    const branch = await this.resolveBranchName(item);
    if (!branch) {
      return;
    }
    try {
      await this.engine.checkoutBranch(branch);
      await this.refreshAll();
    } catch (err) {
      void vscode.window.showErrorMessage(`Checkout failed: ${String(err)}`);
    }
  }

  private async setBranchRole(item?: BranchTreeItem | string): Promise<void> {
    const branch = await this.resolveBranchName(item);
    if (!branch) {
      return;
    }
    const picked = await vscode.window.showQuickPick(
      [
        { label: 'topic', description: 'Contributor patch series' },
        { label: 'review', description: 'Incoming patch review' },
        { label: 'maintainer', description: 'Subsystem maintainer queue' },
        { label: 'other', description: 'Reset to default classification' },
      ],
      { title: `Set kdev role for ${branch}` }
    );
    if (!picked) {
      return;
    }
    await this.engine.setBranchRole(branch, picked.label as BranchRole);
    await this.refreshAll();
  }

  private async configureMaintainerBranches(): Promise<void> {
    const current = this.paths.gitMaintainerPrefixes.join(', ');
    const input = await vscode.window.showInputBox({
      title: 'Configure Maintainer Branch Prefixes',
      prompt: 'Comma-separated prefixes or branch names (e.g. probes/, bootconfig/, for-next)',
      value: current,
    });
    if (input === undefined) {
      return;
    }
    const prefixes = input
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    await vscode.workspace
      .getConfiguration('kdev')
      .update('git.maintainerPrefixes', prefixes, vscode.ConfigurationTarget.Workspace);
  }

  private async refreshCommit(item?: StackCommitItem | string): Promise<void> {
    const sha = await this.resolveCommitSha(item);
    if (!sha) {
      return;
    }
    const cfg = this.getClassificationConfig();
    const ins = await this.engine.inspectStack(cfg);
    const target = ins.commits.find((c) => c.sha === sha);
    let allowPublished = false;
    if (target?.published) {
      allowPublished = await this.confirmPublishedOverride(sha);
      if (!allowPublished) {
        return;
      }
    }

    let stageTracked = false;
    if (!ins.hasStagedChanges) {
      if (!ins.isDirty) {
        void vscode.window.showInformationMessage('No modified or staged changes to refresh.');
        return;
      }
      const pick = await vscode.window.showInformationMessage(
        'No staged changes found. Stage all modified tracked files (git add -u) and refresh?',
        'Stage & Refresh',
        'Cancel'
      );
      if (pick !== 'Stage & Refresh') {
        return;
      }
      stageTracked = true;
    }

    try {
      const res = await this.engine.refreshCommit(sha, cfg, { allowPublished, stageTracked });
      await this.refreshAll();
      if (res.status === 'conflict') {
        void vscode.window.showWarningMessage(
          `Rebase conflict during refresh in: ${(res.conflictingFiles ?? []).join(', ')}. Resolve conflicts then click Continue.`
        );
      } else {
        void vscode.window.showInformationMessage(`Refreshed changes into commit ${sha.slice(0, 8)}.`);
      }
    } catch (err) {
      void vscode.window.showErrorMessage(`Refresh failed: ${String(err)}`);
    }
  }

  private async rewordCommit(item?: StackCommitItem | string): Promise<void> {
    const sha = await this.resolveCommitSha(item);
    if (!sha) {
      return;
    }
    const cfg = this.getClassificationConfig();
    const ins = await this.engine.inspectStack(cfg);
    const target = ins.commits.find((c) => c.sha === sha);
    let allowPublished = false;
    if (target?.published) {
      allowPublished = await this.confirmPublishedOverride(sha);
      if (!allowPublished) {
        return;
      }
    }

    const msgRes = await runGit(this.paths.kernelDir, ['show', '-s', '--format=%B', sha]);
    const currentSubject = msgRes.stdout.split('\n')[0] ?? '';
    const newSubject = await vscode.window.showInputBox({
      title: `Reword commit ${sha.slice(0, 8)}`,
      prompt: 'Enter updated commit subject line',
      value: currentSubject,
    });
    if (!newSubject?.trim()) {
      return;
    }

    const restLines = msgRes.stdout.split('\n').slice(1);
    const updatedMsg = [newSubject.trim(), ...restLines].join('\n');

    try {
      const res = await this.engine.rewordCommit(sha, updatedMsg, cfg, allowPublished);
      await this.refreshAll();
      if (res.status === 'conflict') {
        void vscode.window.showWarningMessage('Reword rebase hit a conflict.');
      }
    } catch (err) {
      void vscode.window.showErrorMessage(`Reword failed: ${String(err)}`);
    }
  }

  private async moveCommitRelative(item: StackCommitItem | undefined, delta: 1 | -1): Promise<void> {
    if (!item) {
      return;
    }
    const cfg = this.getClassificationConfig();
    const ins = await this.engine.inspectStack(cfg);
    const idx = ins.commits.findIndex((c) => c.sha === item.commit.sha);
    const targetIdx = idx + delta;
    if (idx < 0 || targetIdx < 0 || targetIdx >= ins.commits.length) {
      return;
    }

    const order = ins.commits.map((c) => c.sha);
    [order[idx], order[targetIdx]] = [order[targetIdx], order[idx]];

    try {
      const res = await this.engine.reorderCommits(order, cfg);
      await this.refreshAll();
      if (res.status === 'conflict') {
        void vscode.window.showWarningMessage('Reordering commits encountered conflicts.');
      }
    } catch (err) {
      void vscode.window.showErrorMessage(`Reorder failed: ${String(err)}`);
    }
  }

  private async dropCommit(item?: StackCommitItem | string): Promise<void> {
    const sha = await this.resolveCommitSha(item);
    if (!sha) {
      return;
    }
    const cfg = this.getClassificationConfig();
    const ins = await this.engine.inspectStack(cfg);
    const target = ins.commits.find((c) => c.sha === sha);
    let allowPublished = false;
    if (target?.published) {
      allowPublished = await this.confirmPublishedOverride(sha);
      if (!allowPublished) {
        return;
      }
    }

    const confirm = await vscode.window.showWarningMessage(
      `Drop commit ${sha.slice(0, 8)} ("${target?.subject ?? ''}") from stack? (Undo is available)`,
      { modal: true },
      'Drop Commit'
    );
    if (confirm !== 'Drop Commit') {
      return;
    }

    try {
      const res = await this.engine.dropCommit(sha, cfg, allowPublished);
      await this.refreshAll();
      if (res.status === 'conflict') {
        void vscode.window.showWarningMessage('Dropping commit caused conflicts on dependent commits.');
      }
    } catch (err) {
      void vscode.window.showErrorMessage(`Drop failed: ${String(err)}`);
    }
  }

  private async movePatchesToBranch(item?: StackCommitItem | string): Promise<void> {
    const sha = await this.resolveCommitSha(item);
    if (!sha) {
      return;
    }
    const cfg = this.getClassificationConfig();
    const branches = await this.engine.listBranches(cfg);
    const current = await this.engine.getCurrentBranch();
    const candidates = branches.filter((b) => b.name !== current);
    const picked = await vscode.window.showQuickPick(
      candidates.map((b) => ({
        label: b.name,
        description: `${b.role}${b.cadence ? ` (${b.cadence})` : ''}`,
      })),
      { title: `Move commit ${sha.slice(0, 8)} to target branch` }
    );
    if (!picked) {
      return;
    }

    try {
      const res = await this.engine.movePatchesToBranch([sha], picked.label, cfg);
      await this.refreshAll();
      if (res.status === 'conflict') {
        void vscode.window.showWarningMessage(res.message || 'Move patches hit a conflict.');
      } else {
        void vscode.window.showInformationMessage(
          `Moved commit ${sha.slice(0, 8)} to ${picked.label}.`
        );
      }
    } catch (err) {
      void vscode.window.showErrorMessage(`Move patches failed: ${String(err)}`);
    }
  }

  private async undoStack(): Promise<void> {
    try {
      const res = await this.engine.undo();
      await this.refreshAll();
      void vscode.window.showInformationMessage(
        `Restored stack HEAD to ${res.restoredSha.slice(0, 8)}.`
      );
    } catch (err) {
      void vscode.window.showErrorMessage(`Undo failed: ${String(err)}`);
    }
  }

  private async popCommit(): Promise<void> {
    try {
      await this.engine.popCommits(1, this.getClassificationConfig());
      await this.refreshAll();
    } catch (err) {
      void vscode.window.showErrorMessage(`Pop failed: ${String(err)}`);
    }
  }

  private async pushCommit(): Promise<void> {
    try {
      const res = await this.engine.pushCommits(1);
      await this.refreshAll();
      if (res.status === 'conflict') {
        void vscode.window.showWarningMessage('Push hit a cherry-pick conflict.');
      }
    } catch (err) {
      void vscode.window.showErrorMessage(`Push failed: ${String(err)}`);
    }
  }

  private async continueConflict(): Promise<void> {
    try {
      const res = await this.engine.continueOperation();
      await this.refreshAll();
      if (res.status === 'conflict') {
        void vscode.window.showWarningMessage(
          `Remaining conflicts: ${(res.conflictingFiles ?? []).join(', ')}`
        );
      }
    } catch (err) {
      void vscode.window.showErrorMessage(`Continue failed: ${String(err)}`);
    }
  }

  private async skipConflict(): Promise<void> {
    try {
      await this.engine.skipOperation();
      await this.refreshAll();
    } catch (err) {
      void vscode.window.showErrorMessage(`Skip failed: ${String(err)}`);
    }
  }

  private async abortConflict(): Promise<void> {
    try {
      await this.engine.abortOperation();
      await this.refreshAll();
    } catch (err) {
      void vscode.window.showErrorMessage(`Abort failed: ${String(err)}`);
    }
  }

  private async editCoverLetter(): Promise<void> {
    const branch = await this.engine.getCurrentBranch();
    if (!branch) {
      void vscode.window.showWarningMessage('Checkout a branch first.');
      return;
    }
    const { baseRef } = await this.engine.resolveBaseRefAndSha(branch);
    const meta = this.seriesStore.loadOrCreateMetadata(branch, baseRef);
    const coverPath = this.seriesStore.ensureCoverLetter(branch, meta.version);
    const doc = await vscode.workspace.openTextDocument(coverPath);
    await vscode.window.showTextDocument(doc, { preview: false });
  }

  private async bumpSeriesVersion(): Promise<void> {
    const cfg = this.getClassificationConfig();
    const ins = await this.engine.inspectStack(cfg);
    if (!ins.branch) {
      void vscode.window.showWarningMessage('Checkout a topic branch first.');
      return;
    }
    try {
      const { meta, rangeDiff } = await this.seriesStore.bumpVersion(
        this.paths.kernelDir,
        ins.branch,
        ins.baseSha,
        ins.headSha
      );
      await this.refreshAll();

      if (rangeDiff) {
        const pick = await vscode.window.showInformationMessage(
          `Bumped ${ins.branch} to v${meta.version}. Append git range-diff to cover.md?`,
          'Append & Open cover.md',
          'Skip'
        );
        if (pick === 'Append & Open cover.md') {
          const coverPath = this.seriesStore.appendRangeDiffToCover(
            ins.branch,
            meta.version,
            rangeDiff
          );
          const doc = await vscode.workspace.openTextDocument(coverPath);
          await vscode.window.showTextDocument(doc, { preview: false });
        }
      } else {
        void vscode.window.showInformationMessage(
          `Bumped ${ins.branch} to v${meta.version} (no previous staged snapshot for range-diff).`
        );
      }
    } catch (err) {
      void vscode.window.showErrorMessage(`Bump version failed: ${String(err)}`);
    }
  }

  private async runPreflight(): Promise<void> {
    const cfg = this.getClassificationConfig();
    const ins = await this.engine.inspectStack(cfg);
    if (!ins.branch || ins.commits.length === 0) {
      void vscode.window.showInformationMessage('No stack commits to preflight.');
      return;
    }

    const result = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Running preflight checks on ${ins.branch} (${ins.commits.length} commits)...`,
      },
      () => runPreflightChecks(this.paths.kernelDir, ins.baseSha, ins.commits)
    );

    this.diagnostics.clear();
    const diagByUri = new Map<string, vscode.Diagnostic[]>();
    for (const issue of result.checkpatchIssues) {
      if (!issue.file) {
        continue;
      }
      const absPath = path.join(this.paths.kernelDir, issue.file);
      const uri = vscode.Uri.file(absPath);
      const lineIdx = Math.max(0, (issue.line ?? 1) - 1);
      const sev =
        issue.severity === 'ERROR'
          ? vscode.DiagnosticSeverity.Error
          : issue.severity === 'WARNING'
            ? vscode.DiagnosticSeverity.Warning
            : vscode.DiagnosticSeverity.Information;
      const diag = new vscode.Diagnostic(
        new vscode.Range(lineIdx, 0, lineIdx, 200),
        `[checkpatch] ${issue.message}`,
        sev
      );
      const list = diagByUri.get(uri.toString()) ?? [];
      list.push(diag);
      diagByUri.set(uri.toString(), list);
    }
    for (const [uriStr, list] of diagByUri.entries()) {
      this.diagnostics.set(vscode.Uri.parse(uriStr), list);
    }

    this.logger(
      `[preflight] ${ins.branch}: ${result.errorCount} error(s), ${result.warningCount} warning(s), ${result.missingSignoffShas.length} missing Signed-off-by, ${result.maintainers.length} maintainer(s)`
    );

    const summary = `Preflight (${ins.branch}): ${result.errorCount} errors, ${result.warningCount} warnings, ${result.missingSignoffShas.length} missing SoB, ${result.maintainers.length} recipients found.`;
    if (result.errorCount > 0 || result.missingSignoffShas.length > 0) {
      void vscode.window.showWarningMessage(summary);
    } else {
      void vscode.window.showInformationMessage(summary);
    }
  }

  private async stageSeriesToUndineD(): Promise<void> {
    const cfg = this.getClassificationConfig();
    const ins = await this.engine.inspectStack(cfg);
    if (!ins.branch || ins.commits.length === 0) {
      void vscode.window.showWarningMessage('No stack commits to stage.');
      return;
    }

    const meta = this.seriesStore.loadOrCreateMetadata(ins.branch, ins.baseRef);
    const includeCover = ins.commits.length > 1 || Boolean(meta.forceCoverLetter);
    const coverMd = includeCover
      ? this.seriesStore.readCoverLetter(ins.branch, meta.version)
      : undefined;

    const stagingDir = this.seriesStore.getStagingDir(ins.branch);
    const patches = await formatPatchesForSeries(this.paths.kernelDir, {
      baseSha: ins.baseSha,
      version: meta.version,
      subjectPrefix: meta.subjectPrefix,
      stagingDir,
      includeCoverLetter: includeCover,
      coverMdContent: coverMd,
    });

    // Discover maintainers & confirm To/Cc recipients
    const preflight = await runPreflightChecks(
      this.paths.kernelDir,
      ins.baseSha,
      ins.commits,
      patches.filter((p) => !p.isCoverLetter).map((p) => p.filePath)
    );

    const allCandidates = Array.from(
      new Set([...meta.recipients.to, ...meta.recipients.cc, ...preflight.maintainers])
    );

    let toList = [...meta.recipients.to];
    let ccList = [...meta.recipients.cc];

    if (allCandidates.length > 0) {
      const preSelected = new Set([...toList, ...ccList]);
      const picked = await vscode.window.showQuickPick(
        allCandidates.map((addr) => ({
          label: addr,
          picked: preSelected.size === 0 ? true : preSelected.has(addr),
        })),
        {
          canPickMany: true,
          title: `Select recipients for ${ins.branch} v${meta.version} (first becomes To, rest Cc)`,
        }
      );
      if (!picked || picked.length === 0) {
        return;
      }
      toList = [picked[0].label];
      ccList = picked.slice(1).map((p) => p.label);
    } else {
      const manualTo = await vscode.window.showInputBox({
        title: 'Enter To recipient(s)',
        prompt: 'Comma-separated email addresses',
        value: toList.join(', '),
      });
      if (!manualTo?.trim()) {
        return;
      }
      toList = manualTo
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    }

    meta.recipients = { to: toList, cc: ccList };
    this.seriesStore.saveMetadata(meta);

    const seriesKey = `${ins.branch}:v${meta.version}`;
    try {
      const stageRes = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Staging ${seriesKey} (${patches.length} message(s)) to UndineD Drafts...`,
        },
        () =>
          this.undinedClient.stagePatchSeries({
            series_key: seriesKey,
            branch: ins.branch,
            version: meta.version,
            to: toList,
            cc: ccList,
            in_reply_to: meta.inReplyTo ?? undefined,
            base_commit: ins.baseSha,
            replace_existing: true,
            messages: patches.map((p) => ({
              index: p.index,
              is_cover_letter: p.isCoverLetter,
              subject: p.subject,
              body: p.body,
              commit_sha: p.commitSha,
            })),
          })
      );

      await this.seriesStore.recordStagedSnapshot(this.paths.kernelDir, ins.branch, {
        version: meta.version,
        stagedAt: new Date().toISOString(),
        baseSha: ins.baseSha,
        headSha: ins.headSha,
        undinedSeriesId: stageRes.series_id,
        coverMessageId: stageRes.root_message_id,
        webUrl: stageRes.web_url,
      });

      const patchCount = patches.filter((p) => !p.isCoverLetter).length;
      const coverNote = includeCover ? ' + cover letter' : '';
      const action = await vscode.window.showInformationMessage(
        `Staged v${meta.version} (${patchCount} patch(es)${coverNote}) to UndineD Drafts. Review and send in UndineD Web UI.`,
        'Open in UndineD'
      );
      if (action === 'Open in UndineD' && stageRes.web_url) {
        await vscode.env.openExternal(vscode.Uri.parse(stageRes.web_url));
      }
    } catch (err) {
      void vscode.window.showErrorMessage(`Failed to stage series to UndineD: ${String(err)}`);
    }
  }

  private async importReviewBranch(): Promise<void> {
    const clip = (await vscode.env.clipboard.readText()).trim();
    const looksLikeMsgId =
      clip.includes('lore.kernel.org') || (/^<?[^\s<>]+@[^\s<>]+>?$/.test(clip) && clip.length < 200);

    const rawInput = await vscode.window.showInputBox({
      title: 'Import Review Branch by Message-ID or lore.kernel.org URL',
      prompt: 'Enter a Message-ID or lore.kernel.org URL',
      value: looksLikeMsgId ? clip : '',
    });
    if (!rawInput?.trim()) {
      return;
    }
    const msgId = extractMessageId(rawInput);

    let mboxPath = '';
    let tempDirToClean: string | undefined;
    let detectedBase: string | undefined;

    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Fetching patch series ${msgId}...`,
        },
        async () => {
          if (this.paths.gitImportSource === 'undined-mcp') {
            try {
              await this.undinedClient.importPatchSeriesB4(rawInput.trim());
            } catch {
              // May already be cached locally; proceed to export_thread_mbox
            }
            const exported = await this.undinedClient.exportThreadMbox({
              message_id: msgId,
              patches_only: true,
            });
            mboxPath = exported.mbox_path;
            detectedBase = exported.base_commit;
          } else {
            const fetched = await fetchMboxViaB4({
              b4Bin: this.paths.gitB4Bin,
              msgId,
              guessBase: true,
              cwd: this.paths.kernelDir,
            });
            mboxPath = fetched.mboxPath;
            tempDirToClean = fetched.tempDir;
          }
        }
      );

      if (!detectedBase && mboxPath && fs.existsSync(mboxPath)) {
        detectedBase = extractBaseCommitFromMbox(fs.readFileSync(mboxPath, 'utf-8'));
      }

      const baseRef = await vscode.window.showInputBox({
        title: 'Base commit / branch for review branch',
        value: detectedBase || 'HEAD',
        prompt: detectedBase
          ? `Detected base-commit: ${detectedBase}`
          : 'No base-commit trailer found; specify base branch or tag',
      });
      if (!baseRef?.trim()) {
        return;
      }

      const res = await importReviewBranchFromMbox(
        this.engine,
        mboxPath,
        msgId,
        this.paths.gitReviewPrefix,
        baseRef.trim()
      );
      await this.refreshAll();

      if (res.status === 'conflict') {
        void vscode.window.showWarningMessage(
          `Created ${res.branch}, but git am -3 hit conflicts in: ${(res.conflictingFiles ?? []).join(', ')}`
        );
      } else {
        void vscode.window.showInformationMessage(
          `Imported ${res.appliedCount} patch(es) into ${res.branch}.`
        );
      }
    } catch (err) {
      void vscode.window.showErrorMessage(`Review import failed: ${String(err)}`);
    } finally {
      if (tempDirToClean) {
        fs.rmSync(tempDirToClean, { recursive: true, force: true });
      }
    }
  }

  private async applyToMaintainerBranch(): Promise<void> {
    const cfg = this.getClassificationConfig();
    const branches = await this.engine.listBranches(cfg);
    const current = branches.find((b) => b.isCurrent);
    let targetBranch = current?.role === 'maintainer' ? current.name : undefined;

    if (!targetBranch) {
      const maintBranches = branches.filter((b) => b.role === 'maintainer');
      if (maintBranches.length === 0) {
        void vscode.window.showWarningMessage(
          'No maintainer branches configured. Set kdev.git.maintainerPrefixes or tag a branch as maintainer.'
        );
        return;
      }
      const picked = await vscode.window.showQuickPick(
        maintBranches.map((b) => ({
          label: b.name,
          description: b.cadence ?? 'custom',
        })),
        { title: 'Select target maintainer branch' }
      );
      if (!picked) {
        return;
      }
      targetBranch = picked.label;
    }

    const rawInput = await vscode.window.showInputBox({
      title: `Apply patch series to ${targetBranch} (b4 am -l -s)`,
      prompt: 'Enter lore Message-ID or URL',
    });
    if (!rawInput?.trim()) {
      return;
    }
    const msgId = extractMessageId(rawInput);

    let tempDir: string | undefined;
    try {
      const fetched = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Fetching ${msgId} via b4 am -l -s...`,
        },
        () =>
          fetchMboxViaB4({
            b4Bin: this.paths.gitB4Bin,
            msgId,
            addLink: true,
            addSignoff: true,
            cwd: this.paths.kernelDir,
          })
      );
      tempDir = fetched.tempDir;

      const applyRes = await applyMboxToMaintainerBranch(
        this.engine,
        targetBranch,
        fetched.mboxPath
      );
      await this.refreshAll();

      if (applyRes.status === 'conflict') {
        void vscode.window.showWarningMessage(
          `git am -3 conflicted on ${targetBranch}: ${(applyRes.conflictingFiles ?? []).join(', ')}`
        );
        return;
      }

      const action = await vscode.window.showInformationMessage(
        `Applied ${applyRes.appliedCommits.length} commit(s) to ${targetBranch}.`,
        'Mark Accepted on Patchwork'
      );
      if (action === 'Mark Accepted on Patchwork') {
        try {
          const pwInfo = await this.undinedClient.getPatchworkPatchInfo(msgId);
          await this.undinedClient.updatePatchworkPatch({
            patch_id: pwInfo.id,
            state: 'accepted',
          });
          void vscode.window.showInformationMessage(
            `Updated Patchwork patch #${pwInfo.id} to accepted.`
          );
        } catch (pwErr) {
          void vscode.window.showWarningMessage(`Patchwork update failed: ${String(pwErr)}`);
        }
      }
    } catch (err) {
      void vscode.window.showErrorMessage(`Maintainer apply failed: ${String(err)}`);
    } finally {
      if (tempDir) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }
  }

  private async preparePullRequestContext(item?: BranchTreeItem | string): Promise<string | undefined> {
    const branch = (await this.resolveBranchName(item)) || (await this.engine.getCurrentBranch());
    if (!branch) {
      return undefined;
    }
    try {
      const ctx = await buildPullRequestContext(
        this.engine,
        branch,
        this.getClassificationConfig()
      );
      writePullRequestContext(this.paths.prContextPath, ctx);
      const pushNote = ctx.remotePushStatus.branchPushed
        ? 'pushed'
        : `NOT pushed to ${ctx.remotePushStatus.remote}`;
      void vscode.window.showInformationMessage(
        `PR context written to ${this.paths.prContextPath} (${ctx.commitCount} commits, ${ctx.cadence}, ${pushNote}).`
      );
      return this.paths.prContextPath;
    } catch (err) {
      void vscode.window.showErrorMessage(`Failed to prepare PR context: ${String(err)}`);
      return undefined;
    }
  }

  private async runPullRequestSkill(item?: BranchTreeItem | string): Promise<void> {
    const branch = (await this.resolveBranchName(item)) || (await this.engine.getCurrentBranch());
    if (!branch) {
      return;
    }
    const contextFile = await this.preparePullRequestContext(branch);
    if (!contextFile) {
      return;
    }

    const template = this.paths.gitPrSkillCommand.trim();
    if (!template) {
      const prompt = `Create a Linux kernel Pull Request draft in UndineD (create_mail_draft) for branch "${branch}" using context file ${contextFile}.`;
      await vscode.env.clipboard.writeText(prompt);
      const action = await vscode.window.showInformationMessage(
        'PR context prepared and prompt copied to clipboard. Configure kdev.git.prSkillCommand to launch automatically.',
        'Open Settings'
      );
      if (action === 'Open Settings') {
        await vscode.commands.executeCommand(
          'workbench.action.openSettings',
          'kdev.git.prSkillCommand'
        );
      }
      return;
    }

    const cmd = expandPrSkillCommand(template, {
      branch,
      contextFile,
      kernelDir: this.paths.kernelDir,
    });
    const term = vscode.window.createTerminal({
      name: `kdev PR Skill (${branch})`,
      cwd: this.paths.workspaceRoot,
    });
    term.show();
    term.sendText(cmd);
  }

  public dispose(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    void this.undinedClient.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
