import * as fs from 'node:fs';
import * as path from 'node:path';
import { ConfigLayer } from '../shared/protocol';

export interface DerivedLayerIdentity {
  baseId: string;
  fileName: string;
}

function sanitizeId(raw: string): string {
  return raw
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

/**
 * Derive a descriptive base layer ID and filename for an injected config file.
 * Handles tools/testing/selftests/<suite>/config and generic extensionless "config" files.
 */
export function deriveLayerIdentity(
  srcFile: string,
  workspaceRoot: string,
  kernelDir?: string
): DerivedLayerIdentity {
  const absSrc = path.resolve(srcFile);
  const normalized = absSrc.replace(/\\/g, '/');
  const baseName = path.basename(absSrc);

  // 1. Check for tools/testing/selftests/<suite...>/config
  const selftestMatch = normalized.match(
    /\/tools\/testing\/selftests\/(.+)\/config(?:\.(?:config|cfg|fragment))?$/i
  );
  if (selftestMatch && selftestMatch[1]) {
    const suiteId = sanitizeId(selftestMatch[1]);
    const baseId = `selftests_${suiteId || 'config'}`;
    return {
      baseId,
      fileName: `${baseId}.config`,
    };
  }

  // 2. Strip known config extensions if present
  const stem = baseName.replace(/^\./, '').replace(/\.(config|cfg|fragment)$/i, '');
  const isGenericConfigName =
    stem.toLowerCase() === 'config' || stem.toLowerCase() === 'defconfig' || !stem;

  if (isGenericConfigName) {
    const parentDir = path.basename(path.dirname(absSrc));
    const rootCandidates = [
      path.basename(path.resolve(workspaceRoot)),
      kernelDir ? path.basename(path.resolve(kernelDir)) : 'linux',
      'configs',
    ];
    if (parentDir && !rootCandidates.includes(parentDir)) {
      const baseId = sanitizeId(`${parentDir}_${stem || 'config'}`);
      return {
        baseId: baseId || 'user_config',
        fileName: `${baseId || 'user_config'}.config`,
      };
    }
  }

  const cleanId = sanitizeId(stem) || 'user_config';
  return {
    baseId: cleanId,
    fileName: `${cleanId}.config`,
  };
}

function sameRealPath(fileA: string, fileB: string): boolean {
  try {
    return fs.realpathSync(fileA) === fs.realpathSync(fileB);
  } catch {
    return path.resolve(fileA) === path.resolve(fileB);
  }
}

/**
 * Create a symbolic link inside userInjectedDir (e.g. build/current/user_injected/) pointing to srcFile,
 * avoiding collisions when multiple "config" files from different directories are injected.
 */
export function linkInjectedConfigLayer(options: {
  srcFile: string;
  workspaceRoot: string;
  kernelDir?: string;
  userInjectedDir: string;
  existingLayers: ConfigLayer[];
  linkIntoWorkspace?: boolean;
}): {
  newLayer: ConfigLayer;
  updatedLayers: ConfigLayer[];
  destPath: string;
} {
  const absSrc = path.resolve(options.srcFile);
  if (!fs.existsSync(absSrc)) {
    throw new Error(`Config file does not exist: ${absSrc}`);
  }

  const linkIntoWorkspace = options.linkIntoWorkspace ?? true;
  const { baseId } = deriveLayerIdentity(
    absSrc,
    options.workspaceRoot,
    options.kernelDir
  );

  fs.mkdirSync(options.userInjectedDir, { recursive: true });

  // Find a non-colliding layerId and symlink filename in configs/user_injected/
  let candidateId = baseId;
  let suffix = 1;

  while (true) {
    const candidateFile = path.join(options.userInjectedDir, `${candidateId}.config`);
    const existingLayer = options.existingLayers.find((l) => l.id === candidateId);

    let fileCollides = false;
    if (fs.existsSync(candidateFile) || fs.lstatSync(candidateFile, { throwIfNoEntry: false })) {
      if (!sameRealPath(candidateFile, absSrc)) {
        fileCollides = true;
      }
    }

    let layerCollides = false;
    if (existingLayer) {
      const existingResolved = path.resolve(options.workspaceRoot, existingLayer.path);
      if (!sameRealPath(existingResolved, absSrc)) {
        layerCollides = true;
      }
    }

    if (!fileCollides && !layerCollides) {
      break;
    }

    suffix += 1;
    candidateId = `${baseId}_${suffix}`;
  }

  let storedRelPath: string;
  let destPath = absSrc;

  if (linkIntoWorkspace) {
    destPath = path.join(options.userInjectedDir, `${candidateId}.config`);
    if (path.resolve(absSrc) !== path.resolve(destPath)) {
      const existingStat = fs.lstatSync(destPath, { throwIfNoEntry: false });
      if (existingStat) {
        fs.unlinkSync(destPath);
      }
      // Prefer a relative symlink if srcFile is inside workspaceRoot, otherwise absolute
      const relFromWs = path.relative(options.workspaceRoot, absSrc);
      const symlinkTarget = !relFromWs.startsWith('..')
        ? path.relative(path.dirname(destPath), absSrc)
        : absSrc;
      fs.symlinkSync(symlinkTarget, destPath);
    }
    storedRelPath = path
      .relative(options.workspaceRoot, destPath)
      .replace(/\\/g, '/');
  } else {
    const rel = path.relative(options.workspaceRoot, absSrc);
    storedRelPath = rel.startsWith('..') ? absSrc : rel.replace(/\\/g, '/');
  }

  const newLayer: ConfigLayer = {
    id: candidateId,
    path: storedRelPath,
    enabled: true,
    pinned: false,
    readonly: false,
  };

  const filtered = options.existingLayers.filter((l) => l.id !== candidateId);
  const solverIdx = filtered.findIndex((l) => l.id === 'solver');
  if (solverIdx >= 0) {
    filtered.splice(solverIdx, 0, newLayer);
  } else {
    filtered.push(newLayer);
  }

  return {
    newLayer,
    updatedLayers: filtered,
    destPath,
  };
}
