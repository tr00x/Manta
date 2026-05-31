# Cast manifest

Every Manta cast — regardless of mode — leaves a single per-cast record on
disk. This is the **cast manifest**. It captures the immutable cast-level
state at spawn time: the cast's mode, its roster of clone_ids, and its
policy (peer messaging allowed or denied, auto-merge threshold).

## Where it lives

```
<repo>/.manta/state/casts/<castId>.json
```

The directory is created lazily on the first cast. Each cast has exactly one
file; the filename is the cast_id with a `.json` suffix.

## Schema

The wire shape is defined in `packages/manta-bus/src/schema.ts` under
`CastManifestSchema`. Excerpt:

```jsonc
{
  "version": 1,
  "cast_id": "cast-1700000000000",
  "mode": "recon-swarm",        // or "forking-realities", "refactor-wave", ...
  "clones": [
    { "clone_id": "A", "assignment": null },
    { "clone_id": "B", "assignment": null }
  ],
  "policy": {
    "peer_messaging": "allowed",     // "allowed" | "denied"
    "auto_merge_threshold": null      // null (manual review) | number in [0,1]
  },
  "created_at": 1700000000000        // ms epoch from systemClock
}
```

For a `forking-realities` cast, each clone's `assignment` carries its
per-clone task / approach hint / scope / budget overlay.

## Idempotency

`CastsStore.create` is **idempotent on identical input**:

* Re-create with the *same* manifest content (mode, roster, policy) returns
  the existing manifest unchanged. Crucially, the original `created_at` is
  preserved — clock skew between spawn attempts cannot leak into the record.
* Re-create with *different* content (different mode, roster, or policy)
  raises `BusConflictError`. There is no silent overwrite.

This is why the spawner calls `casts.create` for *every* clone of a cast —
the first call writes the manifest, and subsequent calls are no-ops. There
is no "first-clone-special" branch, and the manifest still lands even if
clone-A fails to spawn (clone-B's call covers it).

## Who reads it

* **Bus filter** — joins on `cast_mode` from the registry plus
  `policy.peer_messaging` from the manifest to decide whether a sibling
  `manta.message` is delivered.
* **Orchestrator** — uses the roster to know when a cast is
  finalised (every clone in the roster is `DEAD` or has shipped a
  `report_death`).
* **CLI replay / audit** — `manta replay <castId>` and audit
  tooling read the manifest to reconstruct what was spawned.

## Operator notes

* **Safe to reload.** First writer wins; identical re-write is a no-op;
  conflicting re-write is a hard error. There is no "best-effort merge."
* **Inspect a cast** — `cat .manta/state/casts/<castId>.json | jq .`
  shows the full record.
* **Lifecycle.** The manifest persists after the cast completes. It is not
  rotated or archived automatically; retention is managed manually.
