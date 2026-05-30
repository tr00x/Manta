# Audit C — Bundling / Runtime-Require Class

**Scope:** Every instance where a module is `require()`d / `require.resolve()`d / dynamically `import()`ed at RUNTIME (not statically inlined by esbuild), for the PLUGIN distribution (git-clone, NO `npm install`, NO node_modules). Cross-checked against the `dist/node_modules/` vendor set (`proper-lockfile`, `graceful-fs`, `retry`, `signal-exit`).

**Method:** source grep + grep of the BUILT artifacts (`dist/bin/manta.cjs`, `dist/bin/server.cjs`) + **empirical load tests from an isolated clean dir** (`/tmp/manta-clean-test/dist`, containing ONLY `dist/bin/*` + `dist/node_modules/*`, no repo node_modules) — simulating a fresh git-clone plugin.

**Verdict up front:** The vendored fix is COMPLETE and CORRECT. No additional runtime-external dependency needs vendoring. The five `ajv/*` + one `esprima` bare requires that survive in the bundle are all either dead-code-string (ajv standalone codegen) or graceful-degrade try/catch (esprima) — empirically proven non-fatal on a clean clone. **NOTHING to fix.** Detail below.

---

## Architecture recap (load-bearing)

- **npm build** (`tsup.config.ts` → repo-root `dist/`, also `packages/manta-cli/dist`): deps EXTERNAL, npm resolves them. Not the plugin.
- **plugin build** (`tsup.plugin.config.ts` → `packages/manta-cli/plugin-dist/bin/` → copied by `scripts/build-plugin.mjs` → repo-root `dist/bin/`): `noExternal: [/.*/]` (inline EVERYTHING). This `dist/` IS the plugin payload (`.claude-plugin/` at repo root; `.mcp.json` runs `${CLAUDE_PLUGIN_ROOT}/dist/bin/server.cjs`).
- **Vendored runtime tree:** `scripts/build-plugin.mjs` copies `proper-lockfile + graceful-fs + retry + signal-exit` into `dist/node_modules/` (flat, dereferenced). Node resolves these from `dist/bin/*.cjs` via `../node_modules`.
- **CJS `import.meta.url` shim** (tsup `shims:true`): `importMetaUrl = new URL("file:" + __filename).href` (`dist/bin/manta.cjs:36-44`). Anchors to the bundle file itself. This is what makes the heartbeat-hook resolve AND the bootstrap server-path resolve work.

---

## Findings

### F1 — heartbeat-hook `require_.resolve('proper-lockfile')` — ALREADY FIXED, verified

- **File:** `packages/manta-cli/src/spawner/heartbeat-hook.ts:6,18`
  ```ts
  const require_ = createRequire(import.meta.url);
  const PROPER_LOCKFILE_PATH = require_.resolve('proper-lockfile');
  ```
- **Built:** `dist/bin/manta.cjs:41924` → `require_ = createRequire(importMetaUrl)` where `importMetaUrl` = `file:<dir>/manta.cjs`.
- **Nature:** RUNTIME external. `createRequire` anchored at the bundle → resolves against `dist/node_modules/`.
- **What breaks where:** PLUGIN only (npm has it in node_modules; clone worktree has none). This was the dead-on-arrival crash (`Cannot find module 'proper-lockfile'`).
- **Empirical proof (clean dir):**
  ```
  createRequire("…/dist/bin/manta.cjs").resolve("proper-lockfile")
    -> /private/tmp/manta-clean-test/dist/node_modules/proper-lockfile/index.js
  LOADED proper-lockfile, lock fn: function
  ```
- **The GENERATED touch-script** (`heartbeat-touch.cjs`, `heartbeat-hook.ts:96-97`) runs as a SEPARATE node process inside the clone worktree:
  ```
  const fs = require('fs');                       // builtin — OK
  const lockfile = require("<baked absolute path>"); // baked = require_.resolve result
  ```
  The path is baked at spawn time as an **absolute** path, so cwd is irrelevant. Verified loading from `/tmp` cwd:
  ```
  touch-script OK from /tmp cwd, lock: function
  ```
- **Severity:** was CRITICAL; **now RESOLVED by the vendor.** No further action.

### F2 — git-lock-hook generated script — SAFE (builtin only)

- **File:** `packages/manta-cli/src/hooks/git-lock-hook.ts:67`, installed by `git-lock-hook-installer.ts:19` → writes `.manta/git-lock-hook.cjs` into the clone worktree.
- Generated script `require('fs')` only — Node builtin. No external. No baked path.
- **Severity:** none.

### F3 — `ajv/dist/runtime/*` + `ajv-formats/dist/formats` (5 bare sub-path requires, BOTH bundles) — DEAD CODEGEN STRING, non-fatal

- **Built grep (manta.cjs AND server.cjs):**
  ```
  require("ajv-formats/dist/formats")
  require("ajv/dist/runtime/equal")
  require("ajv/dist/runtime/ucs2length")
  require("ajv/dist/runtime/uri")
  require("ajv/dist/runtime/validation_error")
  ```
- **Origin:** `ajv@8.20.0` + `ajv-formats@3.0.1`, pulled in via `@modelcontextprotocol/sdk@1.29.0 → zod-to-json-schema → ajv`. (Confirmed: no `packages/*/src` references ajv directly; no `standaloneCode`/`opts.code` ajv call anywhere in src.)
- **Nature:** These are ajv's **standalone-code-generation** path. The `ajv-formats/dist/formats` ref is literally a STRING emitted into generated standalone validator source (`dist/bin/manta.cjs:24056`):
  ```js
  _b.formats = (0, codegen_1._)`require("ajv-formats/dist/formats").${exportName}`;
  ```
  The four `ajv/dist/runtime/*` are the same: only referenced when ajv emits standalone modules. Manta uses ajv in normal validate-at-runtime mode (via the MCP SDK / zod-to-json-schema), never `standaloneCode()`, so these `require(...)` are never executed.
- **What breaks where:** Would only break if someone called ajv standalone codegen on the plugin — which Manta never does. **Not reachable.**
- **Empirical proof:** full `require("…/manta.cjs")` in the clean dir (no ajv on disk) loads with no throw; `manta --help`, `cast --help`, `charges`, and `server.cjs` startup all exit 0. ajv sub-paths are NOT resolvable from the clean dir and it does not matter.
- **Severity:** none (latent dead path). Listed for completeness so a future change that enables ajv standalone codegen knows it would need ajv vendored.

### F4 — `esprima` bare require (manta.cjs only) — GRACEFUL-DEGRADE try/catch, non-fatal

- **Built:** `dist/bin/manta.cjs:31663` inside js-yaml@3.14.2 `type/js/function.js`:
  ```js
  try { _require = require; esprima = _require("esprima"); }
  catch (_2) { if (typeof window !== "undefined") esprima = window.esprima; }
  ```
- **Origin:** `gray-matter@4.0.3` → `js-yaml@3.14.2` → optional `esprima` (only for the `!!js/function` YAML type). gray-matter is a direct dep of `manta-cli` AND `manta-skill-validator`.
- **Nature:** RUNTIME external, BUT wrapped in try/catch. On a clean plugin `esprima` is absent → catch fires → `esprima` stays `undefined` (no `window` in node). esprima is ONLY consumed by `resolveJavascriptFunction`/`constructJavascriptFunction`, i.e. the `!!js/function` YAML tag.
- **Crucial:** gray-matter parses with `yaml.safeLoad` (`dist/bin/manta.cjs:33453` → `parse: yaml.safeLoad.bind(yaml)`), which uses `DEFAULT_SAFE_SCHEMA` — the `!!js/function` type is NOT registered in the safe schema. So esprima is never invoked even when parsing real frontmatter.
- **What breaks where:** Would only break if Manta parsed YAML containing an explicit `!!js/function` tag through the UNSAFE schema — which gray-matter never does. **Not reachable.**
- **Empirical proof:** Module-load interception shows `esprima` IS attempted at load (js-yaml index registers function.js), but with esprima absent on the clean clone the full bundle loads with no throw ("LOADED OK, esprima absent, no throw"); `esprima` is `MODULE_NOT_FOUND` from the clean dir and every command still exits 0.
- **Severity:** none (graceful degrade + safe schema). Listed for completeness.

### F5 — dynamic `import('execa')` — INLINED, safe

- **Files:** `commands/library.ts:331`, `commands/cast.ts:1043` — `const { execa } = await import('execa');` (plus static `import { execa } from 'execa'` in `worktree.ts`, `clone-spawner.ts`, `graveyard.ts`, `registry-client.ts`, `mcp-preflight.ts`, `share.ts`, `merge-review-collector.ts`, `zk-harvest.ts`).
- **Nature:** esbuild followed the dynamic `import('execa')` and INLINED it — confirmed: `execa` does NOT appear in the built bare-require inventory; only `import("fs/promises")` (builtin) remains as a dynamic import in the bundle.
- **Severity:** none. (Note: execa SPAWNS external system binaries — `git`, `npm`, `pnpm`, `claude` — but those are PATH tools the user already has, not bundle modules. Out of scope for this class.)

### F6 — dynamic `import('@manta/orchestrator')` — INLINED via alias, safe

- **File:** `commands/cast.ts:1042`. Both tsup configs alias `@manta/*` to sibling `src/index.ts` AND set `noExternal`. No `@manta/*` bare require in either built artifact. Verified.
- **Severity:** none.

### F7 — `await import('node:fs/promises')` (charge-store) — builtin, safe

- **File:** `manta-bus/src/state/charge-store.ts:315`. Node builtin. Appears as `import("fs/promises")` in both bundles. Safe.

### F8 — bootstrap server-path resolver `import.meta.url` — works on plugin, verified

- **File:** `commands/bootstrap.ts:55-56` → built `dist/bin/manta.cjs:49239`:
  ```js
  path.resolve(path.dirname(fileURLToPath(importMetaUrl)), "server.cjs")
  ```
- Not a module require — a FILE-PATH resolution for `manta install` self-bootstrap (registers the bus MCP). Relies on the CJS `importMetaUrl` shim anchoring to the bundle. NOTE: the in-code comment says it resolves `manta.js` (ESM); the plugin actually emits `manta.cjs` — the shim handles both (`file:${__filename}`), so the comment is slightly stale but the behavior is correct.
- **Empirical proof (clean dir):** resolver → `/tmp/manta-clean-test/dist/bin/server.cjs`, `exists: true`.
- **Severity:** none (cosmetic doc-comment drift only — `manta.js` → `manta.cjs`).

### F9 — clone-spawner node-script spawn — TEST-ONLY path

- **File:** `spawner/clone-spawner.ts:267` spawns `process.execPath [opts.scriptPath]`. Per the in-code comment this is the TEST-FIXTURE seam (fixtures read `MANTA_SNAPSHOT_PATH`); production spawns the `claude` binary directly (`:288`, `:352`, default bin `'claude'`). No external-module dependency on the spawn target.
- **Severity:** none.

### F10 — vendored transitive closure — COMPLETE

- `proper-lockfile` deps: `{graceful-fs, retry, signal-exit}` — all three vendored.
- `graceful-fs`, `retry`, `signal-exit` deps: `{}` (none). Tree is closed.
- All four `package.json` are `type: commonjs` with valid `main`. No `.node` native addons in either bundle (`grep .node` empty).
- **Empirical proof:** from the clean dir, `proper-lockfile.lock()` acquired+released successfully — forcing transitive load of graceful-fs + retry + signal-exit as flat siblings. "LOCK acquired … released OK".

---

## Other checks (negative results)

- `packages/manta-snapshot/src`, `manta-orchestrator/src`, `manta-skill-validator/src`, `manta-e2e/src`: **zero** `require(` / `require.resolve(` / `createRequire` / non-builtin dynamic `import(`.
- No `__non_webpack_require__` anywhere.
- No `process.cwd()`-relative or `__dirname`-relative MODULE loads (only the F8 file-path resolve, anchored on `import.meta.url`, not cwd).
- No `package.json` in `dist/` or `dist/bin/` → no `"type":"module"` hazard for the `.cjs` files (they load as CJS regardless; `manta-cli/package.json` is `"type":"module"` but that does not affect `.cjs` extension resolution).
- `manta-validate-skills` bin is NOT in the plugin bundle (npm-only entry) and is never referenced by the plugin — no gap.
- `tsup.plugin.config.ts`: `noExternal: [/.*/]` with `splitting:false`, `shims:true`. No `external` entries. The only requires esbuild "can't follow" are the F3/F4 codegen-string / try-catch cases above, both proven non-fatal.

---

## DEFINITIVE LIST — every runtime-external dependency for the PLUGIN

| Module | Where required | Inlined or runtime-external | Reachable on clean plugin? | Vendored in `dist/node_modules`? | Status |
|---|---|---|---|---|---|
| `proper-lockfile` | `heartbeat-hook.ts:18` `require_.resolve` (in manta.cjs) + baked into generated `heartbeat-touch.cjs` | runtime-external | YES (fires on every clone spawn) | **YES** | ✅ vendored, verified |
| `graceful-fs` | transitive of proper-lockfile | runtime-external | YES (via lock) | **YES** | ✅ vendored, verified |
| `retry` | transitive of proper-lockfile | runtime-external | YES (via lock) | **YES** | ✅ vendored, verified |
| `signal-exit` | transitive of proper-lockfile | runtime-external | YES (via lock) | **YES** | ✅ vendored, verified |
| `ajv` (`ajv/dist/runtime/*`) | `manta.cjs` + `server.cjs` codegen STRING | runtime-external | **NO** (standalone-codegen-only, never called) | no | ✅ non-issue (dead path) |
| `ajv-formats` (`/dist/formats`) | `manta.cjs` + `server.cjs` codegen STRING | runtime-external | **NO** (standalone-codegen-only) | no | ✅ non-issue (dead path) |
| `esprima` | `manta.cjs` js-yaml `function.js` try/catch | runtime-external | **NO** (try/catch degrade + safeLoad/DEFAULT_SAFE_SCHEMA never registers `!!js/function`) | no | ✅ non-issue (graceful) |
| `execa` | many; 2 via dynamic `import()` | **INLINED by esbuild** | n/a | n/a | ✅ inlined |
| `@manta/*` | static + 1 dynamic import | **INLINED via alias + noExternal** | n/a | n/a | ✅ inlined |
| node builtins (`fs`,`path`,`crypto`,`child_process`,`module`,`os`,`url`,`util`,`stream`,`zlib`, …) | both bundles + generated hooks | builtin | YES | n/a (Node provides) | ✅ safe |
| system binaries (`git`,`npm`,`pnpm`,`claude`) spawned via execa | spawner/commands | external PROCESS (PATH), not a module | YES | n/a (user's PATH) | ✅ out of class |

### Bottom line

**The only runtime-external MODULES that must exist on disk for the plugin are `proper-lockfile`, `graceful-fs`, `retry`, `signal-exit` — all four are correctly vendored into `dist/node_modules/` and empirically verified to load + function from a clean clone.** The remaining bare requires in the bundle (`ajv/*`, `ajv-formats`, `esprima`) are unreachable dead paths (standalone-codegen strings / graceful try-catch) and were proven non-fatal on a clean clone. **No whack-a-mole remains; no additional vendoring required.**

The only nit (NOT a bug): `bootstrap.ts:46-51` comment says the bundle is `manta.js` (ESM) — the plugin emits `manta.cjs` (CJS). Behavior is correct (shim handles both); comment is stale.
