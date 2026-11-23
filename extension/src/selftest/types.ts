export type SelftestLinkMode = 'auto-libs' | 'static';

export type CheckConfigBeforeRunMode = 'prompt' | 'off';

export type GuestRuntimeProfile =
  | {
      kind: 'busybox-initramfs';
    }
  | {
      kind: 'external-rootfs';
      rootfsImage: string;
      rootfsMode?: 'ext4-image' | 'virtiofs-root';
    };

export interface TargetOverrideOptions {
  linkMode?: SelftestLinkMode;
  timeoutSec?: number;
  bootTimeoutSec?: number;
  runtimeProfile?: GuestRuntimeProfile;
}

export interface TargetSpec {
  name: string;
  dirPath: string;
  hasConfig: boolean;
  configPaths: string[];
}

export interface SelftestItem {
  id: string;
  target: string;
  name: string;
  kind: 'program' | 'subtest';
  runner: 'run_kselftest' | 'ftracetest';
  /** For ftracetest subtests, path relative to ftrace/ directory (e.g. test.d/00basic/basic1.tc) */
  relativePath?: string;
}

export interface ConfigRequirement {
  symbol: string;
  required: string;
  current: string;
  sourceFile: string;
}

export interface ConfigCheckResult {
  target: string;
  status: 'satisfied' | 'missing' | 'no-config-file';
  missing: ConfigRequirement[];
  configPaths: string[];
}

export type KtapStatus = 'pass' | 'fail' | 'skip' | 'xfail' | 'timeout' | 'unresolved';

export type KtapEvent =
  | {
      type: 'begin';
      raw: string;
    }
  | {
      type: 'end';
      exitCode: number;
      raw: string;
    }
  | {
      type: 'suiteStart';
      target: string;
      test: string;
      raw: string;
    }
  | {
      type: 'testResult';
      index: number;
      status: KtapStatus;
      description: string;
      reason?: string;
      target?: string;
      test?: string;
      diagnostics?: string[];
      raw: string;
    }
  | {
      type: 'subtestResult';
      depth: number;
      index: number;
      status: KtapStatus;
      description: string;
      reason?: string;
      diagnostics?: string[];
      raw: string;
    }
  | {
      type: 'diagnostic';
      message: string;
      raw: string;
    }
  | {
      type: 'kernelCrash';
      line: string;
      excerpt: string[];
    };
