# `ModeRegistry` — library-mode resolution seam

> **Audience:** Manta contributors touching the mode-dispatch surface. **Not a user doc** — for user-facing semantics see [`docs/user/manta-library.md`](../user/manta-library.md).

> **Code reference:** `packages/manta-cli/src/library/mode-registry.ts`.

## 1. Problem

Manta originally hard-coded the list of acceptable cast modes:

```ts
// packages/manta-cli/src/commands/cast.ts (historically)
const SUPPORTED_MODES = new Set<Mode>([
  'recon-swarm', 'forking-realities', 'bug-hunt',
  'refactor-wave', 'pair-programming', 'test-storm',
  'documentation-chase',
]);
if (!SUPPORTED_MODES.has(opts.mode)) throw …
```

A closed set was the right call early on. Every mode had a hand-written dispatcher (`pair-dispatch.ts`, `test-storm-dispatch.ts`, `doc-chase-dispatch.ts`) plus a hand-written priming preamble, and clarity beat flexibility while we were still discovering the right shapes. The runtime needed to know — at the point `runCastCommand` is invoked — which dispatcher branch to take and which priming text to inject.

The Manta Library flips the trade-off. Library packages need to register *new* cast modes without changing the CLI source. A package author shipping a "mega-refactor" mode should be able to `manta install @manta-library/refactor-megapack` and have `manta cast mega-refactor` Just Work, with the package having declared which built-in dispatcher to inherit from.

`SUPPORTED_MODES` blocks that. Mutating it from outside the file means either:

1. A mutable global — uncoordinated; horrible for tests.
2. A re-export with a parallel `LIBRARY_MODES` set — two sources of truth, predictable drift.
3. A registry seam — one entry point, sealed against shadow-registration.

Option 3 is `ModeRegistry`.

## 2. Solution

`ModeRegistry` is the one place Manta resolves whether a name is castable. It is constructed fresh per `runCastCommand` invocation, seeded with the seven built-in modes, then augmented by reading `manta-lock.json` and (for each lockfile entry with `contributes.modes[]`) loading the package's installed `manta-package.json` to discover each library mode's `basedOn`.

The seam surface:

```ts
class ModeRegistry {
  has(name: string): boolean;
  resolveLibrary(name: string): LibraryModeEntry | undefined;
  registerLibrary(entry: LibraryModeEntry): void;   // throws ModeConflictError on collision
  unregisterLibrary(name: string): void;
  list(): { builtins: Mode[]; library: LibraryModeEntry[] };
  snapshot(): ModeRegistrySnapshot;                 // immutable point-in-time view
}
```

Three properties matter for the contract:

- **`has` is the single mode-validity predicate.** No code path outside `mode-registry.ts` is allowed to consult `SUPPORTED_MODES` (now renamed `BUILTIN_MODES`) directly; doing so would re-introduce drift the seam exists to prevent.
- **Library entries are name-keyed.** Two library packages contributing the same library-mode name collide on `registerLibrary`, surfacing `ModeConflictError(code='mode_conflict_library')` whose message names the existing owner (`<packageName>@<packageVersion>`) and ends with "uninstall the other package first". The collision is raised when the registry is built at **cast time** (`loadModeRegistry`), not at install time — `manta install` does not register modes; its own "collision check" is a filesystem same-version guard (`LocalStoreError('collision')` → exit 15). `ModeConflictError` itself is currently uncaught at the CLI boundary (no dedicated exit code yet). The decision to hard-fail (rather than first-installed-wins) was made because predictability matters more than "convenience"; nobody wants two installs to behave differently based on install order.
- **Collisions with built-ins also hard-fail.** `registerLibrary({ name: 'recon-swarm', basedOn: 'recon-swarm', … })` throws `ModeConflictError(code='mode_conflict_builtin')`; library packages cannot shadow a built-in mode name.

`runCastCommand`'s preflight order is:

1. `cloneIds = await allocateCloneIds(...)` — happens after all input validators but before any state-committing call.
2. `modeRegistry = await loadModeRegistry(rt)` — read lockfile, register library modes.
3. `verifyMantaVersionCompat(lock, mantaCliVersion)` → exit 16 on mismatch.
4. `verifyLibraryIntegrity(lock, rt.localStore)` → exit 19 on hash drift.
5. `if (!modeRegistry.has(opts.mode)) throw 'mode "..." is not supported'`.

The intra-step order between compat and integrity is the only one that's a hard commitment: a tampered-AND-compat-broken install should surface the actionable upgrade message first, not the tamper alarm.

## 3. `basedOn` semantics

A library mode does not ship its own dispatcher. It parameterises a built-in dispatcher named by `basedOn`:

```jsonc
// manta-package.json — contributes.modes[] is validated by ModeContributionSchema (.strict())
{
  "contributes": {
    "modes": [
      {
        "name": "mega-refactor",
        "description": "Refactor across a monorepo with reviewer veto.",
        "basedOn": "refactor-wave",        // ← host dispatcher (enum over the 7 built-ins)
        "cloneCount": { "min": 2, "max": 4 },
        "sessionMode": "batch",
        "capabilityProfile": "refactor",   // optional: named capability profile
        "templates": []                     // optional: template names, defaults to []
      }
    ]
  }
}
```

> The `contributes.modes[]` entry shape is `ModeContributionSchema`
> (`packages/manta-skill-validator/src/manifest-schema.ts`): `name`,
> `description`, `basedOn`, `cloneCount`, `sessionMode`, optional
> `capabilityProfile`, and `templates`. There is **no** `primingBlock` here —
> that field lives only in `LibraryModeJsonSchema`, the standalone
> `modes/<name>.json` shape used by share bundles, and is not propagated into
> the contributes manifest.

At cast time, `runCastCommand` resolves the library mode through the registry:

```ts
const libraryEntry = modeRegistry.resolveLibrary(opts.mode);
if (libraryEntry) {
  opts.reporter.info('cast.library_mode_resolved', {
    libraryMode: opts.mode,
    basedOn: libraryEntry.basedOn,
    packageName: libraryEntry.packageName,
    packageVersion: libraryEntry.packageVersion,
  });
  opts = { ...opts, mode: libraryEntry.basedOn };
}
```

From here on the function behaves as if the operator typed `manta cast <basedOn> …` directly. The dispatcher selector (`if (opts.mode === 'pair-programming') …`) consults the **rewritten** `opts.mode`; the cast manifest records the host dispatcher in `mode:` (so historical tooling that pivots on `mode` still works); the library origin is captured **only** via the reporter event `cast.library_mode_resolved` (payload: `libraryMode`, `basedOn`, `packageName`, `packageVersion`). The cast manifest itself carries no library-origin fields — see §5.

**Threat model.** `basedOn` is a strict enum over the seven built-ins. Anything outside that enum is a schema error at validate-package time. Library packages therefore **cannot ship arbitrary JavaScript that drives a cast**. The worst a malicious library package can do is run a built-in dispatcher with a misleading priming preamble — the dispatcher itself is the same code that ran for `manta cast recon-swarm`. This is the explicit reason hooks (`contributes.hooks[]`) are not yet distributable: hooks *do* execute arbitrary code and need a different security review.

## 4. Why not a richer registry now?

Early design research sketched a richer `ModeDefinition`:

```ts
interface ModeDefinition {
  name: string;
  builtin: boolean;
  createDispatcher(ctx: DispatchContext): Dispatcher;
  primingBlock(opts: PrimingOpts): string;
  invariants: ModeInvariant[];
  // …
}
```

That shape lets library packages plug in their own `createDispatcher` and become first-class citizens — no "host dispatcher" indirection, no `basedOn` enum. **We deliberately did not ship it.** Three reasons:

1. **YAGNI.** Every library mode in the current target ecosystem (refactor variants, recon variants, doc-chase variants) is satisfied by parameterising a built-in dispatcher. The richer factory pattern earns its complexity only when library modes need to *override* dispatcher behaviour, and we have not seen a real package that needs that yet.
2. **Threat model containment.** A `createDispatcher` plugin is, by definition, arbitrary code. Shipping it requires the same sandboxing review that gates hooks distribution. Deferring `createDispatcher` until after that sandbox lands is the lowest-risk path.
3. **Cheap upgrade.** Adding `createDispatcher` later does *not* break the current `basedOn` contract. Existing library packages can keep declaring `basedOn` indefinitely; the new shape is a new optional field. The seam is forward-compatible by construction.

If/when `createDispatcher` is needed, the migration is: widen `LibraryModeEntry`, widen the manifest schema, widen `registerLibrary`, and add an `instantiateDispatcher(libraryMode)` factory call-site adjacent to the existing `basedOn` rewrite in `cast.ts`. No code outside `mode-registry.ts` + `cast.ts` + the manifest schema needs to change.

## 5. Where the library origin is recorded

The cast manifest (`CastManifestSchema`, `.strict()`) records the **host dispatcher only**, in its `mode` field. It has **no** library-origin field. The full shape is:

```jsonc
// .manta/state/casts/<cast-id>.json — CastManifestSchema
{
  "version": 1,
  "cast_id": "cast-<timestamp>",
  "mode": "refactor-wave",        // ← host dispatcher (basedOn); the library name is NOT here
  "clones": [ … ],
  "policy": { … },
  "created_at": 1730000000000,
  "metadata": { "trigger": …, "cause_chain": [] }   // optional; no library fields
}
```

`cast.ts` computes a `libraryModeName` local but **deliberately discards it**
(`void libraryModeName;`) — recording it on the manifest is deferred work (§6).
The library origin is captured **only** via the reporter event, which lands in
`events.jsonl` through the forensic timeline:

```jsonc
// reporter event: cast.library_mode_resolved
{
  "libraryMode": "mega-refactor",                 // the name the operator typed
  "basedOn": "refactor-wave",                      // resolved host dispatcher
  "packageName": "@manta-library/refactor-megapack",
  "packageVersion": "1.3.0"
}
```

Consequences of the current shape:

- **Post-mortem replay** can recover the library origin from the
  `cast.library_mode_resolved` event in `events.jsonl`, but **not** from the
  manifest — manifest-only tooling sees the host dispatcher (`mode`) and nothing
  about the contributing package.
- **Share bundles.** The bundle's `CastOrigin` (`cast-origin-schema.ts`) records
  `castMode` (the host-dispatcher value, one of the ten `Mode` literals) and
  `winningCloneId` — **not** a library-mode field. A shared library *package*
  still carries its modes through the bundle's `contributes.modes[]` (read from
  `modes/<name>.json`), but the per-cast origin record does not name the library
  mode that ran.
- **Audit.** "Which library packages did we cast against this quarter?" must
  today be reconstructed from `cast.library_mode_resolved` events, not from
  manifests.

Promoting the library origin onto the manifest (`libraryMode` /
`libraryBasedOn` + package coordinates) is tracked as future work in §6.

## 6. Future work pointers

Where to extend when richer semantics arrive:

- **`createDispatcher` / `primingBlock` plugin shape** — extend `LibraryModeEntry` and the manifest schema; widen `registerLibrary`; add an `instantiateDispatcher(libraryMode, basedOn)` factory adjacent to the existing rewrite in `cast.ts`. Depends on the hook-sandbox design.
- **Multi-version coexistence** — the global index allows multiple installed versions of the same package, but only the one resolved through the lockfile contributes to the registry. If two repos under the same homedir need to cast different versions of the same library mode, that already works (each repo has its own lockfile). If one repo needs to cast both versions simultaneously, that needs a name-disambiguation extension (`@manta-library/refactor-megapack@1.3.0/mega-refactor`); deliberately out of scope until a real user asks.
- **Library origin on the manifest** — add `libraryMode` / `libraryBasedOn` (plus package coordinates) to `CastManifestSchema` and write them in `cast.ts`, replacing the current `void libraryModeName;` discard (§5). This makes manifest-only tooling — post-mortem replay, audit, share — library-origin-aware without parsing `events.jsonl`.
- **Per-mode invariants and capability gating** — the snapshot/registry pair is the right place to attach mode-specific guards (e.g. "this library mode requires `forking-realities` style worktree isolation"). Future capability-gated modes will need this; the natural home is a future `LibraryModeEntry.invariants?: ModeInvariant[]` field (not present on `LibraryModeEntry` today — it currently holds only `name`, `basedOn`, `packageName`, `packageVersion`).
- **`manta library search`** — a directory of library packages curated outside the npm registry. Independent of the registry seam; it consumes the same `MantaPackageManifestSchema` but its discovery surface is separate future work.

## Related reading

- User-facing semantics: [`docs/user/manta-library.md`](../user/manta-library.md).
- Hash-pin verification (sibling preflight): `packages/manta-cli/src/library/integrity.ts`.
- Compat preflight: `packages/manta-cli/src/library/compat.ts`.
- Built-in dispatchers: `packages/manta-cli/src/dispatch/*.ts`.
