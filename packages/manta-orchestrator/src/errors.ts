// 'cycle_failed' is what runCycle currently emits. The other three are reserved
// for Phase 0d when per-phase try/catch granularity is added — keep them in the
// union so the type surface is stable across phase upgrades.
export type OrchestratorErrorKind =
  | 'cycle_failed'
  | 'post_mortem_failed'
  | 'death_detect_failed'
  | 'reap_failed';

export class OrchestratorError extends Error {
  readonly kind: OrchestratorErrorKind;
  constructor(message: string, options: { kind: OrchestratorErrorKind; cause?: unknown }) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'OrchestratorError';
    this.kind = options.kind;
  }
}

export function isOrchestratorError(value: unknown): value is OrchestratorError {
  return value instanceof OrchestratorError;
}
