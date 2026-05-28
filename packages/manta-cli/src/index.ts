// Public surface for programmatic consumers (Phase 0e skill handlers, tests,
// future daemon). The bin entry (`src/bin/manta.ts`) is wiring only and is
// not re-exported from here.
export * from './errors.js';
export * from './runtime.js';
export * from './tick-loop.js';
export * from './spawner/worktree.js';
export * from './spawner/snapshot-builder.js';
export * from './spawner/clone-spawner.js';
export * from './output/status-table.js';
export * from './output/reporter.js';
export * from './commands/cast.js';
export * from './commands/status.js';
export * from './commands/kill.js';
export * from './commands/abort.js';
export * from './commands/recover.js';
export * from './commands/mcp-preflight.js';
export * from './library/mode-registry.js';
export * from './library/lockfile.js';
export * from './library/local-store.js';
export * from './library/dir-digest.js';
export * from './library/registry-client.js';
export * from './library/compat.js';
export * from './library/cli-version.js';
export * from './commands/install.js';
export * from './commands/uninstall.js';
