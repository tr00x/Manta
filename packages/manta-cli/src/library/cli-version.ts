/**
 * The Manta CLI version reported by the `manta` binary and consumed by the
 * library install + cast preflight paths. Single source of truth — mirrored
 * to `packages/manta-cli/package.json#version` at release time.
 *
 * When the version in package.json changes, update this constant in the same
 * commit so library install + cast compat checks reflect reality.
 */
export const MANTA_CLI_VERSION = '0.1.0';

export function getMantaCliVersion(): string {
  return MANTA_CLI_VERSION;
}
