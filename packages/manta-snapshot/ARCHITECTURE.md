# manta-snapshot — Architecture

## Why this package exists

A Manta cast spawns headless `claude --print` clones. Each clone receives initial context as a snapshot file. This package owns the snapshot format end-to-end.

## Boundaries

- **In scope:** schema, capture, serialize, deserialize, distill, version migration.
- **Out of scope:** producing the actual transcript / open-file list (that's the orchestrator's job — this package just types it). Process spawning (manta-cli). Bus communication (manta-bus).

## Module map

| File | Responsibility |
|---|---|
| `schema.ts` | Zod schemas + inferred TS types. Pure data definition. |
| `capture.ts` | Build a Snapshot from a CaptureInput (caller-provided data). |
| `serialize.ts` | Validate + write JSON to disk. |
| `deserialize.ts` | Read + parse + version-migrate + validate. |
| `distill.ts` | Shrink message history + filter files for transmission. |
| `version.ts` | Schema version constant + migration registry. |
| `errors.ts` | Typed errors for narrowing failure modes. |
| `index.ts` | Public re-exports only. No logic. |

## Design choices

- **Validate at boundaries**: `serializeSnapshot` validates before write; `deserializeSnapshot` validates after read. This catches drift between in-process objects (which strict TS guards) and disk JSON (which has no compile-time guarantees).
- **Version field is required and integer**: any snapshot without a numeric `version` is rejected. Future versions are explicitly rejected (forward-incompatible reads are unsafe).
- **Migrations are explicit**: each version bump must register a migration. No "best-effort" reads of old data.
- **`mode` redundancy is enforced**: `snapshot.mode === snapshot.taskContract.mode` via zod refine. Single source of truth from caller's perspective; redundant on disk for human readability.
- **No filesystem in `capture.ts`**: caller provides all data. Keeps the function pure and testable without temp files.

## Test strategy

- Unit tests per module (`schema`, `capture`, `serialize`, `deserialize`, `distill`, `version`, `errors`).
- Round-trip integration test (`round-trip.test.ts`) — capture → serialize → deserialize → equality.
- Coverage threshold ≥ 80% on lines/functions/branches/statements (excluding `index.ts`).
