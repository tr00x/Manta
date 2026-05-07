export type CliErrorKind =
  | 'invalid_input'
  | 'cast_failed'
  | 'spawn_failed'
  | 'register_failed'
  | 'orchestrator_failed'
  | 'recovery_failed'
  | 'not_found';

export interface CliErrorOptions {
  kind: CliErrorKind;
  cause?: unknown;
  exitCode?: number;
}

export class CliError extends Error {
  readonly kind: CliErrorKind;
  readonly exitCode: number;
  constructor(message: string, options: CliErrorOptions) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'CliError';
    this.kind = options.kind;
    this.exitCode = options.exitCode ?? 1;
  }
}

export function isCliError(value: unknown): value is CliError {
  return value instanceof CliError;
}
