import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  generateSelftestRunScript,
  shellQuote,
} from '../../src/selftest/scriptGenerator';

describe('Selftest Guest Script Generator', () => {
  it('quotes shell arguments safely including single quotes', () => {
    expect(shellQuote("simple")).toBe("'simple'");
    expect(shellQuote("a'b c")).toBe("'a'\\''b c'");
  });

  it('generates valid POSIX sh script with Option A library wiring and selective tests', () => {
    const script = generateSelftestRunScript({
      items: [
        {
          id: 'breakpoints:breakpoint_test',
          target: 'breakpoints',
          name: 'breakpoint_test',
          kind: 'program',
          runner: 'run_kselftest',
        },
        {
          id: 'ftrace:ftracetest:test.d/00basic/basic1.tc',
          target: 'ftrace',
          name: 'test.d/00basic/basic1.tc',
          kind: 'subtest',
          runner: 'ftracetest',
          relativePath: 'test.d/00basic/basic1.tc',
        },
      ],
      kselftestTimeoutSec: 90,
    });

    expect(script).toContain('#!/bin/sh');
    expect(script).toContain('/mnt/host/kselftest-libs');
    expect(script).toContain('LD_LIBRARY_PATH=');
    expect(script).toContain('kselftest_override_timeout=90');
    expect(script).toContain('=== KDEV_SELFTEST_BEGIN ===');
    expect(script).toContain("./run_kselftest.sh -t 'breakpoints:breakpoint_test'");
    expect(script).toContain("./ftracetest 'test.d/00basic/basic1.tc'");
    expect(script).toContain('=== KDEV_SELFTEST_END rc=$RC ===');

    // Verify POSIX syntax with /bin/sh -n
    const tmpFile = path.join(os.tmpdir(), `kdev-run-target-${Date.now()}.sh`);
    fs.writeFileSync(tmpFile, script, 'utf-8');
    try {
      execFileSync('/bin/sh', ['-n', tmpFile]);
    } finally {
      fs.rmSync(tmpFile, { force: true });
    }
  });
});
