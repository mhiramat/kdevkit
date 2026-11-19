import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { linkInjectedConfigLayer } from '../../src/kconfig/layerInjection';
import { ConfigLayer } from '../../src/shared/protocol';

describe('Layer Injection & Selftest Config Symlinking (layerInjection.ts)', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('creates distinct symlinks for multiple tools/testing/selftests/*/config files and reflects upstream edits', () => {
    const wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kdev-layer-inj-'));
    tempDirs.push(wsRoot);

    const kernelDir = path.join(wsRoot, 'linux');
    const userInjectedDir = path.join(wsRoot, 'configs', 'user_injected');
    const ftraceDir = path.join(kernelDir, 'tools', 'testing', 'selftests', 'ftrace');
    const bpfDir = path.join(kernelDir, 'tools', 'testing', 'selftests', 'bpf');
    const netFwdDir = path.join(kernelDir, 'tools', 'testing', 'selftests', 'net', 'forwarding');

    fs.mkdirSync(ftraceDir, { recursive: true });
    fs.mkdirSync(bpfDir, { recursive: true });
    fs.mkdirSync(netFwdDir, { recursive: true });

    const ftraceConfig = path.join(ftraceDir, 'config');
    const bpfConfig = path.join(bpfDir, 'config');
    const netFwdConfig = path.join(netFwdDir, 'config');

    fs.writeFileSync(ftraceConfig, 'CONFIG_FTRACE=y\n', 'utf8');
    fs.writeFileSync(bpfConfig, 'CONFIG_BPF_SYSCALL=y\n', 'utf8');
    fs.writeFileSync(netFwdConfig, 'CONFIG_NET_SCH_FQ=y\n', 'utf8');

    let layers: ConfigLayer[] = [
      { id: 'qemu', path: 'configs/qemu.config', enabled: true, pinned: true },
      { id: 'trace', path: 'configs/trace.config', enabled: true, pinned: true },
      { id: 'solver', path: 'configs/solver_overlay.config', enabled: true, pinned: false, readonly: true },
    ];

    // 1. Inject selftests/ftrace/config
    const res1 = linkInjectedConfigLayer({
      srcFile: ftraceConfig,
      workspaceRoot: wsRoot,
      kernelDir,
      userInjectedDir,
      existingLayers: layers,
    });
    layers = res1.updatedLayers;
    expect(res1.newLayer.id).toBe('selftests_ftrace');
    expect(res1.newLayer.path).toBe('configs/user_injected/selftests_ftrace.config');
    expect(fs.lstatSync(res1.destPath).isSymbolicLink()).toBe(true);

    // 2. Inject selftests/bpf/config
    const res2 = linkInjectedConfigLayer({
      srcFile: bpfConfig,
      workspaceRoot: wsRoot,
      kernelDir,
      userInjectedDir,
      existingLayers: layers,
    });
    layers = res2.updatedLayers;
    expect(res2.newLayer.id).toBe('selftests_bpf');
    expect(res2.newLayer.path).toBe('configs/user_injected/selftests_bpf.config');
    expect(fs.lstatSync(res2.destPath).isSymbolicLink()).toBe(true);

    // 3. Inject nested selftests/net/forwarding/config
    const res3 = linkInjectedConfigLayer({
      srcFile: netFwdConfig,
      workspaceRoot: wsRoot,
      kernelDir,
      userInjectedDir,
      existingLayers: layers,
    });
    layers = res3.updatedLayers;
    expect(res3.newLayer.id).toBe('selftests_net_forwarding');
    expect(res3.newLayer.path).toBe('configs/user_injected/selftests_net_forwarding.config');
    expect(fs.lstatSync(res3.destPath).isSymbolicLink()).toBe(true);

    // Verify all 3 layers coexist before 'solver'
    expect(layers.map((l) => l.id)).toEqual([
      'qemu',
      'trace',
      'selftests_ftrace',
      'selftests_bpf',
      'selftests_net_forwarding',
      'solver',
    ]);

    // Verify updating original ftrace/config is immediately reflected through the symlink
    fs.appendFileSync(ftraceConfig, 'CONFIG_FUNCTION_PROFILER=y\n', 'utf8');
    expect(fs.readFileSync(res1.destPath, 'utf8')).toContain('CONFIG_FUNCTION_PROFILER=y');
  });

  it('disambiguates colliding generic config names from different directories and is idempotent for same file', () => {
    const wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kdev-layer-col-'));
    tempDirs.push(wsRoot);

    const userInjectedDir = path.join(wsRoot, 'configs', 'user_injected');
    const dirA = path.join(wsRoot, 'extA', 'sub');
    const dirB = path.join(wsRoot, 'extB', 'sub');
    fs.mkdirSync(dirA, { recursive: true });
    fs.mkdirSync(dirB, { recursive: true });

    const cfgA = path.join(dirA, 'config');
    const cfgB = path.join(dirB, 'config');
    fs.writeFileSync(cfgA, 'CONFIG_A=y\n', 'utf8');
    fs.writeFileSync(cfgB, 'CONFIG_B=y\n', 'utf8');

    let layers: ConfigLayer[] = [];

    const first = linkInjectedConfigLayer({
      srcFile: cfgA,
      workspaceRoot: wsRoot,
      userInjectedDir,
      existingLayers: layers,
    });
    layers = first.updatedLayers;
    expect(first.newLayer.id).toBe('sub_config');

    // Re-injecting the exact same file is idempotent
    const sameAgain = linkInjectedConfigLayer({
      srcFile: cfgA,
      workspaceRoot: wsRoot,
      userInjectedDir,
      existingLayers: layers,
    });
    layers = sameAgain.updatedLayers;
    expect(sameAgain.newLayer.id).toBe('sub_config');
    expect(layers).toHaveLength(1);

    // Injecting a different file that also has parent 'sub' and name 'config' gets '_2'
    const second = linkInjectedConfigLayer({
      srcFile: cfgB,
      workspaceRoot: wsRoot,
      userInjectedDir,
      existingLayers: layers,
    });
    layers = second.updatedLayers;
    expect(second.newLayer.id).toBe('sub_config_2');
    expect(layers.map((l) => l.id)).toEqual(['sub_config', 'sub_config_2']);
  });
});
