import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  generateDefinitions,
  queryAvailableVars,
  queryProbeableLines,
  writeTracefsSetup,
} from '../../src/kprobe/perfProbe';
import { KprobeSpec, PerfProbeOptions } from '../../src/kprobe/types';

const wsRoot = path.resolve(__dirname, '..', '..', '..');
const vmlinuxPath = path.join(wsRoot, 'build', 'current', 'vmlinux');
const kernelDir = path.join(wsRoot, 'linux');
const openCPath = path.join(kernelDir, 'fs', 'open.c');
const perfBin = process.env.KDEV_PERF_BIN || 'perf';

function hasPerfBinary(): boolean {
  try {
    execFileSync(perfBin, ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function findDoSysOpenat2Lines(): { declLine: number; braceLine: number; bodyLine: number } | null {
  if (!fs.existsSync(openCPath)) {
    return null;
  }
  const lines = fs.readFileSync(openCPath, 'utf-8').split(/\r?\n/);
  const declIdx = lines.findIndex((l) => l.includes('static int do_sys_openat2('));
  if (declIdx === -1) {
    return null;
  }
  let braceIdx = -1;
  let bodyIdx = -1;
  for (let i = declIdx; i < Math.min(lines.length, declIdx + 20); i += 1) {
    if (braceIdx === -1 && lines[i].trim() === '{') {
      braceIdx = i;
    }
    if (bodyIdx === -1 && lines[i].includes('build_open_flags(')) {
      bodyIdx = i;
    }
  }
  if (braceIdx === -1 || bodyIdx === -1) {
    return null;
  }
  return {
    declLine: declIdx + 1,
    braceLine: braceIdx + 1,
    bodyLine: bodyIdx + 1,
  };
}

const canRunRealPerf =
  fs.existsSync(vmlinuxPath) && fs.existsSync(openCPath) && hasPerfBinary();

describe.skipIf(!canRunRealPerf)('perfVmlinux integration (real build/current/vmlinux)', () => {
  const opts: PerfProbeOptions = {
    perfBin,
    vmlinuxPath,
    kernelDir,
    timeoutMs: 30_000,
  };

  it('queries available variables, generates kprobe & kretprobe definitions, finds fallback lines, and validates setup_kprobes.sh', async () => {
    const loc = findDoSysOpenat2Lines();
    expect(loc).not.toBeNull();
    const { braceLine, bodyLine } = loc!;

    // 1. queryAvailableVars inside do_sys_openat2
    const vars = await queryAvailableVars(opts, 'fs/open.c', bodyLine);
    const varNames = vars.map((v) => v.name);
    expect(varNames).toContain('dfd');
    expect(varNames).toContain('filename');

    // 2. generateDefinitions for line kprobe
    const lineDefs = await generateDefinitions(opts, {
      id: 'p1',
      group: 'kdev',
      kind: 'kprobe',
      file: 'fs/open.c',
      line: bodyLine,
      vars: ['dfd'],
      customExprs: [],
    });
    expect(lineDefs.length).toBeGreaterThanOrEqual(1);
    expect(lineDefs[0]).toMatch(/^p:kdev\/p1\s+/);

    // 3. generateDefinitions for kretprobe
    const retDefs = await generateDefinitions(opts, {
      id: 'p2',
      group: 'kdev',
      kind: 'kretprobe',
      file: 'fs/open.c',
      line: bodyLine,
      funcName: 'do_sys_openat2',
      vars: [],
      customExprs: [],
    });
    expect(retDefs.length).toBeGreaterThanOrEqual(1);
    expect(retDefs[0]).toMatch(/^r:kdev\/p2(?:__return)?\s+/);

    // 4. queryProbeableLines around non-probeable brace line
    const nearby = await queryProbeableLines(opts, 'fs/open.c', braceLine, 5);
    expect(nearby.length).toBeGreaterThan(0);
    expect(nearby.some((n) => n.line === bodyLine)).toBe(true);

    // 5. Write setup_kprobes.sh to temp dir and validate POSIX syntax with sh -n
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kdev-perf-int-'));
    try {
      const scriptPath = path.join(tmpDir, 'setup_kprobes.sh');
      const probes: KprobeSpec[] = [
        {
          id: 'p1',
          group: 'kdev',
          kind: 'kprobe',
          enabled: true,
          file: 'fs/open.c',
          line: bodyLine,
          vars: ['dfd'],
          customExprs: [],
          definitions: lineDefs,
          vmlinuxMtimeMs: Date.now(),
          status: 'valid',
        },
        {
          id: 'p2',
          group: 'kdev',
          kind: 'kretprobe',
          enabled: true,
          file: 'fs/open.c',
          line: bodyLine,
          funcName: 'do_sys_openat2',
          vars: [],
          customExprs: ['$retval'],
          definitions: retDefs,
          vmlinuxMtimeMs: Date.now(),
          status: 'valid',
        },
      ];
      writeTracefsSetup(scriptPath, probes, 'kdev');
      execFileSync('sh', ['-n', scriptPath], { stdio: 'pipe' });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
