import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProbeStore } from '../../src/kprobe/probeStore';
import { KprobeSpec } from '../../src/kprobe/types';
import { toKernelRelativePath } from '../../src/shared/workspacePaths';

function makeProbe(overrides: Partial<KprobeSpec> = {}): KprobeSpec {
  return {
    id: 'p1',
    group: 'kdev',
    kind: 'kprobe',
    enabled: true,
    file: 'fs/open.c',
    line: 1438,
    vars: ['dfd'],
    customExprs: [],
    definitions: ['p:kdev/p1 do_sys_openat2+73 dfd=%r13:s32'],
    vmlinuxMtimeMs: 1000,
    status: 'valid',
    ...overrides,
  };
}

describe('ProbeStore & workspacePaths', () => {
  let tmpDir: string;
  let probesJsonPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kdev-store-unit-'));
    probesJsonPath = path.join(tmpDir, 'shared', 'probes.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('persists and reloads probes.json round-trip', () => {
    const store1 = new ProbeStore(probesJsonPath);
    const id1 = store1.allocateNextProbeId();
    const id2 = store1.allocateNextProbeId();
    expect(id1).toBe('p1');
    expect(id2).toBe('p2');

    store1.addProbe(makeProbe({ id: id1 }));
    store1.addProbe(makeProbe({ id: id2, line: 1442, kind: 'kretprobe', funcName: 'do_sys_openat2' }));
    store1.save();

    const store2 = new ProbeStore(probesJsonPath);
    const loaded = store2.load();
    expect(loaded).toHaveLength(2);
    expect(loaded[0].id).toBe('p1');
    expect(loaded[1].kind).toBe('kretprobe');
    expect(store2.allocateNextProbeId()).toBe('p3');
  });

  it('detects vmlinux staleness transitions', () => {
    const store = new ProbeStore(probesJsonPath);
    store.addProbe(makeProbe({ id: 'p1', vmlinuxMtimeMs: 1000 }));
    store.addProbe(makeProbe({ id: 'p2', vmlinuxMtimeMs: 2000 }));

    expect(store.checkStaleness(1000)).toBe(1);
    expect(store.getProbeById('p1')?.status).toBe('valid');
    expect(store.getProbeById('p2')?.status).toBe('stale');

    // Second check with same mtime does not re-transition already stale probes
    expect(store.checkStaleness(1000)).toBe(0);
  });

  it('shifts probe line numbers on document edits and marks shifted probes stale', () => {
    const store = new ProbeStore(probesJsonPath);
    store.addProbe(makeProbe({ id: 'p1', file: 'fs/open.c', line: 100 }));
    store.addProbe(makeProbe({ id: 'p2', file: 'fs/open.c', line: 200 }));
    store.addProbe(makeProbe({ id: 'p3', file: 'fs/read_write.c', line: 200 }));

    // Insert 5 lines at line 150 in fs/open.c -> only p2 shifts
    expect(store.adjustLinesForDocumentEdit('fs/open.c', 150, 5)).toBe(true);
    expect(store.getProbeById('p1')?.line).toBe(100);
    expect(store.getProbeById('p1')?.status).toBe('valid');
    expect(store.getProbeById('p2')?.line).toBe(205);
    expect(store.getProbeById('p2')?.status).toBe('stale');
    expect(store.getProbeById('p3')?.line).toBe(200);
    expect(store.getProbeById('p3')?.status).toBe('valid');

    // Delete 10 lines at line 50 in fs/open.c -> p1 and p2 both shift up
    expect(store.adjustLinesForDocumentEdit('fs/open.c', 50, -10)).toBe(true);
    expect(store.getProbeById('p1')?.line).toBe(90);
    expect(store.getProbeById('p1')?.status).toBe('stale');
    expect(store.getProbeById('p2')?.line).toBe(195);
  });

  it('filters events by probeId and free text and notifies event selection', () => {
    const store = new ProbeStore(probesJsonPath);
    let selectedSeen: number | null = null;
    store.onDidSelectEvent((idx) => {
      selectedSeen = idx;
    });

    store.setEvents({
      totalMatched: 3,
      truncated: false,
      events: [
        {
          index: 1,
          task: 'sh',
          pid: 10,
          cpu: 0,
          flags: 'd..2.',
          timestamp: 1.0,
          eventName: 'p1',
          probeId: 'p1',
          symbol: 'do_sys_openat2+0x14',
          argsText: 'dfd=0x3',
          argsMap: { dfd: '0x3' },
        },
        {
          index: 2,
          task: 'ls',
          pid: 11,
          cpu: 0,
          flags: 'd..2.',
          timestamp: 1.1,
          eventName: 'p2__return',
          probeId: 'p2',
          symbol: 'do_sys_openat2+0x0',
          argsText: 'arg1=0x4',
          argsMap: { arg1: '0x4' },
        },
        {
          index: 3,
          task: 'cat',
          pid: 12,
          cpu: 1,
          flags: 'd..2.',
          timestamp: 1.2,
          eventName: 'p1',
          probeId: 'p1',
          symbol: 'do_sys_openat2+0x14',
          argsText: 'dfd=0x5',
          argsMap: { dfd: '0x5' },
        },
      ],
    });

    expect(store.getHitCount('p1')).toBe(2);
    expect(store.getHitCount('p2')).toBe(1);

    store.setEventFilter({ probeId: 'p1' });
    expect(store.getFilteredEvents().map((e) => e.index)).toEqual([1, 3]);

    store.setEventFilter({ probeId: 'p1', text: 'cat-12' });
    expect(store.getFilteredEvents().map((e) => e.index)).toEqual([3]);

    store.selectEvent(3);
    expect(selectedSeen).toBe(3);
    expect(store.getSelectedEvent()?.task).toBe('cat');
  });

  it('normalizes kernel-relative paths and rejects files outside kernelDir', () => {
    const kernelDir = '/workspace/linux';
    expect(toKernelRelativePath(kernelDir, '/workspace/linux/fs/open.c')).toBe('fs/open.c');
    expect(toKernelRelativePath(kernelDir, '/workspace/scripts/run_qemu.sh')).toBeNull();
    expect(toKernelRelativePath(kernelDir, '/workspace/linux-next/fs/open.c')).toBeNull();
  });
});
