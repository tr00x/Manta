# Last-gasp report — clone-A, cast-1780092273489 (RB2 Chunk 2)

**Task:** Bundle `manta` into ONE self-contained publishable artifact; flip bug #53 → Fixed via an empirical pack→extract→run gate.
**Outcome:** ✅ DONE. Gate passed end-to-end against the real tarball. All three bins run from a clean `npm i --omit=dev` extract with the 4 internal `@manta/*` packages inlined and ZERO `@manta/*` in the published manifest.

## Commits (on branch manta/cast-1780092273489/A)
1. `11fe755` feat(rb2): Chunk 2 — tsup noExternal bundle + 3 bin entries + dep closure
2. `84384c7` fix(rb2): Chunk 2 — internal @manta/* are build-time aliases, not published deps
3. `d8f267d` feat(rb2): Chunk 2 — empirical pack-extract-run gate green, all 3 bins from clean extract; bug #53 Fixed

## CRITICAL DEVIATION FROM CONTRACT (curator: read this)
The contract's EDIT 2 said "MOVE the 4 `@manta/*` deps to **devDependencies** (keep `workspace:*`)" and asserted they'd be excluded from `npm i --omit=dev`. **This is empirically WRONG and I proved it:**

- I first did exactly that (commit `11fe755`): gate steps 1–3 green, committed for reap-survival.
- Then the pack gate failed at step 6: `pnpm pack` rewrites `workspace:*` → `0.0.0` but **leaves `@manta/*` in the published `devDependencies`**. `npm i --omit=dev` (npm 10.9.4) still **resolves the dev dependency tree** even when omitting install → tries to fetch `@manta/bus@0.0.0` from the registry → **404 hard fail**.
- pnpm here is **9.0.0**: the `beforePacking` hook is 10.28+, and pnpm 9 does **not** fire `prepack`/`postpack` on `pnpm pack` (probed empirically). So a lifecycle-script manifest strip is not viable.

**Clean fix (commit `84384c7`):** the 4 internal packages are inlined at build time, so they are NOT dependencies of the published artifact at all — removed from `package.json` entirely (neither prod nor dev). Build-time resolution moved off the pnpm symlink into three aliases:
- `tsup.config.ts` → `esbuildOptions.alias` maps `@manta/*` → sibling `src/index.ts` (JS bundle inlines them).
- `tsconfig.json` → `baseUrl` + `paths` `@manta/*` → sibling `dist/index.d.ts`; `references` guarantee `tsc -b` emits each sibling `.d.ts` first (mirrors the old symlink resolution).
- `tsconfig.build.json` → overrides `paths` → sibling `src` + `rootDir: ".."` so the tsup DTS rollup is independent of sibling build order.
- `vitest.config.ts` → `resolve.alias` `@manta/*` → sibling `src` for the test runner.

Real externals stay declared: `@modelcontextprotocol/sdk ^1.0.0`, `nanoid ^5.0.0` (from bus), `gray-matter ^4.0.3` (from skill-validator), plus the pre-existing `proper-lockfile/yaml/commander/zod/execa/semver/tar`.

## Empirical gate — REAL output (all 10 steps)
1. `pnpm install` — ok.
2. `pnpm gate` — typecheck (`tsc -b`) + lint + **1441/1441 tests, 169 files** green. *(Note: a fresh worktree has no `dist`; `tsc -b` self-import of `@manta/bus` only resolves after a `pnpm build` populates sibling `dist/index.d.ts` — pre-existing workspace property, identical with my edits stashed. Canonical clean flow is install → build → gate.)*
3. `pnpm --filter manta build` — emits `dist/bin/{manta.js, server.cjs, manta-validate-skills.js}` (+ .cjs/.js variants). manta-cli builds **standalone with no `@manta` symlink**.
4. `pnpm pack` → `manta-0.1.0.tgz`.
5. `tar -xzf` → clean extract.
6. `npm i --omit=dev` → **127 packages, ZERO `@manta/*` fetched** (`node_modules/@manta` absent). Published manifest grep: ZERO `@manta`.
7. `node dist/bin/manta.js --help` → exit 0, full command table.
8. `node dist/bin/server.cjs` → MCP stdio server answered a real JSON-RPC `initialize` with `{"serverInfo":{"name":"manta-bus","version":"0.0.0"}}`, **empty stderr, no "Cannot find module"**.
9. `node dist/bin/manta-validate-skills.js --help` → exit 0.
10. grep all 8 executable dist files (`*.{js,cjs}`, sourcemaps excluded) for `require/import/resolve('@manta/…')` → **ZERO hits**. Chunk-2a source guard re-proven on the bundle.

## bug #53
`docs/manta-bugs.md` #53 Status → **Fixed**, with the bundled-artifact verification block + the devDeps-is-wrong correction note appended.

## Scope / hygiene
- Files changed: 6 (`packages/manta-cli/{package.json, tsup.config.ts, tsconfig.json, tsconfig.build.json, vitest.config.ts}`, `pnpm-lock.yaml`) + `docs/manta-bugs.md`. Well under maxFilesChanged=40.
- No mock / `.skip` / `.todo` / `eslint-disable` / `@ts-ignore`. Every config comment explains *why*.
- Held no locks/claims (never called `manta.lock`/`manta.claim_work`).

## If the curator picks me
The branch is buildable + packable + runnable as proven. The 5-file manta-cli change is isolated (only `manta-e2e` references manta-cli, and it resolves `@manta/*` via its own declared deps — untouched). The `tsconfig.build.json` `rootDir: ".."` is the one subtle bit: it lets the DTS pass read sibling source without an out-of-rootDir error and is independent of build order.
