import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  EventFilter,
  KprobeSpec,
  ProbesFileSchema,
  TraceEvent,
  TraceParseResult,
} from './types';

export interface DisposableLike {
  dispose(): void;
}

export class ProbeStore {
  private readonly emitter = new EventEmitter();
  private probes: KprobeSpec[] = [];
  private nextSeq = 1;
  private events: TraceEvent[] = [];
  private selectedEventIndex: number | null = null;
  private eventFilter: EventFilter = {};
  private traceTruncated = false;
  private totalTraceCount = 0;

  constructor(private readonly probesJsonPath: string) {}

  public getProbesJsonPath(): string {
    return this.probesJsonPath;
  }

  public onDidChangeProbes(listener: (probes: KprobeSpec[]) => void): DisposableLike {
    this.emitter.on('probesChanged', listener);
    return {
      dispose: () => {
        this.emitter.off('probesChanged', listener);
      },
    };
  }

  public onDidChangeEvents(listener: (events: TraceEvent[]) => void): DisposableLike {
    this.emitter.on('eventsChanged', listener);
    return {
      dispose: () => {
        this.emitter.off('eventsChanged', listener);
      },
    };
  }

  public onDidSelectEvent(listener: (index: number | null) => void): DisposableLike {
    this.emitter.on('eventSelected', listener);
    return {
      dispose: () => {
        this.emitter.off('eventSelected', listener);
      },
    };
  }

  public load(): KprobeSpec[] {
    if (!fs.existsSync(this.probesJsonPath)) {
      this.probes = [];
      this.nextSeq = 1;
      this.emitProbesChanged();
      return this.getProbes();
    }

    const raw = fs.readFileSync(this.probesJsonPath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<ProbesFileSchema>;
    if (parsed.version !== 1 || !Array.isArray(parsed.probes)) {
      throw new Error(`Invalid probes.json schema at ${this.probesJsonPath}`);
    }

    this.probes = parsed.probes.map((p) => ({ ...p }));
    this.nextSeq =
      typeof parsed.nextSeq === 'number' && parsed.nextSeq >= 1
        ? parsed.nextSeq
        : this.computeNextSeq();
    this.emitProbesChanged();
    return this.getProbes();
  }

  public save(): void {
    const schema: ProbesFileSchema = {
      version: 1,
      nextSeq: this.nextSeq,
      probes: this.probes,
    };
    fs.mkdirSync(path.dirname(this.probesJsonPath), { recursive: true });
    fs.writeFileSync(this.probesJsonPath, `${JSON.stringify(schema, null, 2)}\n`, 'utf-8');
  }

  public allocateNextProbeId(): string {
    const existing = new Set(this.probes.map((p) => p.id));
    while (existing.has(`p${this.nextSeq}`)) {
      this.nextSeq += 1;
    }
    const id = `p${this.nextSeq}`;
    this.nextSeq += 1;
    return id;
  }

  public getProbes(): KprobeSpec[] {
    return this.probes.map((p) => ({ ...p }));
  }

  public getProbeById(id: string): KprobeSpec | undefined {
    const found = this.probes.find((p) => p.id === id);
    return found ? { ...found } : undefined;
  }

  public getProbesForFile(fileRel: string): KprobeSpec[] {
    return this.probes.filter((p) => p.file === fileRel).map((p) => ({ ...p }));
  }

  public getProbesAtLine(fileRel: string, line: number): KprobeSpec[] {
    return this.probes
      .filter((p) => p.file === fileRel && p.line === line)
      .map((p) => ({ ...p }));
  }

  public addProbe(probe: KprobeSpec): KprobeSpec {
    const copy = { ...probe };
    this.probes.push(copy);
    this.emitProbesChanged();
    return { ...copy };
  }

  public updateProbe(id: string, updater: (probe: KprobeSpec) => KprobeSpec): KprobeSpec | undefined {
    const idx = this.probes.findIndex((p) => p.id === id);
    if (idx === -1) {
      return undefined;
    }
    const updated = { ...updater({ ...this.probes[idx] }) };
    this.probes[idx] = updated;
    this.emitProbesChanged();
    return { ...updated };
  }

  public toggleProbe(id: string): KprobeSpec | undefined {
    return this.updateProbe(id, (p) => ({ ...p, enabled: !p.enabled }));
  }

  public removeProbe(id: string): boolean {
    const before = this.probes.length;
    this.probes = this.probes.filter((p) => p.id !== id);
    if (this.probes.length !== before) {
      this.emitProbesChanged();
      return true;
    }
    return false;
  }

  public clearProbes(): void {
    this.probes = [];
    this.emitProbesChanged();
  }

  /**
   * Mark probes whose recorded `vmlinuxMtimeMs` differs from `currentVmlinuxMtimeMs` as stale.
   * Returns the number of probes transitioned to `stale`.
   */
  public checkStaleness(currentVmlinuxMtimeMs: number): number {
    let transitioned = 0;
    for (const probe of this.probes) {
      if (
        probe.status !== 'stale' &&
        Math.abs(probe.vmlinuxMtimeMs - currentVmlinuxMtimeMs) > 0.5
      ) {
        probe.status = 'stale';
        transitioned += 1;
      }
    }
    if (transitioned > 0) {
      this.emitProbesChanged();
    }
    return transitioned;
  }

  /**
   * Shift probe line numbers in memory when lines are inserted/deleted in an open C file.
   * `changeStartLine` is 1-based; `lineDelta` is positive for insertions, negative for deletions.
   */
  public adjustLinesForDocumentEdit(
    fileRel: string,
    changeStartLine: number,
    lineDelta: number
  ): boolean {
    if (lineDelta === 0) {
      return false;
    }

    let changed = false;
    for (const probe of this.probes) {
      if (probe.file !== fileRel) {
        continue;
      }
      if (probe.line > changeStartLine) {
        const nextLine = Math.max(1, probe.line + lineDelta);
        if (nextLine !== probe.line || probe.status !== 'stale') {
          probe.line = nextLine;
          probe.status = 'stale';
          changed = true;
        }
      }
    }

    if (changed) {
      this.emitProbesChanged();
    }
    return changed;
  }

  public setEvents(result: TraceParseResult): void {
    this.events = result.events.map((e) => ({ ...e, argsMap: { ...e.argsMap } }));
    this.totalTraceCount = result.totalMatched;
    this.traceTruncated = result.truncated;

    if (
      this.selectedEventIndex !== null &&
      !this.events.some((e) => e.index === this.selectedEventIndex)
    ) {
      this.selectedEventIndex = null;
      this.emitter.emit('eventSelected', null);
    }

    this.emitEventsChanged();
  }

  public getEvents(): TraceEvent[] {
    return this.events;
  }

  public isTraceTruncated(): boolean {
    return this.traceTruncated;
  }

  public getTotalTraceCount(): number {
    return this.totalTraceCount;
  }

  public getEventFilter(): EventFilter {
    return { ...this.eventFilter };
  }

  public setEventFilter(filter: EventFilter): void {
    this.eventFilter = {
      probeId: filter.probeId?.trim() || undefined,
      text: filter.text?.trim() || undefined,
    };
    this.emitEventsChanged();
  }

  public getFilteredEvents(): TraceEvent[] {
    const { probeId, text } = this.eventFilter;
    if (!probeId && !text) {
      return this.events;
    }

    const needle = text?.toLowerCase();
    return this.events.filter((ev) => {
      if (probeId && ev.probeId !== probeId && ev.eventName !== probeId) {
        return false;
      }
      if (needle) {
        const haystack =
          `${ev.task}-${ev.pid} ${ev.eventName} ${ev.symbol} ${ev.argsText}`.toLowerCase();
        if (!haystack.includes(needle)) {
          return false;
        }
      }
      return true;
    });
  }

  public getEventsForProbe(probeId: string): TraceEvent[] {
    return this.events.filter((e) => e.probeId === probeId);
  }

  public getHitCount(probeId: string): number {
    let count = 0;
    for (const ev of this.events) {
      if (ev.probeId === probeId) {
        count += 1;
      }
    }
    return count;
  }

  public selectEvent(index: number | null): void {
    if (this.selectedEventIndex === index) {
      return;
    }
    this.selectedEventIndex = index;
    this.emitter.emit('eventSelected', index);
  }

  public getSelectedEventIndex(): number | null {
    return this.selectedEventIndex;
  }

  public getSelectedEvent(): TraceEvent | undefined {
    if (this.selectedEventIndex === null) {
      return undefined;
    }
    return this.events.find((e) => e.index === this.selectedEventIndex);
  }

  private computeNextSeq(): number {
    let maxSeq = 0;
    for (const p of this.probes) {
      const m = p.id.match(/^p(\d+)$/);
      if (m) {
        maxSeq = Math.max(maxSeq, Number.parseInt(m[1], 10));
      }
    }
    return maxSeq + 1;
  }

  private emitProbesChanged(): void {
    this.emitter.emit('probesChanged', this.getProbes());
  }

  private emitEventsChanged(): void {
    this.emitter.emit('eventsChanged', this.events);
  }
}
