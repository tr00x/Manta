export type CliErrorKind =
  | 'invalid_input'
  | 'cast_failed'
  | 'spawn_failed'
  | 'register_failed'
  | 'orchestrator_failed'
  | 'recovery_failed'
  | 'not_found'
  | 'budget_gate_failed'
  | 'daemon_failed'
  | 'retask_failed'
  | 'feedback_failed'
  | 'concurrent_cast_limit_reached'
  | 'install_spec_parse_failed'
  | 'install_network_failed'
  | 'install_manifest_invalid'
  | 'install_validation_failed'
  | 'install_compat_unmet'
  | 'install_already_installed';

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
