# Internals: `manta share` sanitization + integrity architecture

This note documents *how* `manta share` produces a leak-free, verifiable
bundle, and why the design survives schema evolution. The user-facing command
reference is [`docs/user/manta-share.md`](../user/manta-share.md).

The file:line citations below point at the current source. Re-verify before
editing — cross-package field-name drift is the leading defect source in this
codebase.

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
closed. This is the core security property of the pipeline.

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

### 2.1 Why the post-mortem needs no recursive payload scan

You might assume `events[].payload` needs a recursive path-scan at share time.
It does not: `renderEventPayload`
(`packages/manta-orchestrator/src/post-mortem.ts:156`) **already** applies a
per-type allowlist projection with default-deny — the renderer's own comment
cites "Post-mortems are then bundled by `manta share`, so a leak here ships
externally" as the motivation. And `redactPostMortemMetadata`
(`packages/manta-orchestrator/src/sanitize/metadata-allowlist.ts:17`) already
restricts the metadata block to a safe field set at render time.

So `manta share` operates on the **rendered markdown on disk** and only needs:
- header-line redaction (the `Worktree:` / `Parent PID:` / epoch-ms lines the
  renderer still emits raw), and
- a defense-in-depth full-text secret + stray-path scan.

It must **not** re-sanitize the `## Metadata` or `## Event timeline` blocks —
they are already safe, and double-sanitising would corrupt the projected
timeline.

### 2.2 Event projection drift guard

Because `manta share` re-implements the per-type allowlist (rather than touch
the orchestrator file to share a table), `sanitize-events.ts` carries a
drift-guard test: for every event type it projects, the allowed key set must
equal the one `renderEventPayload` uses. If the orchestrator's renderer changes
its projection, the test fails — preventing the two from silently diverging.

---

## 3. The `castOrigin` manifest extension + provenance contract

A shared bundle's manifest is the flat `MantaPackageManifestSchema`
(`packages/manta-skill-validator/src/manifest-schema.ts:140`) **plus** a
`castOrigin` block recording lineage. We do **not** rewrite the install-side
manifest schema; we *intersect*:

```
SharedBundleManifestSchema = MantaPackageManifestSchema.and({ castOrigin: CastOriginSchema })
```

The one unavoidable edit to the install-side schema is additive and safe:
`manifest-schema.ts:159` adds `castOrigin: CastOriginSchema.optional()` so the
install path tolerates the extra key on a shared bundle while still accepting
plain library bundles that omit it. A regression test pins that `castOrigin: null`
(present-but-null) is rejected — the optional field must be *absent* in plain
bundles, not null.

### 3.1 Provenance field mapping (auto-cast triggers)

When auto-cast triggers land, `CastManifestSchema`
(`packages/manta-bus/src/schema.ts:354`) gains an optional `metadata.trigger`
block. `build-cast-origin.ts` reads it **read-only** and maps it 1:1 into
`castOrigin.provenance` (wire = snake_case, manifest = camelCase):

| Trigger wire field (`CastManifest.metadata`) | `castOrigin.provenance` field |
|---|---|
| `trigger.trigger_name` | `triggerName` |
| `trigger.fired_at` (ms epoch) | `firedAtOffsetMs` (= `fired_at − cast.created_at`) |
| `trigger.parent_cast_id` | `parentCastId` |
| `cause_chain` (full, **not** stripped — it is the audit trail) | `causeChain` |

`manta share` does **not** depend on triggers existing: `metadata?.trigger` is
read defensively; when absent (user-fired cast, or a manifest with no trigger
block), `castOrigin.provenance` is `null`.

---

## 4. Integrity model (and its honest limits)

`bundle-assembler.ts` writes the unpacked tree, then computes two integrity
witnesses:

1. **`checksum.json`** — `{ algorithm: 'sha256', files: { <relpath>: <hex> } }`
   over every file except itself. `verifyBundleChecksums(unpackedDir)` recomputes
   and compares — used by the publish preflight (gate 2) and re-usable by a
   future `manta library preview`.
2. **`directoryDigest`** — reuses `computeDirDigest`
   (`packages/manta-cli/src/library/dir-digest.ts:30`), the same primitive
   `verifyLibraryIntegrity` (`packages/manta-cli/src/library/integrity.ts`)
   checks at cast time. One shared algorithm end-to-end; no new hashing code.

**Determinism:** the tarball is built with `tar` portable mode, a fixed `mtime`
(`castOrigin.bundledAt`), and a sorted entry list, so two assembles of identical
artifacts are byte-identical. A test asserts this.

**Honest limit:** without signing, `checksum.json` catches *accidental*
corruption and shifts the tamper surface from "edit one payload silently" to
"rewrite the whole tarball" — but an attacker who controls the tarball can
recompute the checksums. It is integrity, not authenticity. Code signing is
not yet shipped because it needs a key registry / revocation / rotation /
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
prompter. The static scanner (`static-scanner.ts`) is a line-oriented regex
pass; it is cheap and defeated by obfuscation (a documented, accepted limit —
AST analysis via `acorn` is a possible future hardening). Shared modes are
`basedOn` built-ins and ship no JS, so the scan usually finds nothing, but it
ships now for forward-compat.

---

## 6. The auto-share trust boundary (build-yes / publish-no)

The single most important policy in `manta share`:

- **Bundle generation MAY be trigger-fired.** An auto-cast trigger may invoke
  `manta share <cast-id> --non-interactive` to produce a *local* reviewable
  artifact. Non-interactive mode forbids `$EDITOR`, forbids `--accept-warnings`
  (any warning is fatal), and requires the secret + static scans to pass clean.
  No network.
- **`--publish` is NEVER trigger-fired.** A trigger-fired cast publishing
  unreviewed code to a public registry violates informed consent. A human always
  pulls the publish trigger.

This is enforced at **two code levels** (never in skill text — skill text is a
soft prior, not a hard contract):

1. **CLI pre-commander guard** (`bin/manta.ts` `rejectPublishNonInteractiveEarly`):
   `--publish` + `--non-interactive` in argv → stderr message + `process.exitCode = 2`,
   *before* commander parses. A trigger literally cannot construct a publishing
   invocation. Same enforcement shape as the `install --no-hooks` guard.
2. **Command-layer refusal** (`commands/share.ts` `runShareCommand`):
   `publish === true && nonInteractive === true` → `ShareError('share_publish_blocked')`
   (exit 27), even when called programmatically (bypassing the CLI).

Two layers, both code, both tested.
