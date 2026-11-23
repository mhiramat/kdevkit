import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  ConfigCheckResult,
  ConfigRequirement,
  SelftestItem,
  TargetSpec,
} from './types';

const SELFTESTS_REL = path.join('tools', 'testing', 'selftests');

/**
 * Resolve existing target config files (`config` and optional `config.<arch>`).
 */
export function findTargetConfigFiles(
  kernelDir: string,
  target: string,
  arch = 'x86_64'
): string[] {
  const targetDir = path.join(kernelDir, SELFTESTS_REL, target);
  const candidates = [
    path.join(targetDir, 'config'),
    path.join(targetDir, `config.${arch}`),
  ];
  return candidates.filter((p) => {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  });
}

/**
 * Scan `linux/tools/testing/selftests/` for valid target subdirectories containing a `Makefile`.
 */
export function listAvailableTargets(
  kernelDir: string,
  arch = 'x86_64'
): TargetSpec[] {
  const root = path.join(kernelDir, SELFTESTS_REL);
  if (!fs.existsSync(root)) {
    return [];
  }

  const entries = fs.readdirSync(root, { withFileTypes: true });
  const results: TargetSpec[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) {
      continue;
    }
    const dirPath = path.join(root, entry.name);
    const makefilePath = path.join(dirPath, 'Makefile');
    if (!fs.existsSync(makefilePath)) {
      continue;
    }
    const configPaths = findTargetConfigFiles(kernelDir, entry.name, arch);
    results.push({
      name: entry.name,
      dirPath,
      hasConfig: configPaths.length > 0,
      configPaths,
    });
  }

  results.sort((a, b) => a.name.localeCompare(b.name));
  return results;
}

/**
 * Parse `TEST_PROGS`, `TEST_GEN_PROGS`, and `TEST_PROGS_EXTENDED` assignments from a
 * kselftest `Makefile`, handling `+=`, `:=`, `=`, and trailing `\` line continuations.
 */
export function parseMakefileTestProgs(makefileContent: string): string[] {
  // Join backslash-continued lines
  const normalized = makefileContent.replace(/\\\r?\n/g, ' ');
  const lines = normalized.split(/\r?\n/);

  const progs = new Set<string>();
  const assignRe =
    /^\s*(TEST_PROGS|TEST_GEN_PROGS|TEST_PROGS_EXTENDED)\s*(?:\+|:|\?)?=\s*(.*)$/;

  for (const rawLine of lines) {
    const commentIdx = rawLine.indexOf('#');
    const line = commentIdx >= 0 ? rawLine.slice(0, commentIdx) : rawLine;
    const match = line.match(assignRe);
    if (!match) {
      continue;
    }
    const rhs = match[2].trim();
    if (!rhs) {
      continue;
    }
    for (const token of rhs.split(/\s+/)) {
      const cleaned = token.trim();
      if (!cleaned) {
        continue;
      }
      // Skip unresolved Make variable expansions like $(ARCH_TESTS) or $(OUTPUT)/foo
      if (cleaned.includes('$(') || cleaned.includes('${')) {
        continue;
      }
      progs.add(cleaned);
    }
  }

  return Array.from(progs);
}

/**
 * Parse `kselftest-list.txt` entries (`<target>:<executable>`).
 */
export function parseKselftestList(
  listContent: string,
  targetFilter?: string
): Array<{ target: string; test: string }> {
  const items: Array<{ target: string; test: string }> = [];
  const seen = new Set<string>();

  for (const rawLine of listContent.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    const sepIdx = line.indexOf(':');
    if (sepIdx <= 0 || sepIdx === line.length - 1) {
      continue;
    }
    const target = line.slice(0, sepIdx).trim();
    const test = line.slice(sepIdx + 1).trim();
    if (!target || !test) {
      continue;
    }
    if (targetFilter && target !== targetFilter) {
      continue;
    }
    const key = `${target}:${test}`;
    if (!seen.has(key)) {
      seen.add(key);
      items.push({ target, test });
    }
  }

  return items;
}

/**
 * Discover `.tc` subtests under `ftrace/test.d/` so maintainers can run individual
 * ftracetest cases in addition to the full suite.
 */
export function discoverFtraceSubtests(targetDir: string): string[] {
  const testDDir = path.join(targetDir, 'test.d');
  if (!fs.existsSync(testDDir)) {
    return [];
  }

  const results: string[] = [];
  const walk = (dir: string): void => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.tc')) {
        const rel = path.relative(targetDir, fullPath).split(path.sep).join('/');
        results.push(rel);
      }
    }
  };

  walk(testDDir);
  results.sort((a, b) => a.localeCompare(b));
  return results;
}

/**
 * Two-tier test discovery for a single enabled target:
 *  - Tier 2 (authoritative): `build/current/shared/kselftest/kselftest-list.txt` if present for target.
 *  - Tier 1 (fast static fallback): `Makefile` `TEST_PROGS`/`TEST_GEN_PROGS`/`TEST_PROGS_EXTENDED`.
 *  - Special sub-suite: `ftrace/test.d/**\/*.tc` appended as `ftracetest` subtest items.
 */
export function discoverTargetTests(options: {
  kernelDir: string;
  target: string;
  kselftestListPath?: string;
}): SelftestItem[] {
  const { kernelDir, target, kselftestListPath } = options;
  const targetDir = path.join(kernelDir, SELFTESTS_REL, target);
  const items: SelftestItem[] = [];
  const seenIds = new Set<string>();

  // Tier 2: authoritative kselftest-list.txt
  let usedAuthoritativeList = false;
  if (kselftestListPath && fs.existsSync(kselftestListPath)) {
    try {
      const listContent = fs.readFileSync(kselftestListPath, 'utf-8');
      const listed = parseKselftestList(listContent, target);
      if (listed.length > 0) {
        usedAuthoritativeList = true;
        for (const entry of listed) {
          const id = `${target}:${entry.test}`;
          if (!seenIds.has(id)) {
            seenIds.add(id);
            items.push({
              id,
              target,
              name: entry.test,
              kind: 'program',
              runner: 'run_kselftest',
            });
          }
        }
      }
    } catch {
      // Fall back to Tier 1 Makefile scan.
    }
  }

  // Tier 1: fast static Makefile scan
  if (!usedAuthoritativeList) {
    const makefilePath = path.join(targetDir, 'Makefile');
    if (fs.existsSync(makefilePath)) {
      const content = fs.readFileSync(makefilePath, 'utf-8');
      for (const prog of parseMakefileTestProgs(content)) {
        const id = `${target}:${prog}`;
        if (!seenIds.has(id)) {
          seenIds.add(id);
          items.push({
            id,
            target,
            name: prog,
            kind: 'program',
            runner: 'run_kselftest',
          });
        }
      }
    }
  }

  // Special Case: ftrace/test.d/**/*.tc sub-suite items
  if (target === 'ftrace' && fs.existsSync(path.join(targetDir, 'test.d'))) {
    for (const tcRel of discoverFtraceSubtests(targetDir)) {
      const id = `${target}:ftracetest:${tcRel}`;
      if (!seenIds.has(id)) {
        seenIds.add(id);
        items.push({
          id,
          target,
          name: tcRel,
          kind: 'subtest',
          runner: 'ftracetest',
          relativePath: tcRel,
        });
      }
    }
  }

  return items;
}

/**
 * Parse a Kconfig fragment or `.config` file into a map of `SYMBOL_NAME` (without `CONFIG_`
 * prefix) -> canonical value (`"y"`, `"m"`, `"n"`, or literal string/int/hex).
 */
export function parseKconfigFile(content: string): Map<string, string> {
  const result = new Map<string, string>();
  const setRe = /^CONFIG_([A-Za-z0-9_]+)=(.+)$/;
  const notSetRe = /^#\s*CONFIG_([A-Za-z0-9_]+)\s+is not set\s*$/;

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    const notSetMatch = line.match(notSetRe);
    if (notSetMatch) {
      result.set(notSetMatch[1], 'n');
      continue;
    }
    if (line.startsWith('#')) {
      continue;
    }
    const setMatch = line.match(setRe);
    if (setMatch) {
      result.set(setMatch[1], setMatch[2].trim());
    }
  }

  return result;
}

/**
 * Compare a selftest target's `config` (and optional `config.<arch>`) fragments against
 * the active `build/current/.config`.
 */
export function checkTargetConfig(options: {
  kernelDir: string;
  target: string;
  dotConfigPath: string;
  arch?: string;
}): ConfigCheckResult {
  const arch = options.arch || 'x86_64';
  const configPaths = findTargetConfigFiles(options.kernelDir, options.target, arch);

  if (configPaths.length === 0) {
    return {
      target: options.target,
      status: 'no-config-file',
      missing: [],
      configPaths: [],
    };
  }

  const activeConfig = fs.existsSync(options.dotConfigPath)
    ? parseKconfigFile(fs.readFileSync(options.dotConfigPath, 'utf-8'))
    : new Map<string, string>();

  const requiredMap = new Map<string, { required: string; sourceFile: string }>();
  for (const cfgPath of configPaths) {
    const parsed = parseKconfigFile(fs.readFileSync(cfgPath, 'utf-8'));
    for (const [symbol, required] of parsed.entries()) {
      requiredMap.set(symbol, { required, sourceFile: cfgPath });
    }
  }

  const missing: ConfigRequirement[] = [];
  for (const [symbol, { required, sourceFile }] of requiredMap.entries()) {
    const current = activeConfig.get(symbol) ?? 'n';
    if (current !== required) {
      missing.push({
        symbol,
        required,
        current,
        sourceFile,
      });
    }
  }

  missing.sort((a, b) => a.symbol.localeCompare(b.symbol));

  return {
    target: options.target,
    status: missing.length === 0 ? 'satisfied' : 'missing',
    missing,
    configPaths,
  };
}

export interface SkippedConfigRequirement {
  symbol: string;
  required: string;
  reason: string;
}

export interface SolvableFilterResult {
  requests: Array<{ symbol: string; value: string }>;
  skipped: SkippedConfigRequirement[];
}

/**
 * Filter missing selftest config requirements against the active kernel's Kconfig
 * symbol table so obsolete, renamed, arch-specific, or non-tristate symbols (such as
 * `RESERVE_MEM` in `selftests/ftrace/config`) are skipped with diagnostics instead
 * of aborting the SAT solver.
 */
export async function filterSolvableRequests(
  missing: ConfigRequirement[],
  lookupSymbol: (symbol: string) => Promise<{ type: string } | null>
): Promise<SolvableFilterResult> {
  const requests: Array<{ symbol: string; value: string }> = [];
  const skipped: SkippedConfigRequirement[] = [];

  for (const req of missing) {
    let detail: { type: string } | null = null;
    try {
      detail = await lookupSymbol(req.symbol);
    } catch {
      detail = null;
    }

    if (!detail) {
      skipped.push({
        symbol: req.symbol,
        required: req.required,
        reason: 'unknown symbol in current kernel Kconfig',
      });
      continue;
    }

    if (detail.type !== 'bool' && detail.type !== 'tristate') {
      skipped.push({
        symbol: req.symbol,
        required: req.required,
        reason: `unsupported symbol type '${detail.type}' for SAT solver`,
      });
      continue;
    }

    let value = req.required;
    if (detail.type === 'bool' && value === 'm') {
      value = 'y';
    }

    if (value !== 'y' && value !== 'm' && value !== 'n') {
      skipped.push({
        symbol: req.symbol,
        required: req.required,
        reason: `invalid tristate value '${req.required}'`,
      });
      continue;
    }

    requests.push({ symbol: req.symbol, value });
  }

  return { requests, skipped };
}
