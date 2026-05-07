export const CURRENT_SCHEMA_VERSION = 1;

type MigrationFn = (data: unknown) => unknown;

const MIGRATIONS: Record<number, MigrationFn> = {
  // No migrations yet — version 1 is the initial schema.
  // Add entries when CURRENT_SCHEMA_VERSION bumps:
  // 1: (data) => migrateV1ToV2(data),
};

export function isSupportedVersion(v: number): boolean {
  return Number.isInteger(v) && v > 0 && v <= CURRENT_SCHEMA_VERSION;
}

export function migrate(data: unknown, fromVersion: number): unknown {
  if (fromVersion === CURRENT_SCHEMA_VERSION) {
    return data;
  }
  if (!isSupportedVersion(fromVersion)) {
    throw new Error(
      `Unsupported snapshot schema version: ${fromVersion} (current: ${CURRENT_SCHEMA_VERSION})`,
    );
  }
  /* v8 ignore start -- @preserve: forward-only loop, unreachable while CURRENT_SCHEMA_VERSION === 1; activates on v2 bump with registered migration */
  let current = data;
  let v = fromVersion;
  while (v < CURRENT_SCHEMA_VERSION) {
    const migration = MIGRATIONS[v];
    if (!migration) {
      throw new Error(`Missing migration from v${v} to v${v + 1}`);
    }
    current = migration(current);
    v += 1;
  }
  return current;
  /* v8 ignore stop */
}
