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
