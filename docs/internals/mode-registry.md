# `ModeRegistry` — library-mode resolution seam

> **Audience:** Manta contributors writing Phase 7b/7c/8 plans, and any future plan-author touching the mode-dispatch surface. **Not a user doc** — for user-facing semantics see [`docs/user/manta-library.md`](../user/manta-library.md).

> **Code reference:** `packages/manta-cli/src/library/mode-registry.ts`.

## 1. Problem

Manta 0.0–0.6 hard-coded the list of acceptable cast modes:

```ts
// packages/manta-cli/src/commands/cast.ts (pre-Phase-7a)
const SUPPORTED_MODES = new Set<Mode>([
  'recon-swarm', 'forking-realities', 'bug-hunt',
  'refactor-wave', 'pair-programming', 'test-storm',
  'documentation-chase',
]);
if (!SUPPORTED_MODES.has(opts.mode)) throw …
```

A closed set was the right call for Phase 0–6. Every mode had a hand-written dispatcher (`pair-dispatch.ts`, `test-storm-dispatch.ts`, `doc-chase-dispatch.ts`) plus a hand-written priming preamble, and clarity beat flexibility while we were still discovering the right shapes. The runtime needed to know — at the point `runCastCommand` is invoked — which dispatcher branch to take and which priming text to inject.

Phase 7a flips the trade-off. Library packages need to register *new* cast modes without changing the CLI source. A package author shipping a "mega-refactor" mode should be able to `manta install @manta-library/refactor-megapack` and have `manta cast mega-refactor` Just Work, with the package having declared which built-in dispatcher to inherit from.

`SUPPORTED_MODES` blocks that. Mutating it from outside the file means either:

1. A mutable global — uncoordinated; horrible for tests.
2. A re-export with a parallel `LIBRARY_MODES` set — two sources of truth, predictable drift.
3. A registry seam — one entry point, sealed against shadow-registration.

Option 3 is `ModeRegistry`.

## 2. Solution

`ModeRegistry` is the one place Manta resolves whether a name is castable. It is constructed fresh per `runCastCommand` invocation, seeded with the seven Phase 0 built-ins, then augmented by reading `manta-lock.json` and (for each lockfile entry with `contributes.modes[]`) loading the package's installed `manta-package.json` to discover each library mode's `basedOn`.

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
- **Library entries are name-keyed.** Two library packages contributing the same library-mode name collide on `registerLibrary`, surfacing `ModeConflictError(code='mode_conflict_library')` with the existing owner's package name; `manta install` translates that into exit 14 and a "uninstall the other package first" hint. The decision to hard-fail (rather than first-installed-wins) was made because predictability matters more than "convenience"; nobody wants two installs to behave differently based on install order.
- **Collisions with built-ins also hard-fail.** `registerLibrary({ name: 'recon-swarm', basedOn: 'recon-swarm', … })` throws `ModeConflictError(code='mode_conflict_builtin')`; library packages cannot shadow a built-in mode name.

`runCastCommand`'s preflight order is:

1. `cloneIds = await allocateCloneIds(...)` — bug #19 fix; happens after all input validators but before any state-committing call.
2. `modeRegistry = await loadModeRegistry(rt)` — read lockfile, register library modes.
3. `verifyMantaVersionCompat(lock, mantaCliVersion)` → exit 16 on mismatch.
4. `verifyLibraryIntegrity(lock, rt.localStore)` → exit 19 on hash drift.
5. `if (!modeRegistry.has(opts.mode)) throw 'mode "..." is not supported'`.

The intra-step order between compat and integrity is the only one that's a *reviewer must-fix* commitment: a tampered-AND-compat-broken install should surface the actionable upgrade message first, not the tamper alarm.

## 3. `basedOn` semantics

A library mode does not ship its own dispatcher. It parameterises a built-in dispatcher named by `basedOn`:

```jsonc
// manta-package.json
{
  "contributes": {
    "modes": [
      {
        "name": "mega-refactor",
        "description": "Refactor across a monorepo with reviewer veto.",
        "basedOn": "refactor-wave",        // ← host dispatcher
        "cloneCount": { "min": 2, "max": 4 },
        "sessionMode": "batch",
        "primingBlock": "…"                 // optional extra text appended to spawn priming
      }
    ]
  }
}
```

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

From here on the function behaves as if the operator typed `manta cast <basedOn> …` directly. The dispatcher selector (`if (opts.mode === 'pair-programming') …`) consults the **rewritten** `opts.mode`; the cast manifest records the host dispatcher in `mode:` (so historical tooling that pivots on `mode` still works); the library origin is captured via the reporter event and (in the cast manifest) via the optional `libraryMode` / `libraryBasedOn` fields.

**Threat model.** `basedOn` is a strict enum over the seven built-ins. Anything outside that enum is a schema error at validate-package time (Phase 7a Task 1.1). Library packages therefore **cannot ship arbitrary JavaScript that drives a cast**. The worst a malicious library package can do is run a built-in dispatcher with a misleading priming preamble — the dispatcher itself is the same code that ran for `manta cast recon-swarm`. This is the explicit reason hooks (`contributes.hooks[]`) are deferred to Phase 8: hooks *do* execute arbitrary code and need a different security review.

## 4. Why not a richer registry now?

The Phase 7a research (clone-C §4.4) sketched a richer `ModeDefinition`:

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

That shape lets library packages plug in their own `createDispatcher` and become first-class citizens — no "host dispatcher" indirection, no `basedOn` enum. **We deliberately did not ship it in Phase 7a.** Three reasons:

1. **YAGNI.** Every library mode in the Phase 7a-targeted ecosystem (refactor variants, recon variants, doc-chase variants) is satisfied by parameterising a built-in dispatcher. The richer factory pattern earns its complexity only when library modes need to *override* dispatcher behaviour, and we have not seen a real package that needs that yet.
2. **Threat model containment.** A `createDispatcher` plugin is, by definition, arbitrary code. Shipping it requires the same sandboxing review that gates hooks distribution — which is Phase 8 work. Deferring `createDispatcher` until after Phase 8's sandbox lands is the lowest-risk path.
3. **Cheap upgrade.** Adding `createDispatcher` later does *not* break the current `basedOn` contract. Existing library packages can keep declaring `basedOn` indefinitely; the new shape is a new optional field. The seam is forward-compatible by construction.

If/when Phase 7c or Phase 8 needs `createDispatcher`, the migration is: widen `LibraryModeEntry`, widen the manifest schema, widen `registerLibrary`, and add an `instantiateDispatcher(libraryMode)` factory call-site adjacent to the existing `basedOn` rewrite in `cast.ts`. No code outside `mode-registry.ts` + `cast.ts` + the manifest schema needs to change.

## 5. Cast-manifest dual recording

Both layers — built-in host and library origin — matter for post-mortems, share bundles, and audit. The cast manifest therefore records both:

```jsonc
// .manta/state/casts/<cast-id>.json (sketch)
{
  "cast_id": "cast-1779997703425",
  "mode": "refactor-wave",                    // ← host dispatcher (basedOn)
  "libraryMode": "mega-refactor",             // ← library origin (optional)
  "libraryPackage": "@manta-library/refactor-megapack",
  "libraryPackageVersion": "1.3.0",
  "clones": [ … ],
  "policy": { … }
}
```

Why both?

- **Post-mortem replay.** A future operator reading the post-mortem needs to know which dispatcher ran (to interpret the events) *and* which library package contributed the mode (to reproduce the cast on a different machine).
- **Share bundles (Phase 7b).** `manta share <cast-id>` will include `libraryMode` so the recipient's `manta share install` knows which package to look for. Without the dual recording, the share bundle can only point at a built-in dispatcher and the library origin is lost.
- **Audit + compliance.** "Which library packages did we cast against this quarter?" is a legitimate question and shouldn't require reconstructing intent from the priming preamble.

The reporter event `cast.library_mode_resolved` is the in-flight (during-cast) shape of the same information, captured into `events.jsonl` via the forensic timeline. Bus consumers (`manta tail`, `manta status`) read it directly without parsing the manifest.

## 6. Future work pointers

Where to extend when richer semantics arrive:

- **`createDispatcher` / `primingBlock` plugin shape** — extend `LibraryModeEntry` and the manifest schema; widen `registerLibrary`; add an `instantiateDispatcher(libraryMode, basedOn)` factory adjacent to the existing rewrite in `cast.ts`. Phase 8 work; depends on hook-sandbox design.
- **Multi-version coexistence** — Phase 7a's index allows multiple installed versions of the same package, but only the one resolved through the lockfile contributes to the registry. If two repos under the same homedir need to cast different versions of the same library mode, that already works (each repo has its own lockfile). If one repo needs to cast both versions simultaneously, that needs a name-disambiguation extension (`@manta-library/refactor-megapack@1.3.0/mega-refactor`); deliberately out of scope until a real user asks.
- **Per-mode invariants and capability gating** — the snapshot/registry pair is the right place to attach mode-specific guards (e.g. "this library mode requires `forking-realities` style worktree isolation"). Phase 8 + `aghs-unlocked` modes will need this; the field already has a home (`LibraryModeEntry.invariants?: ModeInvariant[]`).
- **`manta library search` (Phase 8)** — a directory of library packages curated outside the npm registry. Independent of the registry seam; it consumes the same `MantaPackageManifestSchema` but its discovery surface is a Phase 8 plan.

## Related reading

- User-facing semantics: [`docs/user/manta-library.md`](../user/manta-library.md).
- Phase 7a plan + reviewer must-fix log: [`docs/superpowers/plans/2026-05-28-phase-7a-manta-library.md`](../superpowers/plans/2026-05-28-phase-7a-manta-library.md).
- Hash-pin verification (sibling preflight): `packages/manta-cli/src/library/integrity.ts`.
- Compat preflight: `packages/manta-cli/src/library/compat.ts`.
- Built-in dispatchers: `packages/manta-cli/src/dispatch/*.ts`.
