# Internals: `manta share` sanitization + integrity architecture

This note documents *how* `manta share` (Phase 7b) produces a leak-free,
verifiable bundle, and why the design survives schema evolution. The
user-facing command reference is [`docs/user/manta-share.md`](../user/manta-share.md);
the ground-truth trust model is `docs/research/phase-7-community-share-trust.md`
(§0 trust model, §1 bundle anatomy, §1.4 sanitization table, §2 threat model).

All file:line citations below were verified against HEAD on 2026-05-29 (after
Phase 7b Chunks 1–2 merged). Re-verify before editing — per CLAUDE.md's #1
blocker class, cross-package field-name drift is the leading defect source.

---

## 1. Default-deny philosophy (why it survives schema growth)

Every sanitizer is **allowlist-driven**: it enumerates the fields it knows are
safe and *omits everything else*. The output of the snapshot sanitizer is then
re-validated against a `.strict()` schema
(`SanitizedSnapshotSchema`, `packages/manta-snapshot/src/sanitized-schema.ts`),
so if a source schema later grows a field, that field is **dropped** (not passed
through) and `.strict()` would reject it if a sanitizer naïvely forwarded it.

The alternative — a denylist of "things to strip" — fails open: a new sensitive
field nobody added to the denylist ships in the clear. Default-deny fails
closed. This is the core security property of the pipeline and the full fix for
bug #18 layer (b).

---

## 2. Per-artifact sanitizer map

Each sanitizer lives in `packages/manta-cli/src/share/` and returns
`{ sanitized, warnings }`. Secrets are **fatal** (a thrown `ShareSanitizationError`,
`share/errors.ts`); paths/transcripts are **warnings**.

| Artifact | Sanitizer | Source schema / renderer (file:line) | Key rules |
|---|---|---|---|
| Snapshot | `sanitize-snapshot.ts` | `SnapshotSchema` (`packages/manta-snapshot/src/schema.ts:65`) | drop `parentSessionId`/`parentPid`/`budget`/`sessionId`/`recentMessages`; redact `parentWorktree`/`cloneWorktree`; relativise `openFiles[].path`. |
| Task contract | `sanitize-task-contract.ts` | `TaskContractSchema` (`packages/manta-snapshot/src/schema.ts:28`) | secret-scan `task`+`approachHint` (fatal); relativise scope paths. |
| Post-mortem | `sanitize-post-mortem.ts` | `renderMarkdown` (`packages/manta-orchestrator/src/post-mortem.ts`) | header redaction only (Worktree/PID/epoch lines); full-text secret scan. |
| ZK note | `sanitize-zk-note.ts` | `fsMemoryWriters.zkWrite` (`packages/manta-bus/src/memory-writers.ts:81`) | rewrite `created_at`; secret-scan title+body (fatal); body path → warn, no auto-redact. |
| Event timeline | `sanitize-events.ts` | `renderEventPayload` (`packages/manta-orchestrator/src/post-mortem.ts:156`) | per-type allowlist projection over raw `events.jsonl`, filtered to winner, ts relativised. |
| Worktree diff | `sanitize-worktree-diff.ts` | `git diff <base>..<branch>` | full-text secret scan (fatal). |

The secret-format regex set is centralised in `share/secret-scanner.ts`
(`scanForSecrets` / `maskSecret`) so every sanitizer scans identically and a
finding's masked sample (`first 4 chars + "…"`) never re-leaks the token into a
report.

### 2.1 The post-mortem correction (research §1.4 was wrong)

Research §1.4 assumed `events[].payload` needs a recursive path-scan at share
time. **Verified false**: `renderEventPayload`
(`packages/manta-orchestrator/src/post-mortem.ts:156`) **already** applies a
per-type allowlist projection with default-deny (the bug #29 + bug #46 fixes —
the renderer's own comment cites "Post-mortems are then bundled by `manta share`
(Phase 7), so a leak here ships externally" as the motivation). And
`redactPostMortemMetadata` (`packages/manta-orchestrator/src/sanitize/metadata-allowlist.ts:17`,
bug #18 layer a) already allowlists the metadata block at render time.

So Phase 7b operates on the **rendered markdown on disk** and only needs:
- header-line redaction (the `Worktree:` / `Parent PID:` / epoch-ms lines the
  renderer still emits raw), and
- a defense-in-depth full-text secret + stray-path scan.

It must **not** re-sanitize the `## Metadata` or `## Event timeline` blocks —
they are already safe, and double-sanitising would corrupt the projected
timeline.

### 2.2 Event projection drift guard

Because Phase 7b re-implements the per-type allowlist (rather than touch the
frozen orchestrator file to share a table), `sanitize-events.ts` carries a
drift-guard test: for every event type it projects, the allowlisted key set must
equal the one `renderEventPayload` uses. If the orchestrator's renderer changes
its projection, the test fails — preventing the two from silently diverging.

---

## 3. The `castOrigin` manifest extension + 7c provenance contract

A shared bundle's manifest is the shipped flat `MantaPackageManifestSchema`
(`packages/manta-skill-validator/src/manifest-schema.ts:140`) **plus** a
`castOrigin` block recording lineage. We do **not** rewrite the frozen 7a schema;
we *intersect*:

```
SharedBundleManifestSchema = MantaPackageManifestSchema.and({ castOrigin: CastOriginSchema })
```

The one unavoidable edit to a frozen 7a file is additive and safe:
`manifest-schema.ts:159` adds `castOrigin: CastOriginSchema.optional()` so the
install path tolerates the extra key on a shared bundle while still accepting
pre-7b bundles that omit it. A regression test pins that `castOrigin: null`
(present-but-null) is rejected — the optional field must be *absent* in pre-7b
bundles, not null.

### 3.1 Provenance field mapping (Phase 7c, frozen)

Phase 7c widens `CastManifestSchema`
(`packages/manta-bus/src/schema.ts:354`) with an optional `metadata.trigger`
block. `build-cast-origin.ts` reads it **read-only** and maps it 1:1 into
`castOrigin.provenance` (wire = snake_case, manifest = camelCase):

| 7c wire field (`CastManifest.metadata`) | `castOrigin.provenance` field |
|---|---|
| `trigger.trigger_name` | `triggerName` |
| `trigger.fired_at` (ms epoch) | `firedAtOffsetMs` (= `fired_at − cast.created_at`) |
| `trigger.parent_cast_id` | `parentCastId` |
| `cause_chain` (full, **not** stripped — it is the audit trail) | `causeChain` |

Phase 7b does **not** depend on 7c landing first: `metadata?.trigger` is read
defensively; when absent (user-fired cast, or pre-7c manifest),
`castOrigin.provenance` is `null`.

---

## 4. Integrity model (and its honest limits)

`bundle-assembler.ts` writes the unpacked tree, then computes two integrity
witnesses:

1. **`checksum.json`** — `{ algorithm: 'sha256', files: { <relpath>: <hex> } }`
   over every file except itself. `verifyBundleChecksums(unpackedDir)` recomputes
   and compares — used by the publish preflight (gate 2) and re-usable by a
   future `manta library preview`.
2. **`directoryDigest`** — reuses the **shipped** `computeDirDigest`
   (`packages/manta-cli/src/library/dir-digest.ts:30`), the same primitive Phase
   7a's `verifyLibraryIntegrity` (`packages/manta-cli/src/library/integrity.ts`)
   checks at cast time. One shared algorithm end-to-end; no new hashing code.

**Determinism:** the tarball is built with `tar` portable mode, a fixed `mtime`
(`castOrigin.bundledAt`), and a sorted entry list, so two assembles of identical
artifacts are byte-identical. A Chunk 2 test asserts this.

**Honest limit:** without signing, `checksum.json` catches *accidental*
corruption and shifts the tamper surface from "edit one payload silently" to
"rewrite the whole tarball" — but an attacker who controls the tarball can
recompute the checksums. It is integrity, not authenticity. Code signing is
deferred to Phase 8+ because it needs a key registry / revocation / rotation /
lost-key recovery story that does not exist; "optional signing" without that
infra is theater.

---

## 5. The MVTS-7 publish gate order

`publish-flow.ts` `publishBundle` runs gates in a fixed order, each
short-circuiting the rest on failure (the order is asserted by a test):

```
static scan → checksum re-verify → npm whoami → scope ownership
            → two human confirms → size cap → npm publish --access public
```

Every shell-out is behind an injected `PublishRunner` (whoami / listScopePackages
/ publish) and `Confirmer` seam — tests inject fakes; the real defaults
(`commands/share.ts` `defaultDeps`) are execa-backed `npm` + a stdin readline
prompter. The static scanner (`static-scanner.ts`, research §2 mitigation d) is a
line-oriented regex pass; it is cheap and defeated by obfuscation (documented and
accepted per §0 — AST analysis via `acorn` is a Phase 8 hardening). Phase 7b
modes are `basedOn` built-ins and ship no JS, so the scan usually finds nothing,
but it ships now for forward-compat.

---

## 6. The auto-share trust boundary (build-yes / publish-no)

The single most important policy in Phase 7b:

- **Bundle generation MAY be trigger-fired.** A Phase 7c trigger may invoke
  `manta share <cast-id> --non-interactive` to produce a *local* reviewable
  artifact. Non-interactive mode forbids `$EDITOR`, forbids `--accept-warnings`
  (any warning is fatal), and requires the secret + static scans to pass clean.
  No network.
- **`--publish` is NEVER trigger-fired.** A trigger-fired cast publishing
  unreviewed code to a public registry violates informed consent. A human always
  pulls the publish trigger.

This is enforced at **two code levels** (never in skill text — skill text is a
soft prior, per CLAUDE.md):

1. **CLI pre-commander guard** (`bin/manta.ts` `rejectPublishNonInteractiveEarly`):
   `--publish` + `--non-interactive` in argv → stderr message + `process.exitCode = 2`,
   *before* commander parses. A trigger literally cannot construct a publishing
   invocation. Same enforcement shape as the `install --no-hooks` guard.
2. **Command-layer refusal** (`commands/share.ts` `runShareCommand`):
   `publish === true && nonInteractive === true` → `ShareError('share_publish_blocked')`
   (exit 27), even when called programmatically (bypassing the CLI).

Two layers, both code, both tested.
