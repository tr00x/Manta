export type LogLevel = 'info' | 'warn' | 'error';

export interface LogLine {
  level: LogLevel;
  event: string;
  payload: Record<string, unknown>;
  rendered: string;
  ts: number;
}

export interface ReporterSink {
  write(line: LogLine): void;
}

export class MemorySink implements ReporterSink {
  readonly lines: LogLine[] = [];
  write(line: LogLine): void {
    this.lines.push(line);
  }
}

export class StderrSink implements ReporterSink {
  write(line: LogLine): void {
    process.stderr.write(line.rendered + '\n');
  }
}

export interface CreateReporterOptions {
  sink: ReporterSink;
  now?: () => number;
}

export interface Reporter {
  info(event: string, payload?: Record<string, unknown>): void;
  warn(event: string, payload?: Record<string, unknown>): void;
  error(event: string, payload?: Record<string, unknown>): void;
}

function render(level: LogLevel, event: string, payload: Record<string, unknown>): string {
  const parts = Object.entries(payload).map(([k, v]) => `${k}=${formatVal(v)}`);
  return `[${level}] ${event} ${parts.join(' ')}`.trimEnd();
}

function formatVal(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

export function createReporter(opts: CreateReporterOptions): Reporter {
  const now = opts.now ?? (() => Date.now());
  function emit(level: LogLevel, event: string, payload?: Record<string, unknown>): void {
    const p = payload ?? {};
    opts.sink.write({ level, event, payload: p, rendered: render(level, event, p), ts: now() });
  }
  return {
    info: (e, p) => emit('info', e, p),
    warn: (e, p) => emit('warn', e, p),
    error: (e, p) => emit('error', e, p),
  };
}
