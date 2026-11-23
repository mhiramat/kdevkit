import { KDEV_SELFTEST_BEGIN } from './ktapParser';
import { SelftestItem } from './types';

export interface RunScriptOptions {
  /** Selected test items to execute inside QEMU. */
  items: SelftestItem[];
  /** Whole target collections to run via `./run_kselftest.sh -c <target>`. */
  collections?: string[];
  /**
   * Optional override for per-test kselftest timeout inside guest.
   * When omitted, kselftest's own per-target `settings` file (e.g. `ftrace/settings`
   * with `timeout=0`) is respected.
   */
  kselftestTimeoutSec?: number;
}

/**
 * Safely quote an arbitrary string for POSIX `/bin/sh`.
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Generate `build/current/shared/run_target.sh` for executing selected kselftests
 * inside the Phase 1 BusyBox initramfs guest.
 */
export function generateSelftestRunScript(options: RunScriptOptions): string {
  const kselftestTimeout =
    options.kselftestTimeoutSec !== undefined
      ? Math.max(0, Math.floor(options.kselftestTimeoutSec))
      : undefined;
  const collections = options.collections ?? [];
  const runKselftestItems = options.items.filter((i) => i.runner === 'run_kselftest');
  const ftracetestItems = options.items.filter((i) => i.runner === 'ftracetest');

  const lines: string[] = [
    '#!/bin/sh',
    'set -u',
    '',
    '# 1. Wire Phase 3A Option A shared libraries (no initramfs rebuild needed)',
    'if [ -d /mnt/host/kselftest-libs ]; then',
    '  for dir in lib lib64 usr/lib usr/lib64; do',
    '    if [ -d "/mnt/host/kselftest-libs/$dir" ]; then',
    '      mkdir -p "/$dir"',
    '      for item in "/mnt/host/kselftest-libs/$dir"/*; do',
    '        [ -e "$item" ] || continue',
    '        base="$(basename "$item")"',
    '        [ -e "/$dir/$base" ] || ln -s "$item" "/$dir/$base"',
    '      done',
    '    fi',
    '  done',
    '  export LD_LIBRARY_PATH="/mnt/host/kselftest-libs/lib:/mnt/host/kselftest-libs/lib64:/mnt/host/kselftest-libs/lib/x86_64-linux-gnu:/mnt/host/kselftest-libs/usr/lib:/mnt/host/kselftest-libs/usr/lib/x86_64-linux-gnu:${LD_LIBRARY_PATH:-}"',
    'fi',
    '',
    '# 2. Ensure debugfs/tracefs, temp directory, and PATH are initialized',
    'mkdir -p /sys/kernel/debug /sys/kernel/tracing /tmp',
    'mount -t debugfs nodev /sys/kernel/debug 2>/dev/null || true',
    'mount -t tracefs nodev /sys/kernel/tracing 2>/dev/null || true',
    'export TMPDIR=/tmp',
    'export PATH="/bin:/sbin:/usr/bin:/usr/sbin:${PATH:-}"',
    ...(kselftestTimeout !== undefined
      ? [`export kselftest_override_timeout=${kselftestTimeout}`]
      : []),
    '',
    `echo ${shellQuote(KDEV_SELFTEST_BEGIN)}`,
    'cd /mnt/host/kselftest || {',
    '  echo "=== KDEV_SELFTEST_END rc=127 ==="',
    '  exit 127',
    '}',
    '',
    'RC=0',
  ];

  if (collections.length > 0) {
    const colArgs = collections.map((c) => `-c ${shellQuote(c)}`).join(' ');
    lines.push(`./run_kselftest.sh ${colArgs}`);
    lines.push('STEP_RC=$?');
    lines.push('if [ "$STEP_RC" -ne 0 ]; then RC="$STEP_RC"; fi');
  }

  if (runKselftestItems.length > 0) {
    const testArgs = runKselftestItems
      .map((item) => `-t ${shellQuote(`${item.target}:${item.name}`)}`)
      .join(' ');
    lines.push(`./run_kselftest.sh ${testArgs}`);
    lines.push('STEP_RC=$?');
    lines.push('if [ "$STEP_RC" -ne 0 ]; then RC="$STEP_RC"; fi');
  }

  if (ftracetestItems.length > 0) {
    const tcArgs = ftracetestItems
      .map((item) => shellQuote(item.relativePath || item.name))
      .join(' ');
    lines.push('(cd /mnt/host/kselftest/ftrace && ./ftracetest ' + tcArgs + ')');
    lines.push('STEP_RC=$?');
    lines.push('if [ "$STEP_RC" -ne 0 ]; then RC="$STEP_RC"; fi');
  }

  if (
    collections.length === 0 &&
    runKselftestItems.length === 0 &&
    ftracetestItems.length === 0
  ) {
    lines.push('./run_kselftest.sh');
    lines.push('RC=$?');
  }

  lines.push('');
  lines.push('echo "=== KDEV_SELFTEST_END rc=$RC ==="');
  lines.push('exit "$RC"');
  lines.push('');

  return lines.join('\n');
}
