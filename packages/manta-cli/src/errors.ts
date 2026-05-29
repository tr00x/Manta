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
  | 'install_already_installed'
  // Phase 7b — `manta share` (schema-first widening per CLAUDE.md HARD RULE:
  // the kind set is widened before any share code references it).
  | 'share_cast_not_found'
  | 'share_no_winner'
  | 'share_secret_detected'
  | 'share_nothing_to_ship'
  | 'share_warnings_unaccepted'
  | 'share_author_missing'
  | 'share_license_missing'
  | 'share_publish_blocked';

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
