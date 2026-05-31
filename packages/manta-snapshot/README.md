# @manta/snapshot

Versioned, validated state + transcript serializer for Manta clones.

## Install

Internal package in the Manta monorepo. Other packages depend on it via `workspace:*`.

## Usage

```typescript
import { captureState, serializeSnapshot, deserializeSnapshot } from '@manta/snapshot';

const snap = captureState({ /* ... */ });
await serializeSnapshot(snap, '/tmp/snap.json');
const restored = await deserializeSnapshot('/tmp/snap.json');
```

## API

- `captureState(input: CaptureInput): Snapshot` — build a snapshot from current state. Pure.
- `serializeSnapshot(snap, path)` — validate and write JSON to disk.
- `deserializeSnapshot(path): Promise<Snapshot>` — read, version-check, validate, return.
- `distillContext(input)` — shrink messages + openFiles for transmittable subset.

## Errors

- `SnapshotValidationError` — schema validation failed (carries `issues: ZodIssue[]`).
- `SnapshotIOError` — filesystem / JSON parse failure (carries `cause`).
- `SnapshotVersionError` — file version not supported by this build.

## Schema versioning

Version constant: `CURRENT_SCHEMA_VERSION` (currently 1). Migration table in `src/version.ts`. When bumping, add a migration entry; old snapshots remain readable for at least 2 release cycles.
