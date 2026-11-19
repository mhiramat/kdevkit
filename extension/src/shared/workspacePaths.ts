import * as fs from 'node:fs';
import * as path from 'node:path';

export interface WorkspaceConfigOverrides {
  kernelSrcDir?: string;
  buildDir?: string;
  arch?: string;
  layersFile?: string;
  pythonPath?: string;
  autoRestartClangd?: boolean;
}

export interface ResolvedWorkspacePaths {
  workspaceRoot: string;
  kernelDir: string;
  buildDir: string;
  dotConfigPath: string;
  autoconfPath: string;
  arch: string;
  layersJsonPath: string;
  userInjectedDir: string;
  pythonPath: string;
  autoRestartClangd: boolean;
}

function resolveMaybeRelative(baseDir: string, target: string): string {
  if (path.isAbsolute(target)) {
    return path.normalize(target);
  }
  return path.resolve(baseDir, target);
}

export function resolveWorkspacePaths(
  workspaceRoot: string,
  overrides: WorkspaceConfigOverrides = {}
): ResolvedWorkspacePaths {
  const wsRoot = path.resolve(workspaceRoot);
  const kernelDir = resolveMaybeRelative(wsRoot, overrides.kernelSrcDir || 'linux');
  const buildDir = resolveMaybeRelative(wsRoot, overrides.buildDir || 'build/current');
  const arch = overrides.arch || 'x86_64';
  const layersJsonPath = resolveMaybeRelative(wsRoot, overrides.layersFile || 'configs/layers.json');
  const userInjectedDir = path.resolve(wsRoot, 'configs', 'user_injected');

  const configuredPython = overrides.pythonPath || 'backend/.venv/bin/python';
  const candidatePython = resolveMaybeRelative(wsRoot, configuredPython);
  const pythonPath = fs.existsSync(candidatePython) ? candidatePython : configuredPython;

  return {
    workspaceRoot: wsRoot,
    kernelDir,
    buildDir,
    dotConfigPath: path.join(buildDir, '.config'),
    autoconfPath: path.join(buildDir, 'include', 'generated', 'autoconf.h'),
    arch,
    layersJsonPath,
    userInjectedDir,
    pythonPath,
    autoRestartClangd: overrides.autoRestartClangd ?? true,
  };
}
