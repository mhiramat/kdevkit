import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildPerfProbeSpecArg,
  escapeSingleQuotes,
  extractEventNamesFromDefinitions,
  parseAvailableVarsOutput,
  parseDefinitionsOutput,
  parseProbeableLinesOutput,
  renderTracefsSetupScript,
  validateCustomExpr,
  validateProbeId,
  writeTracefsSetup,
} from '../../src/kprobe/perfProbe';
import { KprobeSpec } from '../../src/kprobe/types';

describe('perfProbe pure parsers & emitters', () => {
  it('parses perf probe -V output with pointers, structs, and duplicates', () => {
    const stdout = [
      'Available variables at @fs/open.c:1438',
      '        @<do_sys_openat2+73>',
      '                char*   filename',
      '                int     dfd',
      '                struct open_flags       op',
      '                struct file *f',
      '        @<do_sys_openat2_inlined+12>',
      '                int     dfd',
      '                const char *    path_str',
    ].join('\n');

    const vars = parseAvailableVarsOutput(stdout);
    expect(vars).toEqual([
      { name: 'filename', type: 'char*' },
      { name: 'dfd', type: 'int' },
      { name: 'op', type: 'struct open_flags' },
      { name: 'f', type: 'struct file*' },
      { name: 'path_str', type: 'const char *' },
    ]);
  });

  it('parses perf probe -L output with mixed probeable and non-probeable lines', () => {
    const stdout = [
      '<do_sys_openat2@/home/user/linux//fs/open.c:0>',
      '   1434  static int do_sys_openat2(int dfd, const char __user *filename,',
      '         \t\t\t  struct open_how *how)',
      '         {',
      '   1437  \tstruct open_flags op;',
      '   1438  \tint err = build_open_flags(how, &op);',
      '         \t\treturn err;',
    ].join('\n');

    const lines = parseProbeableLinesOutput(stdout);
    expect(lines).toEqual([
      { line: 1434, code: 'static int do_sys_openat2(int dfd, const char __user *filename,' },
      { line: 1437, code: '\tstruct open_flags op;' },
      { line: 1438, code: '\tint err = build_open_flags(how, &op);' },
    ]);
  });

  it('parses single-line and multi-line (inlined) perf probe -D output', () => {
    const stdout = [
      'p:kdev/p1 do_sys_openat2+73 dfd=%r13:s32 flags=%si:s32',
      'p:kdev/p1_1 __x64_sys_openat+40 dfd=%di:s32 flags=%dx:s32',
      'r:kdev/p2__return do_sys_openat2+0 $retval',
      '# comment or warning line',
    ].join('\n');

    const defs = parseDefinitionsOutput(stdout);
    expect(defs).toEqual([
      'p:kdev/p1 do_sys_openat2+73 dfd=%r13:s32 flags=%si:s32',
      'p:kdev/p1_1 __x64_sys_openat+40 dfd=%di:s32 flags=%dx:s32',
      'r:kdev/p2__return do_sys_openat2+0 $retval',
    ]);
    expect(extractEventNamesFromDefinitions(defs)).toEqual(['p1', 'p1_1', 'p2__return']);
  });

  it('validates probe ids and rejects unsafe shell characters in customExprs', () => {
    expect(() => validateProbeId('p1')).not.toThrow();
    expect(() => validateProbeId('my_probe_2')).not.toThrow();
    expect(() => validateProbeId('1bad')).toThrow();
    expect(() => validateProbeId('p1;rm')).toThrow();

    expect(() => validateCustomExpr('file->f_flags')).not.toThrow();
    expect(() => validateCustomExpr('$retval')).not.toThrow();
    expect(() => validateCustomExpr('dfd;echo')).toThrow();
    expect(() => validateCustomExpr('dfd\necho')).toThrow();
    expect(() => validateCustomExpr('`whoami`')).toThrow();
    expect(() => validateCustomExpr('$(id)')).toThrow();
    expect(() => validateCustomExpr('a b')).toThrow();
  });

  it('builds spec args for kprobe and kretprobe', () => {
    expect(
      buildPerfProbeSpecArg({
        id: 'p1',
        group: 'kdev',
        kind: 'kprobe',
        file: 'fs/open.c',
        line: 1438,
        vars: ['dfd', 'flags'],
        customExprs: ['how->flags'],
      })
    ).toBe('kdev:p1=fs/open.c:1438 dfd flags how->flags');

    expect(
      buildPerfProbeSpecArg({
        id: 'p2',
        group: 'kdev',
        kind: 'kretprobe',
        file: 'fs/open.c',
        line: 1434,
        funcName: 'do_sys_openat2',
        vars: [],
        customExprs: [],
      })
    ).toBe('kdev:p2=do_sys_openat2%return $retval');
  });

  it('emits setup_kprobes.sh skipping disabled/stale probes and escaping single quotes', () => {
    const probes: KprobeSpec[] = [
      {
        id: 'p1',
        group: 'kdev',
        kind: 'kprobe',
        enabled: true,
        file: 'fs/open.c',
        line: 1438,
        vars: ['dfd'],
        customExprs: [],
        definitions: ["p:kdev/p1 do_sys_openat2+73 dfd=%r13:s32 tag='ok'"],
        vmlinuxMtimeMs: 1000,
        status: 'valid',
      },
      {
        id: 'p2',
        group: 'kdev',
        kind: 'kprobe',
        enabled: false,
        file: 'fs/open.c',
        line: 1440,
        vars: [],
        customExprs: [],
        definitions: ['p:kdev/p2 do_sys_openat2+90'],
        vmlinuxMtimeMs: 1000,
        status: 'valid',
      },
      {
        id: 'p3',
        group: 'kdev',
        kind: 'kprobe',
        enabled: true,
        file: 'fs/open.c',
        line: 1442,
        vars: [],
        customExprs: [],
        definitions: ['p:kdev/p3 do_sys_openat2+100'],
        vmlinuxMtimeMs: 500,
        status: 'stale',
      },
    ];

    const script = renderTracefsSetupScript(probes, 'kdev');
    expect(script).toContain("echo 'p:kdev/p1 do_sys_openat2+73 dfd=%r13:s32 tag='\\''ok'\\''' >> \"$TRACING/kprobe_events\"");
    expect(script).not.toContain('kdev/p2');
    expect(script).not.toContain('kdev/p3');
    expect(script).toContain('echo 1 > "$TRACING/tracing_on"');

    // Empty active list still emits cleanup header without turning tracing_on on
    const emptyScript = renderTracefsSetupScript([probes[1], probes[2]], 'kdev');
    expect(emptyScript).toContain('echo > "$TRACING/kprobe_events"');
    expect(emptyScript).not.toContain('echo 1 > "$TRACING/tracing_on"');

    expect(escapeSingleQuotes("a'b")).toBe("a'\\''b");

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kdev-perf-unit-'));
    try {
      const scriptPath = path.join(tmpDir, 'setup_kprobes.sh');
      writeTracefsSetup(scriptPath, probes, 'kdev');
      const stat = fs.statSync(scriptPath);
      expect(stat.mode & 0o111).not.toBe(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
