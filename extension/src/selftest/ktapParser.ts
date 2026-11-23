import { KtapEvent, KtapStatus } from './types';

export const KDEV_SELFTEST_BEGIN = '=== KDEV_SELFTEST_BEGIN ===';
const KDEV_SELFTEST_END_RE = /^=== KDEV_SELFTEST_END rc=(-?\d+) ===$/;
const SUITE_START_RE = /^#\s*selftests:\s*([^:\s]+):\s*(.+?)\s*$/;
const TEST_RESULT_RE = /^(\s*)(not ok|ok)\s+(\d+)(?:\s+-\s+|\s+)?(.*)$/;
const SELFTEST_DESC_RE = /^selftests:\s*([^:\s]+):\s*(.+?)\s*$/;
const CRASH_TRIGGER_RE =
  /(?:^|\s)(?:BUG:|Oops:|Kernel panic\b|Call Trace:|KASAN:|UBSAN:|general protection fault|Unable to handle kernel)/;

function parseDirective(rawDesc: string, isOk: boolean): {
  status: KtapStatus;
  description: string;
  reason?: string;
} {
  const hashIdx = rawDesc.indexOf('#');
  if (hashIdx < 0) {
    return {
      status: isOk ? 'pass' : 'fail',
      description: rawDesc.trim(),
    };
  }

  const description = rawDesc.slice(0, hashIdx).trim();
  const directiveRaw = rawDesc.slice(hashIdx + 1).trim();

  const skipMatch = directiveRaw.match(/^SKIP(?:\s+(.*))?$/i);
  if (skipMatch) {
    return {
      status: 'skip',
      description,
      reason: skipMatch[1]?.trim() || undefined,
    };
  }

  const xfailMatch = directiveRaw.match(/^XFAIL(?:\s+(.*))?$/i);
  if (xfailMatch) {
    return {
      status: 'xfail',
      description,
      reason: xfailMatch[1]?.trim() || undefined,
    };
  }

  const timeoutMatch = directiveRaw.match(/^TIMEOUT(?:\s+(.*))?$/i);
  if (timeoutMatch) {
    return {
      status: 'timeout',
      description,
      reason: timeoutMatch[1]?.trim() || 'Timeout',
    };
  }

  // Non-directive trailing comment
  return {
    status: isOk ? 'pass' : 'fail',
    description: rawDesc.trim(),
  };
}

/**
 * Streaming KTAP v1 parser for QEMU serial output.
 *
 * Isolates KTAP lines strictly between `=== KDEV_SELFTEST_BEGIN ===` and
 * `=== KDEV_SELFTEST_END rc=<n> ===`, while continuously monitoring all lines
 * for kernel crash signatures (`BUG:`, `Oops:`, `Kernel panic`, `Call Trace:`).
 */
export class KtapStreamParser {
  private buffer = '';
  private inSession = false;
  private recentLines: string[] = [];
  private crashReported = false;
  private crashExcerpt: string[] = [];

  public isInSession(): boolean {
    return this.inSession;
  }

  public feedChunk(chunk: string): KtapEvent[] {
    this.buffer += chunk;
    const events: KtapEvent[] = [];

    let newlineIdx = this.buffer.indexOf('\n');
    while (newlineIdx !== -1) {
      const rawLine = this.buffer.slice(0, newlineIdx).replace(/\r$/, '');
      this.buffer = this.buffer.slice(newlineIdx + 1);
      events.push(...this.feedLine(rawLine));
      newlineIdx = this.buffer.indexOf('\n');
    }

    return events;
  }

  public flush(): KtapEvent[] {
    if (!this.buffer) {
      return [];
    }
    const remaining = this.buffer.replace(/\r$/, '');
    this.buffer = '';
    return this.feedLine(remaining);
  }

  public feedLine(rawLine: string): KtapEvent[] {
    const events: KtapEvent[] = [];
    const trimmed = rawLine.trim();

    this.recentLines.push(rawLine);
    if (this.recentLines.length > 20) {
      this.recentLines.shift();
    }

    if (CRASH_TRIGGER_RE.test(rawLine)) {
      if (!this.crashReported) {
        this.crashReported = true;
        this.crashExcerpt = [...this.recentLines];
        events.push({
          type: 'kernelCrash',
          line: rawLine,
          excerpt: [...this.crashExcerpt],
        });
      } else if (this.crashExcerpt.length < 40) {
        this.crashExcerpt.push(rawLine);
      }
    } else if (this.crashReported && this.crashExcerpt.length < 40) {
      this.crashExcerpt.push(rawLine);
    }

    if (trimmed === KDEV_SELFTEST_BEGIN) {
      this.inSession = true;
      events.push({ type: 'begin', raw: rawLine });
      return events;
    }

    const endMatch = trimmed.match(KDEV_SELFTEST_END_RE);
    if (endMatch) {
      this.inSession = false;
      events.push({
        type: 'end',
        exitCode: Number.parseInt(endMatch[1], 10),
        raw: rawLine,
      });
      return events;
    }

    if (!this.inSession || !trimmed) {
      return events;
    }

    const suiteMatch = rawLine.match(SUITE_START_RE);
    if (suiteMatch) {
      events.push({
        type: 'suiteStart',
        target: suiteMatch[1],
        test: suiteMatch[2].trim(),
        raw: rawLine,
      });
      return events;
    }

    const resultMatch = rawLine.match(TEST_RESULT_RE);
    if (resultMatch) {
      const indent = resultMatch[1];
      const isOk = resultMatch[2] === 'ok';
      const index = Number.parseInt(resultMatch[3], 10);
      const rest = resultMatch[4] ?? '';
      const { status, description, reason } = parseDirective(rest, isOk);

      if (indent.length >= 2) {
        const depth = Math.max(1, Math.floor(indent.length / 4) || 1);
        events.push({
          type: 'subtestResult',
          depth,
          index,
          status,
          description,
          reason,
          raw: rawLine,
        });
      } else {
        const descMatch = description.match(SELFTEST_DESC_RE);
        events.push({
          type: 'testResult',
          index,
          status,
          description,
          reason,
          target: descMatch ? descMatch[1] : undefined,
          test: descMatch ? descMatch[2].trim() : undefined,
          raw: rawLine,
        });
      }
      return events;
    }

    if (trimmed.startsWith('#')) {
      events.push({
        type: 'diagnostic',
        message: trimmed.slice(1).trim(),
        raw: rawLine,
      });
    }

    return events;
  }
}
