import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { QemuRunner } from '../../src/qemu/qemuRunner';
import { KtapStreamParser } from '../../src/selftest/ktapParser';
import { generateSelftestRunScript } from '../../src/selftest/scriptGenerator';
import { KtapEvent } from '../../src/selftest/types';

const WORKSPACE_ROOT = path.resolve(__dirname, '..', '..', '..');
const BUILD_DIR = path.join(WORKSPACE_ROOT, 'build', 'current');
const SHARED_DIR = path.join(BUILD_DIR, 'shared');
const BZIMAGE = path.join(BUILD_DIR, 'arch', 'x86', 'boot', 'bzImage');
const INITRAMFS = path.join(BUILD_DIR, 'initramfs.cpio.gz');

const runRealQemu =
  process.env.REAL_KERNEL === '1' &&
  fs.existsSync(BZIMAGE) &&
  fs.existsSync(INITRAMFS);

describe.skipIf(!runRealQemu)('Layer 3: End-to-End Selftest in QEMU', () => {
  it(
    'builds breakpoints selftest with auto-libs, boots QEMU, and parses KTAP output',
    async () => {
      execFileSync(
        path.join(WORKSPACE_ROOT, 'scripts', 'build_selftest.sh'),
        ['--link-mode', 'auto-libs', 'breakpoints'],
        { cwd: WORKSPACE_ROOT, stdio: 'pipe' }
      );

      const runTargetPath = path.join(SHARED_DIR, 'run_target.sh');
      const exitCodePath = path.join(SHARED_DIR, 'exit_code');
      const script = generateSelftestRunScript({
        items: [
          {
            id: 'breakpoints:breakpoint_test',
            target: 'breakpoints',
            name: 'breakpoint_test',
            kind: 'program',
            runner: 'run_kselftest',
          },
        ],
        kselftestTimeoutSec: 60,
      });

      fs.writeFileSync(runTargetPath, script, { mode: 0o755 });

      const parser = new KtapStreamParser();
      const events: KtapEvent[] = [];
      const runner = new QemuRunner();

      try {
        const res = await runner.run({
          workspaceRoot: WORKSPACE_ROOT,
          timeoutSec: 90,
          bootTimeoutSec: 45,
          exitCodePath,
          onLine: (line) => {
            events.push(...parser.feedLine(line));
          },
        });

        expect(res.bootTimedOut).toBe(false);
        expect(res.timedOut).toBe(false);
        expect(events.some((e) => e.type === 'begin')).toBe(true);
        expect(events.some((e) => e.type === 'end')).toBe(true);
        expect(events.some((e) => e.type === 'testResult')).toBe(true);
      } finally {
        if (fs.existsSync(runTargetPath)) {
          fs.unlinkSync(runTargetPath);
        }
      }
    },
    120000
  );
});
