import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { QemuBusyError, QemuRunner } from '../../src/qemu/qemuRunner';

const tempDirs: string[] = [];

function makeScript(body: string): { dir: string; scriptPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kdev-qemu-runner-'));
  tempDirs.push(dir);
  const scriptPath = path.join(dir, 'mock_qemu.sh');
  fs.writeFileSync(scriptPath, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return { dir, scriptPath };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('QemuRunner', () => {
  it('streams stdout and stderr lines and reads guest exit_code', async () => {
    const { dir, scriptPath } = makeScript(`
echo "booting kernel..."
echo "=== KDEV_SELFTEST_BEGIN ==="
echo "ok 1 sample"
echo "stderr note" >&2
echo "0" > "$EXIT_CODE_PATH"
echo "=== KDEV_SELFTEST_END rc=0 ==="
`);
    const exitCodePath = path.join(dir, 'exit_code');
    const runner = new QemuRunner();
    const lines: Array<{ line: string; stream: string }> = [];

    const res = await runner.run({
      workspaceRoot: dir,
      scriptPath,
      env: { EXIT_CODE_PATH: exitCodePath },
      exitCodePath,
      timeoutSec: 10,
      bootTimeoutSec: 5,
      onLine: (line, stream) => lines.push({ line, stream }),
    });

    expect(res.exitCode).toBe(0);
    expect(res.guestExitCode).toBe(0);
    expect(res.timedOut).toBe(false);
    expect(res.bootTimedOut).toBe(false);
    expect(res.cancelled).toBe(false);
    expect(lines.some((l) => l.stream === 'stdout' && l.line === 'ok 1 sample')).toBe(true);
    expect(lines.some((l) => l.stream === 'stderr' && l.line === 'stderr note')).toBe(true);
  });

  it('enforces single-session mutual exclusion with QemuBusyError', async () => {
    const { dir, scriptPath } = makeScript(`
echo "=== KDEV_SELFTEST_BEGIN ==="
sleep 2
`);
    const runner = new QemuRunner();
    const first = runner.run({
      workspaceRoot: dir,
      scriptPath,
      timeoutSec: 10,
      bootTimeoutSec: 5,
      killGraceMs: 100,
    });

    await expect(
      runner.run({ workspaceRoot: dir, scriptPath, timeoutSec: 10 })
    ).rejects.toBeInstanceOf(QemuBusyError);

    runner.cancel();
    const res = await first;
    expect(res.cancelled).toBe(true);
    expect(runner.isRunning()).toBe(false);
  });

  it('triggers boot-hang timeout when sentinel never appears', async () => {
    const { dir, scriptPath } = makeScript(`
echo "stuck in early boot..."
sleep 5
`);
    const runner = new QemuRunner();
    const res = await runner.run({
      workspaceRoot: dir,
      scriptPath,
      timeoutSec: 10,
      bootTimeoutSec: 0.3,
      killGraceMs: 100,
    });

    expect(res.bootTimedOut).toBe(true);
    expect(res.timedOut).toBe(false);
    expect(runner.isRunning()).toBe(false);
  });
});
