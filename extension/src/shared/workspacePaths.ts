import * as fs from 'node:fs';
import * as path from 'node:path';

export interface WorkspaceConfigOverrides {
  kernelSrcDir?: string;
  buildDir?: string;
  arch?: string;
  layersFile?: string;
  pythonPath?: string;
  autoRestartClangd?: boolean;
  perfBin?: string;
  traceGroup?: string;
  maxTraceEvents?: number;
  autoLoadTrace?: boolean;
}

export interface ResolvedWorkspacePaths {
  workspaceRoot: string;
  kernelDir: string;
  buildDir: string;
  sharedDir: string;
  vmlinuxPath: string;
  probesJsonPath: string;
  setupScriptPath: string;
  traceLogPath: string;
  dotConfigPath: string;
  autoconfPath: string;
  arch: string;
  layersJsonPath: string;
  userInjectedDir: string;
  pythonPath: string;
  autoRestartClangd: boolean;
  perfBin: string;
  traceGroup: string;
  maxTraceEvents: number;
  autoLoadTrace: boolean;
}

function resolveMaybeRelative(baseDir: string, target: string): string {
  if (path.isAbsolute(target)) {
    return path.normalize(target);
  }
  return path.resolve(baseDir, target);
}

/**
 * Convert an absolute filesystem path to a POSIX-style path relative to `kernelDir`.
 * Returns `null` if the path is outside `kernelDir`.
 */
export function toKernelRelativePath(kernelDir: string, absFsPath: string): string | null {
  const resolvedKernel = path.resolve(kernelDir);
  const resolvedTarget = path.resolve(absFsPath);
  const rel = path.relative(resolvedKernel, resolvedTarget);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    return null;
  }
  return rel.split(path.sep).join('/');
}

export function resolveWorkspacePaths(
  workspaceRoot: string,
  overrides: WorkspaceConfigOverrides = {}
): ResolvedWorkspacePaths {
  const wsRoot = path.resolve(workspaceRoot);
  const kernelDir = resolveMaybeRelative(wsRoot, overrides.kernelSrcDir || 'linux');
  const buildDir = resolveMaybeRelative(wsRoot, overrides.buildDir || 'build/current');
  const sharedDir = path.join(buildDir, 'shared');
  const arch = overrides.arch || 'x86_64';
  const layersJsonPath = overrides.layersFile
    ? resolveMaybeRelative(wsRoot, overrides.layersFile)
    : path.join(buildDir, 'layers.json');
  const userInjectedDir = path.join(buildDir, 'user_injected');

  const configuredPython = overrides.pythonPath || 'backend/.venv/bin/python';
  const candidatePython = resolveMaybeRelative(wsRoot, configuredPython);
  const pythonPath = fs.existsSync(candidatePython) ? candidatePython : configuredPython;

  const configuredPerf = overrides.perfBin || 'perf';
  const candidatePerf =
    configuredPerf.includes('/') || configuredPerf.includes(path.sep)
      ? resolveMaybeRelative(wsRoot, configuredPerf)
      : configuredPerf;

  return {
    workspaceRoot: wsRoot,
    kernelDir,
    buildDir,
    sharedDir,
    vmlinuxPath: path.join(buildDir, 'vmlinux'),
    probesJsonPath: path.join(sharedDir, 'probes.json'),
    setupScriptPath: path.join(sharedDir, 'setup_kprobes.sh'),
    traceLogPath: path.join(sharedDir, 'trace.log'),
    dotConfigPath: path.join(buildDir, '.config'),
    autoconfPath: path.join(buildDir, 'include', 'generated', 'autoconf.h'),
    arch,
    layersJsonPath,
    userInjectedDir,
    pythonPath,
    autoRestartClangd: overrides.autoRestartClangd ?? true,
    perfBin: candidatePerf,
    traceGroup: overrides.traceGroup || 'kdev',
    maxTraceEvents: overrides.maxTraceEvents ?? 10000,
    autoLoadTrace: overrides.autoLoadTrace ?? true,
  };
}
