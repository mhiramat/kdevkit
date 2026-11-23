export type ProbeKind = 'kprobe' | 'kretprobe';
export type ProbeStatus = 'valid' | 'stale' | 'error';

export interface KprobeSpec {
  id: string;                 // Unique event name within group, e.g. "p1"
  group: string;              // Tracefs group, default "kdev"
  kind: ProbeKind;            // "kprobe" (line) or "kretprobe" (function return)
  enabled: boolean;           // Allows temporarily muting without deleting
  file: string;               // POSIX path relative to linux/, e.g. "fs/open.c"
  line: number;               // 1-based source line number
  funcName?: string;          // Populated for kretprobes (e.g. "do_sys_openat2")
  vars: string[];             // Selected local variables from perf probe -V
  customExprs: string[];      // Optional user expressions (e.g. "file->f_flags", "$retval")
  module?: string;            // Optional .ko path relative to buildDir (future module support)
  definitions: string[];      // Lines emitted by `perf probe -D` (may be >1 for inlined funcs)
  vmlinuxMtimeMs: number;     // vmlinux mtime at resolution time (for staleness checks)
  status: ProbeStatus;
  lastError?: string;
}

export interface ProbesFileSchema {
  version: 1;
  nextSeq: number;
  probes: KprobeSpec[];
}

export interface TraceEvent {
  index: number;                     // 1-based global sequence in trace.log
  task: string;                      // Process/thread name (e.g. "sh", "kworker/u4:1")
  pid: number;
  cpu: number;
  flags: string;                     // Tracefs irq/preempt flags (e.g. "d..2.")
  timestamp: number;                 // Seconds as float (e.g. 12.345678)
  eventName: string;                 // Raw event name in trace.log (e.g. "p1" or "p1_1")
  probeId?: string;                  // Resolved KprobeSpec.id
  symbol: string;                    // Symbol/offset or return callsite info
  argsText: string;                  // Raw trailing key=value string
  argsMap: Record<string, string>;   // Parsed key -> value pairs for hover & Phase 3 plotting
}

export interface AvailableVar {
  name: string;
  type: string;
}

export interface ProbeableLine {
  line: number;
  code: string;
}

export interface TraceParseResult {
  events: TraceEvent[];
  totalMatched: number;
  truncated: boolean;
}

export interface EventFilter {
  probeId?: string;
  text?: string;
}

export interface PerfProbeOptions {
  perfBin: string;
  vmlinuxPath: string;
  kernelDir: string;
  timeoutMs?: number;
}
