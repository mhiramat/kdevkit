import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';
import {
  AvailableVar,
  KprobeSpec,
  PerfProbeOptions,
  ProbeKind,
  ProbeableLine,
} from './types';

const execFileAsync = promisify(execFile);

const IDENTIFIER_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const FUNC_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_.]*$/;
const UNSAFE_SHELL_RE = /[;\n\r`|&]|\$\(/;
const DEF_LINE_RE = /^[pr]:[a-zA-Z0-9_]+\/[a-zA-Z0-9_]+\s+/;
const DEF_EVENT_NAME_RE = /^[pr]:[a-zA-Z0-9_]+\/([a-zA-Z0-9_]+)\s+/;

export class PerfProbeError extends Error {
  public readonly stderr: string;
  public readonly stdout: string;

  constructor(message: string, stdout = '', stderr = '') {
    super(message);
    this.name = 'PerfProbeError';
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

export function validateProbeId(id: string): void {
  if (!IDENTIFIER_RE.test(id)) {
    throw new Error(`Invalid probe id "${id}": must match ${IDENTIFIER_RE.source}`);
  }
}

export function validateGroupName(group: string): void {
  if (!IDENTIFIER_RE.test(group)) {
    throw new Error(`Invalid trace group "${group}": must match ${IDENTIFIER_RE.source}`);
  }
}

export function validateCustomExpr(expr: string): void {
  const trimmed = expr.trim();
  if (!trimmed) {
    throw new Error('Custom expression must not be empty');
  }
  if (UNSAFE_SHELL_RE.test(trimmed)) {
    throw new Error(`Unsafe characters detected in probe expression: "${expr}"`);
  }
  if (/\s/.test(trimmed)) {
    throw new Error(`Probe expression must be a single token without whitespace: "${expr}"`);
  }
}

export function escapeSingleQuotes(text: string): string {
  return text.replace(/'/g, "'\\''");
}

/**
 * Parse stdout of `perf probe -V <file>:<line>` into deduplicated local variables.
 */
export function parseAvailableVarsOutput(stdout: string): AvailableVar[] {
  const lines = stdout.split(/\r?\n/);
  const seen = new Set<string>();
  const vars: AvailableVar[] = [];
  let inVarsSection = false;

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) {
      continue;
    }
    if (trimmed.startsWith('Available variables at')) {
      inVarsSection = true;
      continue;
    }
    if (!inVarsSection) {
      continue;
    }
    if (trimmed.startsWith('@<')) {
      continue;
    }

    // Typical lines:
    //   "int\tdfd"
    //   "struct file*\tf"
    //   "const char *\tfilename"
    //   "struct open_flags\top"
    const match = trimmed.match(/^(.*\S)\s+(\**[a-zA-Z_][a-zA-Z0-9_]*)$/);
    if (!match) {
      continue;
    }

    let typePart = match[1].trim();
    let namePart = match[2].trim();

    // Move leading pointer stars from name to type if present
    const starMatch = namePart.match(/^(\*+)([a-zA-Z_][a-zA-Z0-9_]*)$/);
    if (starMatch) {
      typePart = `${typePart}${starMatch[1]}`;
      namePart = starMatch[2];
    }

    if (!seen.has(namePart)) {
      seen.add(namePart);
      vars.push({ name: namePart, type: typePart });
    }
  }

  return vars;
}

/**
 * Parse stdout of `perf probe -L ...` into probeable line numbers and code text.
 */
export function parseProbeableLinesOutput(stdout: string): ProbeableLine[] {
  const lines = stdout.split(/\r?\n/);
  const result: ProbeableLine[] = [];

  for (const rawLine of lines) {
    if (rawLine.startsWith('<') && rawLine.endsWith('>')) {
      continue;
    }
    const match = rawLine.match(/^\s*(\d+)[ ]{1,2}(.*)$/);
    if (!match) {
      continue;
    }
    const lineNum = Number.parseInt(match[1], 10);
    if (Number.isFinite(lineNum) && lineNum > 0) {
      result.push({ line: lineNum, code: match[2] });
    }
  }

  return result;
}

/**
 * Parse stdout of `perf probe -D ...` into Tracefs kprobe_events definition lines.
 */
export function parseDefinitionsOutput(stdout: string): string[] {
  const lines = stdout.split(/\r?\n/);
  const defs: string[] = [];

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (DEF_LINE_RE.test(trimmed)) {
      defs.push(trimmed);
    }
  }

  return defs;
}

/**
 * Extract Tracefs event names (e.g. "p1", "p1_1", "p2__return") from `perf probe -D` lines.
 */
export function extractEventNamesFromDefinitions(definitions: string[]): string[] {
  const names: string[] = [];
  for (const def of definitions) {
    const match = def.trim().match(DEF_EVENT_NAME_RE);
    if (match) {
      names.push(match[1]);
    }
  }
  return names;
}

async function runPerfProbe(
  opts: PerfProbeOptions,
  extraArgs: string[],
  modulePath?: string
): Promise<{ stdout: string; stderr: string }> {
  const args = ['probe', '-k', opts.vmlinuxPath, '-s', opts.kernelDir];
  if (modulePath) {
    args.push('-m', modulePath);
  }
  args.push(...extraArgs);

  try {
    const res = await execFileAsync(opts.perfBin, args, {
      timeout: opts.timeoutMs ?? 30_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return {
      stdout: res.stdout?.toString() ?? '',
      stderr: res.stderr?.toString() ?? '',
    };
  } catch (err: unknown) {
    const e = err as {
      message?: string;
      stdout?: string | Buffer;
      stderr?: string | Buffer;
    };
    const stdout = e.stdout ? e.stdout.toString() : '';
    const stderr = e.stderr ? e.stderr.toString() : '';
    const detail = stderr.trim() || stdout.trim() || e.message || 'perf probe failed';
    throw new PerfProbeError(detail, stdout, stderr);
  }
}

/**
 * Query available local variables at `<fileRel>:<line>` using `perf probe -V`.
 * Returns an empty array if `perf probe -V` exits non-zero (e.g. no local vars in scope).
 */
export async function queryAvailableVars(
  opts: PerfProbeOptions,
  fileRel: string,
  line: number,
  modulePath?: string
): Promise<AvailableVar[]> {
  try {
    const { stdout } = await runPerfProbe(opts, ['-V', `${fileRel}:${line}`], modulePath);
    return parseAvailableVarsOutput(stdout);
  } catch {
    return [];
  }
}

/**
 * Query nearby probeable lines around `centerLine` using `perf probe -L`.
 * Tries `<fileRel>:<start>-<end>` first and falls back to `<fileRel>` filtered locally
 * to handle perf versions where `SRC:start-end` range parsing returns EINVAL.
 */
export async function queryProbeableLines(
  opts: PerfProbeOptions,
  fileRel: string,
  centerLine: number,
  windowRadius = 5,
  modulePath?: string
): Promise<ProbeableLine[]> {
  const startLine = Math.max(1, centerLine - windowRadius);
  const endLine = centerLine + windowRadius;

  try {
    const { stdout } = await runPerfProbe(
      opts,
      ['-L', `${fileRel}:${startLine}-${endLine}`],
      modulePath
    );
    const parsed = parseProbeableLinesOutput(stdout).filter(
      (item) => item.line >= startLine && item.line <= endLine
    );
    if (parsed.length > 0) {
      return parsed;
    }
  } catch {
    // Fall through to full-file query below.
  }

  try {
    const { stdout } = await runPerfProbe(opts, ['-L', fileRel], modulePath);
    return parseProbeableLinesOutput(stdout).filter(
      (item) => item.line >= startLine && item.line <= endLine
    );
  } catch {
    return [];
  }
}

export interface GenerateDefinitionInput {
  id: string;
  group: string;
  kind: ProbeKind;
  file: string;
  line: number;
  funcName?: string;
  vars: string[];
  customExprs: string[];
  module?: string;
}

export function buildPerfProbeSpecArg(input: GenerateDefinitionInput): string {
  validateProbeId(input.id);
  validateGroupName(input.group);

  const tokens: string[] = [];
  if (input.kind === 'kretprobe') {
    if (!input.funcName || !FUNC_NAME_RE.test(input.funcName)) {
      throw new Error(`Invalid function name for return probe: "${input.funcName ?? ''}"`);
    }
    tokens.push(`${input.group}:${input.id}=${input.funcName}%return`);
    const hasRetval = input.customExprs.some((expr) => expr.trim().includes('$retval'));
    if (!hasRetval) {
      tokens.push('$retval');
    }
  } else {
    if (!input.file || UNSAFE_SHELL_RE.test(input.file)) {
      throw new Error(`Invalid kernel source file path: "${input.file}"`);
    }
    if (!Number.isInteger(input.line) || input.line < 1) {
      throw new Error(`Invalid line number: ${input.line}`);
    }
    tokens.push(`${input.group}:${input.id}=${input.file}:${input.line}`);
    for (const v of input.vars) {
      validateCustomExpr(v);
      tokens.push(v.trim());
    }
  }

  for (const expr of input.customExprs) {
    validateCustomExpr(expr);
    tokens.push(expr.trim());
  }

  return tokens.join(' ');
}

/**
 * Generate Tracefs kprobe_events definition lines via `perf probe -D`.
 */
export async function generateDefinitions(
  opts: PerfProbeOptions,
  input: GenerateDefinitionInput
): Promise<string[]> {
  const specArg = buildPerfProbeSpecArg(input);
  const { stdout, stderr } = await runPerfProbe(opts, ['-D', specArg], input.module);
  const defs = parseDefinitionsOutput(stdout);
  if (defs.length === 0) {
    throw new PerfProbeError(
      `perf probe -D produced no Tracefs definitions for "${specArg}"`,
      stdout,
      stderr
    );
  }
  return defs;
}

/**
 * Render the POSIX shell script (`setup_kprobes.sh`) for Phase 1 guest `/init`.
 */
export function renderTracefsSetupScript(
  probes: KprobeSpec[],
  traceGroup = 'kdev'
): string {
  validateGroupName(traceGroup);

  const activeDefs: string[] = [];
  for (const probe of probes) {
    if (!probe.enabled || probe.status !== 'valid') {
      continue;
    }
    for (const def of probe.definitions) {
      const trimmed = def.trim();
      if (trimmed) {
        activeDefs.push(trimmed);
      }
    }
  }

  const lines: string[] = [
    '#!/bin/sh',
    'set -e',
    'TRACING=/sys/kernel/tracing',
    `GROUP="${traceGroup}"`,
    '',
    'echo 0 > "$TRACING/tracing_on"',
    'if [ -d "$TRACING/events/$GROUP" ]; then',
    '  echo 0 > "$TRACING/events/$GROUP/enable" 2>/dev/null || true',
    'fi',
    'echo > "$TRACING/kprobe_events"',
    'echo > "$TRACING/trace"',
  ];

  if (activeDefs.length > 0) {
    lines.push('');
    lines.push('# Active probes (enabled=true && status=valid)');
    for (const def of activeDefs) {
      lines.push(`echo '${escapeSingleQuotes(def)}' >> "$TRACING/kprobe_events"`);
    }
    lines.push('');
    lines.push('if [ -d "$TRACING/events/$GROUP" ]; then');
    lines.push('  echo 1 > "$TRACING/events/$GROUP/enable"');
    lines.push('  echo 1 > "$TRACING/tracing_on"');
    lines.push('fi');
  }

  lines.push('');
  return lines.join('\n');
}

/**
 * Write `build/current/shared/setup_kprobes.sh` with mode 0o755.
 */
export function writeTracefsSetup(
  scriptPath: string,
  probes: KprobeSpec[],
  traceGroup = 'kdev'
): string {
  const content = renderTracefsSetupScript(probes, traceGroup);
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  fs.writeFileSync(scriptPath, content, { encoding: 'utf-8', mode: 0o755 });
  fs.chmodSync(scriptPath, 0o755);
  return content;
}
