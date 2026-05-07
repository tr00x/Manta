export function log(scope: string, message: string): void {
  // eslint-disable-next-line no-console -- Reason: fixture is a fake repo whose code legitimately emits logs; not production code.
  console.log(`[${scope}] ${message}`);
}
