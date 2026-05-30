# Manta v1 — Release Board (live, curator-maintained)

**GOAL:** `npx manta@latest install` работает для внешнего юзера, продукт реально делает что
заявляет (клоны наследуют транскрипт, не субагенты), И **юзер реально может discover+use manta
из Claude Code**. Опубликовано как `manta@0.1.0`.

Updated: 2026-05-30 (curator session). HEAD `0c6abe1`.

## Фронты (параллельные, file-fenced — ноль перекрытий по записи)

| # | Фронт | Статус | File-fence (write) | Cast |
|---|-------|--------|--------------------|------|
| A | **RB#1 transcript inheritance** | ✅ DONE (#56 Fixed, real-claude e2e green) | — | done |
| B | **RB#2 publish path** Chunks 0-3 | ✅ MERGED (self-contained bundle + self-bootstrap) | — | done |
| C | **RB#2 Chunk 4** install-from-tarball e2e | ⏸️ written (clone A, cast-1780119936859), ceremony PAUSED до RB#3 (install/layout может поменяться) | `packages/manta-e2e/tests/` | harvested, hold |
| D | **RB#3 discoverability** (plugin/slash/skills) | ✅ DONE + verified — Manta ships as Claude Code plugin (`109ecaa`,`d5612d7`). `/manta:*` (7 cmds), skills, `.mcp.json` auto-bus, `claude plugin validate` PASSED, gate 171/1462. Clone A won forking (B closed node_modules dirty). | repo-root plugin layout | done |
| E | **Hardening** bug #63 | ✅ FIXED + cherry-picked (`34062c1`), gate green 171/1459. #60 escalated (out of fence→RB#4), N-QB12 was stale-clean | `cast.ts`, `merge-review-collector.ts` | done |
| F | **Docs destaling** S-DOC7/9, S-OBS11 | ✅ cherry-picked (`40db9a6`): README status, Tier-0 note, isolation 18→25. Flagged `read_broadcasts` scope (→RB#4 security) | `README.md`, `docs/internals/`, spec | done |
| RB#4a | **Concurrent-cast reliability** #64+#35 | ✅ FIXED + cherry-picked (`e84e55c`,`3ba3285`), gate 171/1462. #64 data-loss guard (structural cast_id-path = post-v1 follow-up); #35 serialized | `worktree.ts`, `merge-review-collector.ts` | done |
| RB#4b | **Reliability leftovers** #63 RED-path tests, #60 coercers (src/bin), read_broadcasts scope | 📋 scoped, lower priority | `merge-review-collector` tests, `src/bin/`, `manta-bus/src` | cast later |
| G | **npm publish manta@0.1.0** | ⛔ BLOCKED on RB#3 + RB#4 + Chunk-4 | — | USER CONFIRM only |

## RB#4 — RELIABILITY (from /goal: надёжность для крупных проектов, клоны без пиздежа)
The headline feature is parallelism; first real parallel push hit 3 reliability bugs. ALL block "huge impact on large projects":
- **bug #64** (HIGH) — concurrent casts collide on clone-letter/worktree. `allocateCloneIds` correctly skips live letters (bug #19), but `addWorktree` (worktree.ts:30-34) force-`rm -rf`s an existing worktree dir → a letter freed by a finished clone (orphan worktree not GC'd) OR a race between allocate→register lets a new cast reuse the dir. Fix: worktree path include cast_id (`clone-<castid>-<L>`) so letter reuse never aliases a dir; atomic allocate+register+worktree under a registry lock.
- **bug #35 re-exposed** (HIGH) — concurrent `pnpm install` across worktrees on shared store (surfaced by #63 fix). Serialize `prepareWorktreeForGate` / store mutex / `--frozen-lockfile`.
- **bug #63 RED-path test gap** (MED) — gate tests never exercise a failing dimension; symmetric false-positive unguarded. Add ≥2 RED-path tests.
- **bug #60 leftover** (MED) — share/daily-cap `parseInt/parseFloat` coercers in `src/bin/` accept NaN (E found these out-of-fence). Validating coercer + NaN-reject test.
- **read_broadcasts scope** (security FLAG from F) — `read_broadcasts` is cast_id-scoped → potential forking-realities sibling-broadcast visibility. Audit + document/fix.

## Конфликт-матрица (почему фронты не дерутся)
- D recon = read-only, пишет только `docs/audits/` → не трогает код.
- E = `cast.ts` + `manta-bus/src` → не трогает install.ts/README/root-pkg.
- F = `docs/` + README status-table/tool-counts → не трогает src. README *usage* секция = RB#3 (D-impl, позже) — разные секции, F мержится первым, D отребейзится.
- C = `manta-e2e/tests/` only → изолирован, но HOLD: RB#3-impl может тронуть install.ts/package layout и инвалидировать e2e. Merge C ПОСЛЕ того как D-impl scope известен.

## Sequencing
1. D-recon вернётся → gap-list + RB#3 chunk plan → решить D-impl scope (это самый большой кусок, определяет тронется ли install.ts/package layout).
2. E + F мержатся как готовы (независимы).
3. После D-impl scope известен → решить судьбу C (merge as-is или переписать), domержить C.
4. D-impl casts.
5. Всё зелёно + gate + user confirm → `npm publish manta@0.1.0` (`--dry-run` first).

## RB#3 — DECISION (recon `cast-1780168716251`, 2026-05-30; deliverables `docs/audits/2026-05-30-{plugin-distribution-mechanics,manta-discoverability-gap}.md`)

**DECIDED: Manta v1 ships as npm CLI + Claude Code PLUGIN (thin wrapper). Plugin distribution is v1, NOT Phase 8.**
Rationale: slash-commands + user-visible skills are *architecturally impossible* via npm CLI — only the
plugin mechanism delivers them (recon proven against live superpowers/claude-mem plugins). The whole
premise is "Claude Code pattern"; CLI-only leaves `/manta` dead → не релиз. Plugin = thin packaging
wrapper around the EXISTING tsup bundle (`dist/bin/manta.js` + `server.cjs`) + a handful of 5-line
command markdowns + 2 manifests + `.mcp.json`. NOT a rewrite. Plugin + npm coexist.

**Curator empirical finding (corrects recon-B's [UNVERIFIED] G1/G2):** clones do NOT load their skills
today — `priming.ts` (131 lines) only *references* `manta-as-clone` ("Use the Skill tool to load…"),
but there is NO `.claude/skills` anywhere, the spawner copies nothing, no `--add-dir`. Clones run purely
on the inlined priming preamble (which carries the critical bus-protocol + graceful-death ordering) — and
that WORKS (every RB/recon cast succeeded). So **casting is NOT broken for an npm user** (priming is
inlined in the bundle); recon-B over-rated G1/G2 as "package non-functional". The real debt: (a) zero
discoverability, (b) `priming.ts` references skills that are dead (undeliverable to the clone's Skill tool).
**The plugin fixes BOTH at once:** its `skills/` land in `~/.claude/plugins/.../skills/`, surfaced to the
user (`/manta:cast-decide`) AND to clones (their Skill tool finally resolves `manta-as-clone`, healing the
dead ref) — same artifact, one shot. `.mcp.json` also auto-registers the bus (obsoletes `manta install`
ceremony for plugin users).

**RB#3 chunk plan (refined, dependency order):**
- **C2 [PUBLISH-BLOCKER] — Plugin scaffold** (the core): `.claude-plugin/{plugin.json,marketplace.json}`,
  `.mcp.json` (`manta-bus` = `node ${CLAUDE_PLUGIN_ROOT}/dist/bin/server.cjs`), `commands/{cast,status,abort,cost}.md`
  (thin Bash wrappers → `${CLAUDE_PLUGIN_ROOT}/dist/bin/manta.js`, auto-namespaced `/manta:*`), bundle `dist/`
  into plugin payload, drop the 10 `manta-*` skill dirs into plugin `skills/`. NO `contributes` block
  (convention discovery). Verify exact `/plugin marketplace add` syntax against current CC docs — do NOT invent.
- **C5 [PUBLISH-BLOCKER, honesty]** — README:7 "plugin = Phase 8" → "plugin IS v1"; spec §15 amend; remove every
  phantom `/manta …` ref project-wide; document real entry (plugin install → `/manta:*`; npm CLI as the
  power-user/terminal path). Phantom `/manta abort` in CLAUDE.md already fixed this session.
- **C-skills-heal [SHOULD]** — once plugin skills reach clones, audit `priming.ts` refs: either they now
  resolve (good) or trim dead ones. Re-verify a clone actually loads `manta-as-clone` post-plugin.
- **C3/C4 [nice-to-have, not blocker]** — extra slash-commands (`/manta:promote,inspect,replay`); optional
  `manta install` symlink path for non-plugin installs.
- **Chunk-4 e2e interaction:** C2 ships a NEW plugin payload but does NOT necessarily change `install.ts`/
  package layout (plugin dir is separate from the npm tarball). So the pending Chunk-4 install-from-tarball
  e2e likely stays valid — BUT recon flagged its blind spot: it asserts "bin runs", not "a clone loads its
  skill". Extend Chunk-4 (or add a plugin-acceptance e2e) to assert `skills/manta-as-clone` ships in the
  plugin AND a spawned clone resolves it. Decide at Chunk-4 ceremony.

**Minimum to unblock `npm publish` + plugin release:** C2 + C5. **Open infra note:** recon-B reported severe
Bash/Read/Grep transport degradation mid-cast (~1 in 5 calls returned) — possible MCP/tool-transport issue
worth a separate look; did not corrupt deliverables but slowed the clone.

## Hardening backlog (фронт E + leftovers)
- **bug #63** (TOP) — merge-scorer `runQualityGate` гоняет `tsc/vitest` без `pnpm install && build` → false-negative `no_candidates_passed_gate` каждый build-before-gate cast. Уже false-negatived Chunk 2/3/4.
- **bug #60** — bare `parseInt/parseFloat` share/daily-cap coercers принимают NaN → молча разоружают guards.
- **bug #58** — canonical `pnpm gate` lint исключает `tests/` → скрытые lint errors, Lint-dim scorer'а бессмысленна.
- **bug #59** — stale `.tsbuildinfo` → false typecheck RED.
- **N-QB12** — 3 `eslint-disable` без `// Reason:` (manta-bus server.ts:70/88, events.ts:87).
- **S-COV10** — `gate` без `--coverage` → coverage-регрессии не краснят гейт.
- **S-OBS11** — Observability Tier 0 (statusline) не реализован (spec Sec 11.0 обещает).
