import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import * as vscode from 'vscode';
import { KconfigPanelController } from '../kconfig/panelController';
import { KconfigRpcClient } from '../kconfig/rpcClient';
import { KprobeController } from '../kprobe/kprobeController';
import { QemuBusyError, QemuRunner } from '../qemu/qemuRunner';
import { ResolvedWorkspacePaths } from '../shared/workspacePaths';
import { syncSelftestTargetConfig } from './configBridge';
import {
  checkTargetConfig,
  discoverTargetTests,
  listAvailableTargets,
} from './discovery';
import { KtapStreamParser } from './ktapParser';
import { generateSelftestRunScript } from './scriptGenerator';
import {
  CheckConfigBeforeRunMode,
  SelftestItem,
  SelftestLinkMode,
  TargetOverrideOptions,
} from './types';

export interface SelftestControllerOptions {
  paths: ResolvedWorkspacePaths;
  rpcClient: KconfigRpcClient;
  panelController: KconfigPanelController;
  kprobeController: KprobeController;
  qemuRunner: QemuRunner;
  logger: (line: string) => void;
  onTraceCaptured?: () => void;
}

interface SelftestSettings {
  targets: string[];
  linkMode: SelftestLinkMode;
  targetOptions: Record<string, TargetOverrideOptions>;
  checkConfigBeforeRun: CheckConfigBeforeRunMode;
  timeoutSec: number;
  bootTimeoutSec: number;
  autoBuildBeforeRun: boolean;
  keepRunScript: boolean;
}

export class SelftestController implements vscode.Disposable {
  public readonly testController: vscode.TestController;

  private readonly disposables: vscode.Disposable[] = [];
  private readonly itemMeta = new Map<string, SelftestItem>();
  private readonly targetItems = new Map<string, vscode.TestItem>();
  private paths: ResolvedWorkspacePaths;
  private readonly rpcClient: KconfigRpcClient;
  private readonly panelController: KconfigPanelController;
  private readonly kprobeController: KprobeController;
  private readonly qemuRunner: QemuRunner;
  private readonly logger: (line: string) => void;
  private onTraceCaptured?: () => void;

  constructor(options: SelftestControllerOptions) {
    this.paths = options.paths;
    this.rpcClient = options.rpcClient;
    this.panelController = options.panelController;
    this.kprobeController = options.kprobeController;
    this.qemuRunner = options.qemuRunner;
    this.logger = options.logger;
    this.onTraceCaptured = options.onTraceCaptured;

    this.testController = vscode.tests.createTestController(
      'kdevSelftest',
      'Linux Kernel Selftests'
    );
    this.testController.refreshHandler = () => {
      this.refreshTestTree();
    };
    this.testController.resolveHandler = (item) => {
      if (!item) {
        this.refreshTestTree();
      }
    };

    const runProfile = this.testController.createRunProfile(
      'Run in QEMU',
      vscode.TestRunProfileKind.Run,
      (request, token) => this.runTests(request, token, false),
      true
    );

    const kprobeRunProfile = this.testController.createRunProfile(
      'Run in QEMU with Active Kprobes',
      vscode.TestRunProfileKind.Run,
      (request, token) => this.runTests(request, token, true),
      false
    );

    this.disposables.push(
      this.testController,
      runProfile,
      kprobeRunProfile,
      vscode.commands.registerCommand('kdev.selftest.selectTargets', () =>
        this.selectTargets()
      ),
      vscode.commands.registerCommand(
        'kdev.selftest.syncTargetConfig',
        (arg?: vscode.TestItem | string) => this.syncTargetConfigCommand(arg)
      ),
      vscode.commands.registerCommand('kdev.selftest.buildSelected', () =>
        this.buildSelectedCommand()
      ),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('kdev.selftest') || e.affectsConfiguration('kdev.arch')) {
          this.refreshTestTree();
        }
      })
    );

    this.refreshTestTree();
  }

  public setOnTraceCaptured(cb: () => void): void {
    this.onTraceCaptured = cb;
  }

  public updatePaths(paths: ResolvedWorkspacePaths): void {
    this.paths = paths;
    this.refreshTestTree();
  }

  private readSettings(): SelftestSettings {
    const cfg = vscode.workspace.getConfiguration('kdev.selftest');
    return {
      targets: cfg.get<string[]>('targets', []),
      linkMode: cfg.get<SelftestLinkMode>('linkMode', 'auto-libs'),
      targetOptions: cfg.get<Record<string, TargetOverrideOptions>>('targetOptions', {}),
      checkConfigBeforeRun: cfg.get<CheckConfigBeforeRunMode>('checkConfigBeforeRun', 'prompt'),
      timeoutSec: cfg.get<number>('timeoutSec', 300),
      bootTimeoutSec: cfg.get<number>('bootTimeoutSec', 60),
      autoBuildBeforeRun: cfg.get<boolean>('autoBuildBeforeRun', true),
      keepRunScript: cfg.get<boolean>('keepRunScript', false),
    };
  }

  public refreshTestTree(): void {
    const settings = this.readSettings();
    const kselftestListPath = path.join(
      this.paths.sharedDir,
      'kselftest',
      'kselftest-list.txt'
    );

    this.itemMeta.clear();
    this.targetItems.clear();
    this.testController.items.replace([]);

    for (const target of settings.targets) {
      const targetDir = path.join(
        this.paths.kernelDir,
        'tools',
        'testing',
        'selftests',
        target
      );
      const targetUri = fs.existsSync(targetDir) ? vscode.Uri.file(targetDir) : undefined;
      const parentItem = this.testController.createTestItem(
        `target:${target}`,
        target,
        targetUri
      );

      const configCheck = checkTargetConfig({
        kernelDir: this.paths.kernelDir,
        target,
        dotConfigPath: this.paths.dotConfigPath,
        arch: this.paths.arch,
      });

      if (configCheck.status === 'missing') {
        const count = configCheck.missing.length;
        parentItem.description = `(⚠ ${count} config option${count === 1 ? '' : 's'} missing)`;
      } else if (configCheck.status === 'satisfied') {
        parentItem.description = '(config ok)';
      }

      const tests = discoverTargetTests({
        kernelDir: this.paths.kernelDir,
        target,
        kselftestListPath,
      });

      for (const testCase of tests) {
        const childItem = this.testController.createTestItem(
          testCase.id,
          testCase.name,
          targetUri
        );
        this.itemMeta.set(testCase.id, testCase);
        parentItem.children.add(childItem);
      }

      this.targetItems.set(target, parentItem);
      this.testController.items.add(parentItem);
    }
  }

  private async selectTargets(): Promise<void> {
    const available = listAvailableTargets(this.paths.kernelDir, this.paths.arch);
    if (available.length === 0) {
      void vscode.window.showWarningMessage(
        `No kselftest targets found under ${path.join(this.paths.kernelDir, 'tools/testing/selftests')}.`
      );
      return;
    }

    const current = new Set(this.readSettings().targets);
    const items: Array<vscode.QuickPickItem & { targetName: string }> = available.map((t) => ({
      label: t.name,
      description: t.hasConfig ? '$(settings-gear) has config' : undefined,
      picked: current.has(t.name),
      targetName: t.name,
    }));

    const picked = await vscode.window.showQuickPick(items, {
      canPickMany: true,
      title: 'Select Linux Kernel Selftest Targets',
      placeHolder: 'Choose subsystem selftest directories to display in Test Explorer',
    });

    if (!picked) {
      return;
    }

    const nextTargets = picked.map((p) => p.targetName);
    await vscode.workspace
      .getConfiguration('kdev.selftest')
      .update('targets', nextTargets, vscode.ConfigurationTarget.Workspace);
    this.refreshTestTree();
  }

  private async syncTargetConfigCommand(arg?: vscode.TestItem | string): Promise<void> {
    let target: string | undefined;

    if (typeof arg === 'string') {
      target = arg.startsWith('target:') ? arg.slice('target:'.length) : arg;
    } else if (arg && typeof arg.id === 'string') {
      if (arg.id.startsWith('target:')) {
        target = arg.id.slice('target:'.length);
      } else {
        target = this.itemMeta.get(arg.id)?.target;
      }
    }

    if (!target) {
      const configured = this.readSettings().targets;
      if (configured.length === 0) {
        void vscode.window.showInformationMessage(
          'No selftest targets selected. Run "kdev: Select Selftest Targets..." first.'
        );
        return;
      }
      if (configured.length === 1) {
        target = configured[0];
      } else {
        target = await vscode.window.showQuickPick(configured, {
          title: 'Select Selftest Target to Inject & Solve Kconfig',
        });
      }
    }

    if (!target) {
      return;
    }

    try {
      await syncSelftestTargetConfig({
        target,
        paths: this.paths,
        rpcClient: this.rpcClient,
        panelController: this.panelController,
        logger: this.logger,
        onApplied: () => this.refreshTestTree(),
      });
    } catch (err) {
      void vscode.window.showErrorMessage(
        `Failed to sync Kconfig for selftest '${target}': ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  private async buildTargets(
    targets: string[],
    settings: SelftestSettings,
    onOutput?: (line: string) => void,
    token?: vscode.CancellationToken
  ): Promise<boolean> {
    const buildScript = path.join(this.paths.workspaceRoot, 'scripts', 'build_selftest.sh');
    if (!fs.existsSync(buildScript)) {
      throw new Error(`Build script not found at ${buildScript}`);
    }

    // Group targets by effective linkMode
    const byMode = new Map<SelftestLinkMode, string[]>();
    for (const target of targets) {
      const mode = settings.targetOptions[target]?.linkMode ?? settings.linkMode;
      const list = byMode.get(mode) ?? [];
      list.push(target);
      byMode.set(mode, list);
    }

    for (const [mode, modeTargets] of byMode.entries()) {
      const args = ['--link-mode', mode, ...modeTargets];
      const ok = await new Promise<boolean>((resolve, reject) => {
        const child = spawn(buildScript, args, {
          cwd: this.paths.workspaceRoot,
          env: {
            ...process.env,
            KERNEL_DIR: this.paths.kernelDir,
            BUILD_DIR: this.paths.buildDir,
            SHARED_DIR: this.paths.sharedDir,
            ARCH: this.paths.arch,
            SELFTEST_LINK_MODE: mode,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        const cancelSub = token?.onCancellationRequested(() => {
          child.kill('SIGTERM');
        });

        const rlOut = readline.createInterface({ input: child.stdout });
        const rlErr = readline.createInterface({ input: child.stderr });
        rlOut.on('line', (line) => onOutput?.(line));
        rlErr.on('line', (line) => onOutput?.(line));

        child.once('error', (err) => {
          cancelSub?.dispose();
          rlOut.close();
          rlErr.close();
          reject(err);
        });

        child.once('close', (code) => {
          cancelSub?.dispose();
          rlOut.close();
          rlErr.close();
          resolve(code === 0);
        });
      });

      if (!ok) {
        return false;
      }
    }

    return true;
  }

  private async buildSelectedCommand(): Promise<void> {
    const settings = this.readSettings();
    if (settings.targets.length === 0) {
      void vscode.window.showInformationMessage(
        'No selftest targets selected. Run "kdev: Select Selftest Targets..." first.'
      );
      return;
    }

    const ok = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Building selftests: ${settings.targets.join(', ')}...`,
        cancellable: true,
      },
      (_progress, token) =>
        this.buildTargets(
          settings.targets,
          settings,
          (line) => this.logger(`[build_selftest] ${line}`),
          token
        )
    );

    if (ok) {
      this.refreshTestTree();
      void vscode.window.showInformationMessage(
        `Built selftest target(s): ${settings.targets.join(', ')}.`
      );
    } else {
      void vscode.window.showErrorMessage(
        'Failed to build selftests. Check the Kernel Dev output channel for details.'
      );
    }
  }

  private collectRequestedItems(request: vscode.TestRunRequest): {
    testItems: vscode.TestItem[];
    selftestCases: SelftestItem[];
    targets: string[];
  } {
    const excluded = new Set(request.exclude ?? []);
    const testItems: vscode.TestItem[] = [];
    const selftestCases: SelftestItem[] = [];
    const targetSet = new Set<string>();

    const visit = (item: vscode.TestItem) => {
      if (excluded.has(item)) {
        return;
      }
      if (item.id.startsWith('target:')) {
        const targetName = item.id.slice('target:'.length);
        targetSet.add(targetName);
        if (item.children.size === 0) {
          testItems.push(item);
        } else {
          item.children.forEach((child) => visit(child));
        }
        return;
      }

      const meta = this.itemMeta.get(item.id);
      if (meta) {
        targetSet.add(meta.target);
        selftestCases.push(meta);
        testItems.push(item);
      }
    };

    if (request.include && request.include.length > 0) {
      for (const item of request.include) {
        visit(item);
      }
    } else {
      this.testController.items.forEach((item) => visit(item));
    }

    return {
      testItems,
      selftestCases,
      targets: Array.from(targetSet),
    };
  }

  private async runTests(
    request: vscode.TestRunRequest,
    token: vscode.CancellationToken,
    withKprobes: boolean
  ): Promise<void> {
    const settings = this.readSettings();
    const { testItems, selftestCases, targets } = this.collectRequestedItems(request);

    const run = this.testController.createTestRun(request);
    const appendLine = (line: string) => {
      run.appendOutput(`${line}\r\n`);
    };

    if (targets.length === 0) {
      appendLine('No selftest targets selected. Run "kdev: Select Selftest Targets..." first.');
      run.end();
      return;
    }

    // 1. Pre-run config check
    if (settings.checkConfigBeforeRun === 'prompt') {
      for (const target of targets) {
        const check = checkTargetConfig({
          kernelDir: this.paths.kernelDir,
          target,
          dotConfigPath: this.paths.dotConfigPath,
          arch: this.paths.arch,
        });
        if (check.status === 'missing') {
          const choice = await vscode.window.showWarningMessage(
            `Selftest '${target}' has ${check.missing.length} missing Kconfig option(s) in .config.`,
            'Inject & Solve Kconfig',
            'Run Anyway',
            'Cancel'
          );
          if (choice === 'Inject & Solve Kconfig') {
            await this.syncTargetConfigCommand(target);
            run.end();
            return;
          }
          if (!choice || choice === 'Cancel') {
            run.end();
            return;
          }
        }
      }
    }

    for (const item of testItems) {
      run.enqueued(item);
    }

    // 2. Auto-build selftest targets before booting QEMU
    if (settings.autoBuildBeforeRun) {
      appendLine(`==> Building selftest target(s): ${targets.join(', ')}`);
      try {
        const buildOk = await this.buildTargets(targets, settings, appendLine, token);
        if (!buildOk || token.isCancellationRequested) {
          for (const item of testItems) {
            run.errored(item, new vscode.TestMessage('Selftest build failed or was cancelled.'));
          }
          run.end();
          return;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        appendLine(`Build error: ${msg}`);
        for (const item of testItems) {
          run.errored(item, new vscode.TestMessage(`Build error: ${msg}`));
        }
        run.end();
        return;
      }
    }

    // 3. Prepare setup_kprobes.sh & run_target.sh
    const runTargetPath = path.join(this.paths.sharedDir, 'run_target.sh');
    const exitCodePath = path.join(this.paths.sharedDir, 'exit_code');
    const setupKprobesPath = this.paths.setupScriptPath;
    let previousKprobesMode: number | null = null;

    if (withKprobes) {
      this.kprobeController.ensureSetupScriptExported();
      if (fs.existsSync(setupKprobesPath)) {
        fs.chmodSync(setupKprobesPath, 0o755);
      }
    } else if (fs.existsSync(setupKprobesPath)) {
      try {
        const stat = fs.statSync(setupKprobesPath);
        previousKprobesMode = stat.mode;
        // Temporarily clear execute bits so guest /init skips setup_kprobes.sh
        fs.chmodSync(setupKprobesPath, stat.mode & ~0o111);
      } catch {
        previousKprobesMode = null;
      }
    }

    const effectiveTimeoutSec = Math.max(
      settings.timeoutSec,
      ...targets.map((t) => settings.targetOptions[t]?.timeoutSec ?? 0)
    );
    const effectiveBootTimeoutSec = Math.max(
      settings.bootTimeoutSec,
      ...targets.map((t) => settings.targetOptions[t]?.bootTimeoutSec ?? 0)
    );

    const scriptContent = generateSelftestRunScript({
      items: selftestCases,
      collections: selftestCases.length === 0 ? targets : [],
      kselftestTimeoutSec: Math.min(effectiveTimeoutSec, 180),
    });

    fs.mkdirSync(this.paths.sharedDir, { recursive: true });
    fs.writeFileSync(runTargetPath, scriptContent, { mode: 0o755 });

    // Map "<target>:<test>" to VSCode TestItem for streaming KTAP updates
    const itemByKey = new Map<string, vscode.TestItem>();
    for (const item of testItems) {
      itemByKey.set(item.id, item);
    }

    const startedAtByItem = new Map<string, number>();
    const settledItems = new Set<string>();
    const parser = new KtapStreamParser();
    let activeItem: vscode.TestItem | undefined;
    let crashMessage: string | null = null;

    const abortController = new AbortController();
    const cancelSub = token.onCancellationRequested(() => {
      abortController.abort();
      this.qemuRunner.cancel();
    });

    try {
      appendLine(
        `==> Launching QEMU (${withKprobes ? 'with Active Kprobes' : 'clean run'})...`
      );

      const result = await this.qemuRunner.run({
        workspaceRoot: this.paths.workspaceRoot,
        env: {
          KERNEL_DIR: this.paths.kernelDir,
          BUILD_DIR: this.paths.buildDir,
          SHARED_DIR: this.paths.sharedDir,
          ARCH: this.paths.arch,
        },
        timeoutSec: effectiveTimeoutSec,
        bootTimeoutSec: effectiveBootTimeoutSec,
        exitCodePath,
        signal: abortController.signal,
        onLine: (line) => {
          appendLine(line);
          const events = parser.feedLine(line);
          for (const ev of events) {
            if (ev.type === 'suiteStart') {
              const key = `${ev.target}:${ev.test}`;
              const matched = itemByKey.get(key) ?? this.targetItems.get(ev.target);
              if (matched) {
                activeItem = matched;
                startedAtByItem.set(matched.id, Date.now());
                run.started(matched);
              }
            } else if (ev.type === 'testResult') {
              const key =
                ev.target && ev.test ? `${ev.target}:${ev.test}` : undefined;
              const matched =
                (key ? itemByKey.get(key) : undefined) ??
                activeItem ??
                (testItems.length === 1 ? testItems[0] : undefined);
              if (matched) {
                const startMs = startedAtByItem.get(matched.id);
                const duration = startMs ? Date.now() - startMs : undefined;
                settledItems.add(matched.id);
                if (ev.status === 'pass' || ev.status === 'xfail') {
                  run.passed(matched, duration);
                } else if (ev.status === 'skip') {
                  run.skipped(matched);
                } else if (ev.status === 'timeout') {
                  run.failed(
                    matched,
                    new vscode.TestMessage(`Timeout: ${ev.reason ?? ev.description}`),
                    duration
                  );
                } else {
                  run.failed(
                    matched,
                    new vscode.TestMessage(ev.raw),
                    duration
                  );
                }
              }
            } else if (ev.type === 'kernelCrash') {
              crashMessage = ev.excerpt.join('\n');
              if (activeItem && !settledItems.has(activeItem.id)) {
                settledItems.add(activeItem.id);
                run.errored(
                  activeItem,
                  new vscode.TestMessage(`Kernel crash detected:\n${crashMessage}`)
                );
              }
            }
          }
        },
      });

      // Settle any remaining items that did not emit individual top-level KTAP lines
      for (const item of testItems) {
        if (settledItems.has(item.id)) {
          continue;
        }
        if (result.cancelled) {
          run.skipped(item);
        } else if (result.bootTimedOut) {
          run.errored(
            item,
            new vscode.TestMessage(
              `QEMU boot timed out after ${effectiveBootTimeoutSec}s before reaching run_target.sh.`
            )
          );
        } else if (result.timedOut) {
          run.failed(
            item,
            new vscode.TestMessage(`QEMU run timed out after ${effectiveTimeoutSec}s.`)
          );
        } else if (crashMessage) {
          run.errored(
            item,
            new vscode.TestMessage(`Kernel crash detected:\n${crashMessage}`)
          );
        } else if (result.guestExitCode === 0) {
          run.passed(item, result.durationMs);
        } else {
          run.failed(
            item,
            new vscode.TestMessage(
              `Guest exited with code ${result.guestExitCode ?? result.exitCode ?? 'unknown'}.`
            ),
            result.durationMs
          );
        }
      }

      if (withKprobes && !result.cancelled) {
        this.kprobeController.reloadTraceLogSilent();
        const autoOpen = vscode.workspace
          .getConfiguration('kdev.tracePlot')
          .get<boolean>('autoOpenOnSelftestTrace', false);
        if (autoOpen) {
          this.onTraceCaptured?.();
        }
      }
    } catch (err) {
      const msg =
        err instanceof QemuBusyError
          ? err.message
          : `QEMU execution failed: ${err instanceof Error ? err.message : String(err)}`;
      appendLine(msg);
      for (const item of testItems) {
        if (!settledItems.has(item.id)) {
          run.errored(item, new vscode.TestMessage(msg));
        }
      }
    } finally {
      cancelSub.dispose();

      // Cleanup guarantee: remove run_target.sh so manual `run_qemu.sh` stays interactive
      if (!settings.keepRunScript && fs.existsSync(runTargetPath)) {
        try {
          fs.unlinkSync(runTargetPath);
        } catch {
          // Ignore cleanup errors
        }
      }

      // Restore setup_kprobes.sh permissions if temporarily muted
      if (previousKprobesMode !== null && fs.existsSync(setupKprobesPath)) {
        try {
          fs.chmodSync(setupKprobesPath, previousKprobesMode);
        } catch {
          // Ignore chmod restore errors
        }
      }

      run.end();
    }
  }

  public dispose(): void {
    this.qemuRunner.cancel();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
