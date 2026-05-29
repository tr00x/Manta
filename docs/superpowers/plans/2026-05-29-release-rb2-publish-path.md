# RB2 — `npx manta@latest install` publish / distribution path

**Status:** Approved — plan-review applied 2026-05-29 (`docs/plan-reviews/2026-05-29-rb2-publish-path-review.md`): all 5 MUST-FIX (M1 version-in-3-places, M2 bug-#53 hard-prereq, M3 e2e rename consumers, M4 preflight path string, M5 tsconfig ref) + 3 SHOULD-FIX + A1 (skills/repo precondition → D5) folded in. Sibling of RB1 (`2026-05-29-release-rb1-transcript-inheritance.md`); fully independent of it (RB1 = product *does* what it claims; RB2 = external user can *install* it). Both gate v1 GA.

> **VERSION DECISION (user, 2026-05-29): publish `manta@0.1.0`, NOT `1.0.0`.** The honest-early signal — the D5 precondition (`manta cast` only from a Manta-enabled checkout) + the RB1 Chunk-4 caveat (>2MB transcripts degrade to empty-context with a loud warning) are real v1 limits; `0.1.0` advertises "works but young" rather than over-promising. Bump to `1.0.0` once arbitrary-dir casting (Phase 8) + Chunk 4 land. Everywhere this plan said `1.0.0`, the target is now `0.1.0`. **CHANGELOG collision:** a `## [0.1.0] — Phase 0` section already exists (line 75) but NOTHING was ever published (all packages were `private`/`0.0.0`), so it was an internal milestone marker, not a release. Resolution for Chunk 1: this `0.1.0` IS the first real npm publish — FOLD the entire `[Unreleased]` block (Phases 2–7 work) INTO the existing `[0.1.0]` section and date it (`## [0.1.0] — <date>`), so `0.1.0` honestly = "first published `manta`, contains Phases 0–7." Do NOT create a duplicate `[0.1.0]` heading.

**Source of truth:** prod-readiness audit `docs/audits/2026-05-29-prod-readiness.md` (B-PUB1..B-PUB4, S-PUB5/6) + live package-graph recon done while drafting this (2026-05-29, current `main`). Spec: `docs/superpowers/specs/2026-05-06-manta-pattern-design.md` Sec 9 (stack) / Sec 15 (phasing). `/goal`: «`npx manta@latest install` работает для внешнего юзера».

**One-line goal:** A user on a clean machine runs `npx manta@latest install`, and afterward `manta cast …` works — the `manta-bus` MCP server is registered (from the *installed* path, not `$(pwd)`), and `manta --help` / `manta status` run. Proven by an install-from-tarball e2e on a clean dir, not by inspection.

---

## 1. What "done" means (acceptance, backward from the goal)

1. `npm pack` of the published package produces a tarball that, when extracted into a clean dir with **only its registry deps installed** (no pnpm workspace, no repo), exposes a working `manta` bin: `node <pkg>/dist/bin/manta.js --help` exits 0 and lists the command table.
2. The tarball carries **all three bins** with real code: `manta` (CLI), `manta-bus` (MCP server `server.cjs`), `manta-validate-skills` — and **zero `workspace:*` runtime deps**.
3. `manta install` (no positional) self-bootstraps: registers `manta-bus` via `claude mcp add -s user manta-bus -- node <resolved-server-path>`, where the path resolves from the **installed package location**, idempotent on re-run, friendly error if `claude` is absent.
4. `manta install <spec>` still does the existing **Manta Library** install (unchanged behaviour — `runInstallCommand`).
5. An e2e (`@manta/e2e`) packs → installs-clean → asserts (1)+(3-dry-run). This is the gate that would have caught every B-PUB blocker.
6. Docs no longer promise a distribution mechanism that does not exist (plugin marketplace) — see D3.
7. `pnpm gate` green throughout; published `package.json` declares `engines.node >=20` (a published CLI never runs the monorepo `preinstall`).

---

## 2. Current state (verified 2026-05-29, do NOT re-derive blindly — confirm before editing)

**Package graph** (`node -e require(...package.json)` across all 6):

| package | name | private | version | bins | runtime deps |
|---|---|---|---|---|---|
| root | `manta-monorepo` | true | 0.0.0 | — | (devDeps only; `preinstall` node-version guard) |
| cli | `@manta/cli` | true | 0.0.0 | `manta`→`dist/bin/manta.js` | **4× `@manta/* workspace:*`** + commander, execa, semver, tar, yaml, zod |
| bus | `@manta/bus` | true | 0.0.0 | `manta-bus`→`dist/bin/server.cjs` | `@manta/snapshot workspace:*`, @modelcontextprotocol/sdk, nanoid, proper-lockfile, yaml, zod |
| orchestrator | `@manta/orchestrator` | true | 0.0.0 | — | `@manta/bus`, `@manta/snapshot` (workspace), zod |
| snapshot | `@manta/snapshot` | true | 0.0.0 | — | zod |
| skill-validator | `@manta/skill-validator` | true | 0.0.0 | `manta-validate-skills`→… | commander, gray-matter, zod |
| e2e | `@manta/e2e` | true | 0.0.0 | — | all `@manta/*` (workspace), execa |

**Two facts that shape everything (both missed by a naive "just flip private + noExternal"):**

- **(A) The bus is a SEPARATE long-lived binary.** `manta cast` spawns clones that call bus MCP tools; the bus runs as its own stdio process registered via `claude mcp add … node …/server.cjs`. So the published package must ship a **working `server.cjs`**, and the self-bootstrap must compute its path from the installed package (today getting-started.md:61 hard-codes `$(pwd)/packages/manta-bus/dist/bin/server.cjs` — wrong for an npm install; audit "First-time external-user breakage", prod-readiness.md:105).
- **(B) Transitive real-npm dep closure.** The 4 `@manta/*` workspace deps pull in real npm deps NOT in `@manta/cli`'s direct deps: **`@modelcontextprotocol/sdk`, `nanoid`, `proper-lockfile`** (via bus), **`gray-matter`** (via skill-validator). If we bundle `@manta/*` source but leave these undeclared, the published package throws `Cannot find module '@modelcontextprotocol/sdk'` at runtime. This is the classic dep-drift blocker class — the plan handles it explicitly in Chunk 2.

**`manta install` today** (`packages/manta-cli/src/commands/install.ts`, `runInstallCommand`): `<spec>` is a **required** positional (`install [options] <spec>` in `bin/manta.ts`); resolves via registry → validates `manta-package.json` → stages into LocalStore → lockfile. This is the **Manta Library** installer and stays as-is. The self-bootstrap is a *different* code path that does NOT exist yet.

**`tsup` already builds every package** (each has a `tsup.config.ts`); neither cli nor bus sets `noExternal`, so today every dep (incl `@manta/*`) is left external.

---

## 3. Decisions — LOCKED (rationale given; reviewer may challenge, do not silently re-litigate)

**D1 — Single unscoped `manta` package, multi-bin.** Rename `@manta/cli` → `manta` (unscoped) and make IT the one published artifact. Rejected: a thin unscoped launcher depending on scoped packages (audit option a) — that needs all `@manta/*` published+versioned in lockstep, a heavier maintenance + atomic-publish burden for zero external benefit.
- **Why:** `npx manta@latest …` resolves an unscoped name directly; one artifact = one version to cut, one tarball to test. Matches the goal's literal `npx manta@latest install`.

**D2 — Bundle `@manta/*` source via tsup `noExternal: [/^@manta\//]`; keep real npm deps EXTERNAL and DECLARED.** The published `manta` package's build inlines bus/orchestrator/snapshot/skill-validator source into each emitted bin; real npm deps stay `require`-able from `node_modules` and are listed in the published `dependencies`. Rejected: publish all 4 `@manta/*` (audit option a, same reason as D1); rejected: bundle real deps too (MCP SDK / proper-lockfile are fragile to inline — proper-lockfile path resolution already bit us in bug #53).
- **Why:** zero `workspace:*` in the published manifest (kills B-PUB3), one self-contained dist, real deps resolved by npm the normal way.
- **Dep closure to declare** (union of real deps across all bundled packages): `commander, execa, semver, tar, yaml, zod, @modelcontextprotocol/sdk, nanoid, proper-lockfile, gray-matter`. (Verify against the live graph at implementation time — fact (B).)

**D3 — Plugin manifest DEFERRED to Phase 8; doc-correct now.** The goal names the **npm/npx** path, not a Claude Code plugin-marketplace. Do NOT author `plugin.json`/`marketplace.json` for v1. Instead, fix every doc/spec line that promises "Claude Code plugin distribution" to say "npm CLI (`npx manta install`); plugin marketplace = Phase 8" so we ship honest docs (closes the doc half of B-PUB4; the build half is out of scope).
- **Why:** advertised-but-absent is the exact lie-class we are killing; the cheapest honest fix is to align the promise with the v1 mechanism.

**D4 — `manta install` (bare) = idempotent self-bootstrap; `manta install <spec>` = existing Library install.** Make the positional optional (`install [spec]`): no spec → bootstrap (register bus MCP, validate env); spec present → `runInstallCommand` (unchanged). Bootstrap MUST be idempotent (re-register is a no-op if already present) and MUST resolve the server path from the installed package, never `$(pwd)`.
- **Why:** matches the goal's literal `npx manta@latest install`; "install manta" (bare) vs "install a manta library" (with spec) reads naturally; idempotency makes an accidental re-run safe.

**D5 — v1 `manta cast` is scoped to "run from within a Manta-enabled git repo/worktree that carries `skills/`"; this precondition is DOCUMENTED, not silently assumed (plan-review A1).** The clone priming (`priming.ts:7`) makes "load the `manta-as-clone` skill" the clone's **mandatory first action**, and `manta cast` does `git worktree add` (requires a git repo). So `npx manta install` into an *arbitrary* non-repo dir installs the bin but `manta cast` cannot run there — the skills aren't present and there's no repo to worktree. Rejected option (b): ship `skills/` in `files:` + have bootstrap materialize them into the target — heavier, and still doesn't solve the git-repo requirement. We take **option (a)**: state the precondition honestly in the goal + `getting-started.md` ("`manta cast` runs from inside a Manta-enabled checkout; arbitrary-dir casting = Phase 8"). This is the dogfood reality (Manta builds Manta inside its own repo) and the only PROD-honest framing.
- **Why:** the literal one-line goal "install on a clean machine → cast works" is **NOT** true for a non-repo dir; shipping a version without stating this would be the exact advertised-but-absent lie-class RB2 exists to kill. **Surfaced to user before Chunk 0 (2026-05-29) → user chose `0.1.0`** (the honest-early signal, with the precondition documented) over `1.0.0` (plan-review A2). Precondition documented regardless of version.

---

## 4. Chunks

> TDD where a unit seam exists (bootstrap runner, like `mcp-preflight.ts`'s injected runner). Packaging/bundling chunks are gated by **`npm pack` + clean-extract run**, not unit tests — that is the only check that catches dep-closure drift. Each chunk = atomic conventional commits; `pnpm gate` green before "done".

### Chunk 0 — doc-correction of the distribution promise + repo-precondition (curator-owned, docs only) — ~0.75h
Implements D3 + D5's doc half. Replace "Claude Code plugin (Phase 7)" / "`npx manta@latest install` — Phase 7" promises with the honest v1 framing across: `README.md`, `docs/user/getting-started.md:111`, `packages/manta-cli/README.md:7`, `packages/manta-bus/README.md:37`, spec `…manta-pattern-design.md:397`. Keep generic phase-status destaling (S-DOC7/8/9) in the separate hardening task — here only the *distribution-mechanism* claim.
- **`packages/manta-cli/README.md` is the published npm landing page** (npm always ships `README.md` regardless of `files:`). Its line 7 currently tells installers to `pnpm --filter @manta/cli exec manta` — a monorepo command. Rewrite it **npm-install-first** (`npx manta@latest install` / `manta cast …`), not just a phase-label tweak (plan-review S2).
- **State the D5 precondition** in `getting-started.md`: `manta cast` runs from inside a Manta-enabled git checkout/worktree carrying `skills/`; arbitrary-dir casting is Phase 8 (plan-review A1).
- **Gate:** `grep -rn "npx manta@latest install" docs README.md packages/*/README.md` → every remaining hit is either accurate (post-RB2) or explicitly labelled the v1 npm path; the cli README front page reads as an npm package page, not a monorepo dev note.

### Chunk 1 — package identity + publish metadata (NO bundling yet) — ~2h
Make the package nominally publishable; prove via dry-run that metadata is right before touching the build.
- `packages/manta-cli/package.json`: `name` `@manta/cli`→`manta`; remove `private` (or `false`); `version` `0.0.0`→`0.1.0` (user decision — see Status note); add `engines.node >=20`; add `"prepublishOnly": "pnpm run build"` (S-PUB5); confirm `files: ["dist"]` will carry all bins after Chunk 2; keep `bin.manta`. Add `repository`/`homepage`/`keywords` (npm hygiene).
- **M1 — the version lives in THREE places, bump all in the same commit** (plan-review M1, verified): `package.json#version`, the hard-coded `.version('0.0.0')` at `src/bin/manta.ts:144` (the literal `manta --version` output), and `MANTA_CLI_VERSION` at `src/library/cli-version.ts:9` (feeds the library-install compat check at `manta.ts:542,757`). `cli-version.ts:5-7` documents the "mirror to package.json at release time" contract. **Verify:** `grep -rn "0\.0\.0" packages/manta-cli/src packages/manta-cli/package.json` returns zero version hits after. (All three are literals, not runtime package.json reads → bundling-safe; the cost is lockstep.)
- **M3 — rename grep is wider than just the dep** (plan-review M3, verified 7 e2e pins): run `git grep -n '@manta/cli'` AND `git grep -n 'manta-cli/dist/bin'` AND `git grep -n -- '--filter @manta/cli'`. Update: (a) `@manta/e2e` `package.json` dep; (b) every `pnpm --filter @manta/cli…` invocation in `packages/manta-e2e/tests/*.ts` (confirmed `manta-library.e2e.test.ts:30`; after rename `--filter @manta/cli...` matches nothing → e2e build step fails); (c) the **`dist/bin/manta.cjs`** bin-path constant pinned in **7 e2e files** (`bug-hunt`/`refactor-wave`/`recon-swarm`/`charge-system`/`forking-realities` e2e :9-10, `preflight.test.ts:31`, `manta-library.e2e.test.ts:12`). **Decide + document the published bin format:** `bin.manta` → `dist/bin/manta.js` (ESM) is the entry a user gets; tsup emits both `.js`+`.cjs` today. Either keep the e2e suite on `.cjs` and pin the **Chunk-4 publish-acceptance** e2e to the published `.js` (so acceptance tests what users run), or migrate all e2e to `.js`. Pick ONE, write it down — do NOT let acceptance test a different bin than users get. (`pnpm-workspace.yaml` globs key off the **directory** `packages/*`, not the name — no change needed, verified.)
- **M5 — add the missing tsconfig project reference** (plan-review M5, verified absent; also closes prior-audit M4): add `{ "path": "../manta-skill-validator" }` to `packages/manta-cli/tsconfig.json` `references` (today only bus/orchestrator/snapshot are listed, yet cli imports skill-validator at `install.ts:9`, `share.ts:10`, etc.). `tsc -b` (the typecheck gate) needs it as a project dep once Chunk 2 makes the validator a bundled build input — else stale incremental output reddens the gate non-deterministically mid-cast.
- Do NOT yet change deps/bins for bus+validator — that is Chunk 2.
- **A4 — CHANGELOG `[0.1.0]` first-publish cut** (plan-review A4, version per Status note): the file already has `## [0.1.0] — Phase 0` but nothing was ever published — so FOLD the whole `[Unreleased]` block (Phases 2–7) into that existing `[0.1.0]` and date the heading; `0.1.0` = first real `manta` publish (Phases 0–7). Do NOT add a second `[0.1.0]` heading. If you open `CHANGELOG.md`, also fix its stale "18 tools"→"25" in the same pass (S-DOC9 is otherwise out of scope — don't re-open the file twice).
- **Gate:** `npm publish --dry-run` shows `name: manta@0.1.0`, not-private; `manta --version` prints `0.1.0`; `pnpm gate` green; `@manta/e2e` still resolves the renamed dep with all `--filter`/bin-path references updated.

### Chunk 2a (PREREQUISITE — bug #53 fix) — heartbeat-hook must survive bundling — ~1.5h
**M2 (plan-review, promoted from open-item #3 to hard prerequisite; verified against `heartbeat-hook.ts:13`).** `packages/manta-cli/src/spawner/heartbeat-hook.ts:13` does `createRequire(require_.resolve('@manta/bus')).resolve('proper-lockfile')` — a **runtime `require.resolve('@manta/bus')`** run on every cast (via `installHeartbeatHook`, `clone-spawner.ts:152`). Once D2 inlines `@manta/bus` via `noExternal`, there is **no `@manta/bus` in the published `node_modules`** → this throws `Cannot find module '@manta/bus'` and the spawn step dies. This IS bug #53's mechanism (`docs/manta-bugs.md:768`; root cause :817 — install-time absolute path under a different `node_modules` layout); bundling makes it **deterministic**, not latent.
- Replace the `require_.resolve('@manta/bus')` chain: resolve `proper-lockfile` in a way that survives bundling — emit `require('proper-lockfile')` **inside the generated touch-script** and let the *worktree's own* `node_modules` resolve it at subprocess runtime (the clone's cwd is a checkout that has the dep), OR `require.resolve('proper-lockfile')` directly from the bundled package root (proper-lockfile is in the published manifest per Chunk 2 dep-closure). Do NOT chain through `@manta/bus`.
- Apply bug #53 fix (c): the generated lock `catch` must `console.error` the failure, not silently swallow (a no-op lock corrupts the heartbeat-touch invariant invisibly).
- **Gate (this is the gate the server-bin smoke check would MISS):** a unit test (or a bundled-`manta` smoke cast) that runs `installHeartbeatHook` against the **bundled** bin and asserts the touch-script is written and `node <touch-script>` runs without `Cannot find module`. Mark `docs/manta-bugs.md` #53 → Fixed only after this passes against the *bundled* artifact.

### Chunk 2 — bundle into one self-contained artifact — ~3h (the hard one) — DEPENDS ON 2a
Implements D2 + facts (A)/(B). Order: **2a first** → tsup config → dep manifest → pack-verify.
- `packages/manta-cli/tsup.config.ts`: add `noExternal: [/^@manta\//]` (intentionally greedy; the only `@manta/*` packages are the 5 internal workspace ones — no external `@manta/`-scoped npm dep to accidentally inline, verified plan-review S1); add tsup **entries** so the published dist also emits the bus server and the validator bins, e.g. `'bin/server': '../manta-bus/src/bin/server.ts'` and `'bin/manta-validate-skills': '../manta-skill-validator/src/bin/manta-validate-skills.ts'` (paths relative to the cli package; cross-package src entries verified feasible — plan-review C2: no tsconfig `paths` aliases, esbuild follows pnpm symlinks to source; `dts` is `entry: src/index.ts` only, so bin entries don't trigger DTS against sibling src). Confirm `server` emits `.cjs` (consumers/`claude mcp add` expect `server.cjs`; the bus src has no `import.meta`, so ESM-src→CJS-out is sound) — mirror manta-bus's `outExtension`.
- `package.json`: `bin` → `{ "manta": "./dist/bin/manta.js", "manta-bus": "./dist/bin/server.cjs", "manta-validate-skills": "./dist/bin/manta-validate-skills.js" }`; **remove all 4 `@manta/* workspace:*`**; **add the transitive real deps** from fact (B): `@modelcontextprotocol/sdk`, `nanoid`, `proper-lockfile`, `gray-matter` (+ keep commander/execa/semver/tar/yaml/zod).
- **Gate (empirical, mandatory — unit tests cannot catch this):** `pnpm run build` → `npm pack` → extract tarball into `$(mktemp -d)` → `npm i --omit=dev` there → `node dist/bin/manta.js --help` exits 0 AND `node dist/bin/server.cjs` starts without `Cannot find module` AND the **Chunk-2a heartbeat-hook gate passes against this extracted artifact**. Tree-shaking may drop unused transitive deps — if so, trim the manifest to the *actual* closure (don't ship phantom deps); if a dep is missing at runtime, add it. The pack-extract-run loop is the source of truth.

### Chunk 3 — `manta install` self-bootstrap — ~2.5h
Implements D4. TDD with an injected `claude mcp add` runner seam (mirror `mcp-preflight.ts`'s `ClaudeMcpRunner`).
- New module e.g. `packages/manta-cli/src/commands/bootstrap.ts` (compiles to `dist/commands/bootstrap.js`): `runBootstrap({ runner?, claudeBinResolver? })` →
  1. resolve `server.cjs` anchored on the bootstrap module's own location: `new URL('../bin/server.cjs', import.meta.url)` — from `dist/commands/bootstrap.js` this resolves to `dist/bin/server.cjs` (siblings under `dist/`, verified plan-review C4). NEVER `process.cwd()` (fact A; prod-readiness.md:105). Name the anchor file in a comment so `../bin/` isn't misread as relative-to-cwd.
  2. check existing registration (`claude mcp get manta-bus`, reuse the bug #57 scoped probe) — if present + connected, no-op with a friendly "already set up" (idempotency).
  3. else `claude mcp add -s user manta-bus -- node <serverPath>`; verify; print next-steps.
  4. friendly hard-stop if `claude` not on PATH (reuse the `mcp-preflight` error style).
- **M4 — fix the preflight's wrong-path error string** (plan-review M4, verified at `mcp-preflight.ts:79`): it currently tells a failing user to run `claude mcp add … node "$(pwd)/packages/manta-bus/dist/bin/server.cjs"` — a monorepo path that does not exist in an npm install (the runtime twin of the D3 doc lie, and of `getting-started.md:61`). Once `manta install` (this chunk) exists, change that string to direct the user to **`manta install`** (the self-bootstrap registers the correct installed path). The preflight error is a real external-user surface — leaving `$(pwd)` is the same lie-class D3 kills in docs.
- `bin/manta.ts`: change `install <spec>` (currently required at `:485`, `.action` at `:494`) → `install [spec]`; dispatch bare (`spec == null`) → `runBootstrap`, spec present → `runInstallCommand` (unchanged). Update `.description`. (commander optional-positional is the right mechanism — verified plan-review C3; nothing else keys off the positional being required.)
- **Tests:** bare-install registers when absent (runner spy sees correct `mcp add` argv with the resolved server path **inside the package, NOT cwd**); idempotent no-op when already present; friendly error when `claude` missing; `install <spec>` still routes to library install (regression); the preflight error string names `manta install`, not `$(pwd)`. `pnpm gate` green.

### Chunk 4 — install-from-tarball e2e (acceptance gate) — ~2h
Implements S-PUB6 — the test that would have caught B-PUB1/2/3/5.
- `packages/manta-e2e/tests/publish-install.e2e.test.ts` (gated by the existing `MANTA_E2E=1` — do NOT invent a new env var): `npm pack` the `manta` package → extract into a clean tmp dir → `npm i --omit=dev` → assert **the published bin** (`dist/bin/manta.js`, the `bin.manta` entry — the one users actually run, per the Chunk-1 format decision) `--help` exit 0 + command table; assert `manta install` (bare) **dry-run / mocked claude** resolves the bundled `server.cjs` path (don't mutate the real user MCP config in a test — inject the runner or assert the computed argv).
- **S3 — this e2e does NOT need a real `claude`** (plan-review S3): it asserts `--help` + a mocked/dry-run bootstrap, unlike the cast e2e tests that `probeClaudeBin`-skip without a real binary. Gate it on `MANTA_E2E=1` but NOT behind `assertClaudeAvailable`, so it still runs in CI where `claude` is absent.
- **Gate:** the e2e passes locally with `MANTA_E2E=1`; `pnpm gate` green.

---

## 5. Cast strategy (§6-style)

- **Chunk 0** — curator does it directly (docs, <0.5h, no cast).
- **Chunk 1** — small, mechanical rename + metadata: 1 clone (`recon-swarm`-style single-clone implementation) OR curator if trivial after grep. The `@manta/cli`→`manta` rename touching multiple consumers makes it cast-worthy (>10min, multi-file).
- **Chunk 2** — the hard one (tsup cross-package entries + dep closure + pack-verify): **2-clone forking-realities best-of-N** — the assembly has real degrees of freedom (entry wiring, what to declare vs let tree-shake) and an empirical gate to judge the winner cleanly.
- **Chunk 3** — single clone; clear TDD contract.
- **Chunk 4** — single clone; depends on 1+2+3 merged.
- **Ordering:** 0 → 1 → 2 → 3 → 4, strictly serial (each builds on the prior package state). Do NOT run an RB2 cast concurrently with an RB1 cast — both touch `packages/manta-cli` (cast.ts, bin/manta.ts, package.json), guaranteed conflict + bug #35 (concurrent-cast node_modules) risk.

---

## 6. Risks / failure modes

| risk | mitigation |
|---|---|
| tsup tree-shakes a transitive dep out, hiding it from the manifest until a rare code path runs | Chunk 2 gate runs BOTH bins from a clean extract; declare the full closure conservatively, trim only what the extract proves unused; Chunk 4 e2e is the backstop. |
| `server.cjs` path unresolvable under npm-global / npx layout | resolve via `import.meta.url`/`require.resolve` against the package, never `cwd`; Chunk 3 test asserts the computed path is inside the package. |
| `require.resolve('@manta/bus')` at heartbeat-hook.ts:13 (bug #53 mechanism) **deterministically** breaks under `noExternal` — the package literally disappears from `node_modules` | **MUST land in/before Chunk 2 — now Chunk 2a, a hard prerequisite, NOT a coordination flag.** Replace the chained resolve; gate with a bundled-artifact heartbeat-hook test (the server-bin smoke check does NOT exercise this path). plan-review M2. |
| clone-side skills NOT shipped → clone's mandatory "load `manta-as-clone`" first action (`priming.ts:7`) finds nothing; AND `manta cast` needs a git repo (`git worktree add`) | RESOLVED → **D5**: v1 scopes `manta cast` to "from within a Manta-enabled checkout carrying `skills/`" and DOCUMENTS the precondition (option a). The "core cast is skill-independent" premise was factually WRONG (plan-review A1). Arbitrary-dir casting = Phase 8. |
| renamed package breaks an internal name-keyed lookup | Chunk 1 `grep -rn "@manta/cli"` before edit; `pnpm gate` + e2e resolution check. |

## 7. Explicitly OUT of scope (v1)
- Claude Code plugin manifest / marketplace entry (Phase 8; D3 doc-corrects the promise instead).
- Publishing the `@manta/*` packages individually (D1/D2 make them bundled-internal).
- Phase 8 hook distribution.
- Generic doc phase-status destaling (S-DOC7/8/9) and the other hardening items (S-COV10, S-OBS11, N-QB12) — separate hardening task; only the distribution-promise doc-fix (D3) lives here.

---

## 8. Open items — RESOLVED by plan-review (`docs/plan-reviews/2026-05-29-rb2-publish-path-review.md`)
1. **Skills/commands shipping** → **RESOLVED: D5.** The "core cast is skill-independent" premise was factually WRONG (`priming.ts:7` hard-references `manta-as-clone`; cast needs a git repo). v1 scopes `manta cast` to a Manta-enabled checkout and documents the precondition (option a). Surfaced to user before Chunk 0. (plan-review A1.)
2. **`1.0.0` vs `0.1.0`** → **RESOLVED by user 2026-05-29: `0.1.0`** (the honest-early signal; D5 precondition + Chunk-4 caveat make `1.0.0` over-promise this early). Surfaced before Chunk 0 per A2. Bump to `1.0.0` when Phase 8 (arbitrary-dir casting) + Chunk 4 land.
3. **bug #53 sequencing** → **RESOLVED: hard prerequisite, now Chunk 2a.** Bundling deterministically breaks `require.resolve('@manta/bus')`; not an open question. (plan-review M2/A3.)
4. **CHANGELOG `[0.1.0]` first-publish cut** → **RESOLVED: Chunk 1** — fold `[Unreleased]` into the existing `[0.1.0]` (nothing was ever published; `0.1.0` = first real publish, Phases 0–7); fix stale "18 tools"→"25" if the file is opened. (plan-review A4; version per Status note.)
