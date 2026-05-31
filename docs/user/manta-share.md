# `manta share` — package a finalised cast into a publishable bundle

`manta share <cast-id>` turns one finalised cast's on-disk state into a
publishable `*.manta-pkg.tar.gz` bundle: a sanitized, checksummed, schema-valid
package that anyone can install with [`manta install`](./manta-library.md).

It is the *producer* side of the Manta Library. `manta install` is
the consumer; `manta share` is what you run after a cast has shipped something
worth sharing — a new mode, skill, command, or template.

> **Trust model in one sentence:** a Manta bundle is a user-vetted dev tool,
> like a VS Code extension or an `npx` script. We make the contents inspectable,
> we statically scan for obviously hostile patterns and for secrets, but
> **publishing or installing a bundle is equivalent to running an untrusted
> shell script** — review the bundle, publish/install only from authors you
> trust. This is **MVTS-7**: informed consent + best-effort static analysis,
> explicitly *not* a security boundary.

---

## Quick start

```bash
# Build a local bundle from cast cast-1780023574334, clone B is the winner.
manta share cast-1780023574334 \
  --clone B \
  --name @my-scope/my-mode \
  --pkg-version 1.0.0 \
  --author "Jane Dev" \
  --license MIT \
  --out ./dist

# → ./dist/my-scope-my-mode-1.0.0.manta-pkg.tar.gz

# Install it back (round-trip):
manta install ./dist/my-scope-my-mode-1.0.0.manta-pkg.tar.gz
```

To publish to npm (interactive only — see the publish section):

```bash
manta share cast-1780023574334 --clone B \
  --name @my-scope/my-mode --pkg-version 1.0.0 \
  --author "Jane Dev" --license MIT --publish
```

---

## Flags

| Flag | Required | Default | Meaning |
|---|---|---|---|
| `<castId>` | yes | — | Positional. The finalised cast to bundle. |
| `--name <@scope/name>` | yes | — | npm package name. No default — the npm scope must be opt-in; the runner refuses to invent one. |
| `--pkg-version <semver>` | yes | — | Package version. No auto-bump — the author decides. Named `--pkg-version` (not `--version`) so it does not collide with the global `-V`/`--version` flag. |
| `--clone <id>` | no | merge-review winner | Winning clone to bundle. Overrides the merge-review verdict. |
| `--out <dir>` | no | `.` | Output directory for the `.tar.gz`. |
| `--description <text>` | no | first "Reason" line of the winner's post-mortem | Package description (truncated to 280 chars). |
| `--author <text>` | no | — | Package author. If absent and not derivable, errors (exit 25). |
| `--license <SPDX>` | no | — | SPDX license id. If absent and not derivable, errors (exit 26) — a license is a legal claim you must assert explicitly. |
| `--manta-version-compat <range>` | no | caret-pin of the current manta runtime | Compatible manta version range. |
| `--no-edit` | no | editor opens | Skip the `$EDITOR` README pass. |
| `--accept-warnings` | no | warnings block | Proceed despite non-fatal sanitization warnings (interactive only). |
| `--non-interactive` | no | interactive | CI/trigger mode: no `$EDITOR`, **any warning is fatal**, and `--publish` is structurally forbidden. |
| `--publish` | no | local only | Publish the bundle to npm behind the MVTS-7 gates (interactive only). |
| `--max-bytes <n>` | no | `5242880` (5 MB) | Refuse publish if the tarball exceeds this many bytes (oversize signals a packaging mistake). |

---

## Which clone gets shipped?

The cast manifest records the roster but not a "winner". `manta share` resolves
the shippable clone in this order:

1. **`--clone <id>`** — use that clone's worktree branch.
2. Else, if **`docs/merge-reviews/cast-<id>.md`** exists (the forking-realities
   verdict written by the post-cast ceremony), parse the winning clone id from
   its verdict.
3. Else — **error `share_no_winner` (exit 21)**: recon-swarm casts produce no
   single shippable mode. Pass `--clone <id>` to pick one, or share a
   forking-realities / implementation cast.

---

## What gets sanitized

`manta share` reads cast state that other commands already wrote (read-only) and
runs every artifact through a **default-deny** sanitizer before a single byte
leaves your repo. Default-deny means: unenumerated fields are *dropped*, not
passed through, so a new field added to a source schema after this ships cannot
silently leak.

| Artifact | What is stripped / redacted |
|---|---|
| **Snapshot** | Drops `parentSessionId`, `parentPid`, `budget`, `sessionId`, and the raw `recentMessages` transcript (highest-risk). Redacts `parentWorktree` → `<worktree>` and `cloneWorktree` → `<worktree>/clone-<id>`. Relativises `openFiles[].path`; drops any path outside the repo. |
| **Task contract** | Secret-scans `task` and `approachHint` (**fatal** on match). Relativises `scope.allowedPaths` / `forbiddenPaths`; drops out-of-repo paths. |
| **Post-mortem markdown** | Redacts the `Worktree:` header to `<worktree>`, drops the `Parent PID:` line, rewrites epoch-ms timestamps to relative offsets. The `## Metadata` and `## Event timeline` blocks are already filtered to a safe field set at render time, so they pass through intact. Full-text secret scan (fatal) + stray-path warnings. |
| **ZK notes** | Rewrites `created_at` to the bundle ISO time. Secret-scans the title (fatal) and body (fatal). Path references in the body **warn** but are not auto-redacted (prose may be inseparable from the reference — you accept the warning). |
| **Event timeline** | Re-applies the per-type allowlist projection (same one the post-mortem renderer uses) over the raw `events.jsonl`, filtered to the winning clone, with wallclock times relativised. Unknown event types collapse to `<payload omitted>`. |
| **Worktree diff** | Secret-scans the full diff (**fatal** on match). This is the rule most likely to fire on a real credential. |

### Warning vs fatal

- **Fatal** = a secret-format match (AWS key, OpenAI/Anthropic key, GitHub PAT,
  Slack token, Google API key, private-key header, JWT, or a `KEY=<longvalue>`
  assignment). There is **no** `--accept` for secrets. The bundle is refused
  (exit 22). Fix the source, re-run.
- **Warning** = a path that was redacted/relativised, a dropped transcript, a
  dropped out-of-repo file, an unredacted path in ZK prose. Interactive runs
  block on warnings until you pass `--accept-warnings`. `--non-interactive` runs
  treat **any** warning as fatal (trigger-mode must be clean).

The secret scanner is **best-effort** (§0): false negatives are possible. It is
not a guarantee, it is a cheap first pass. The final check is the human reading
the bundle before publish.

---

## `--publish` — publishing to npm

`--publish` is **interactive only**. A trigger-fired cast may build a local
bundle (`--non-interactive`) but can **never** publish — publishing unreviewed
code to a public registry violates informed consent. `--publish` combined with
`--non-interactive` is rejected before the command even starts (exit 2).

Publishing runs the **MVTS-7 gates**, in this order, each one short-circuiting
the rest on failure:

1. **Static scan** — any bundled JS is scanned for malicious patterns; a hard
   block (e.g. `child_process.execSync`, reading `~/.aws`) refuses the publish.
   (Manta-built bundles ship no JS, so this is usually a no-op.)
2. **Checksum re-verify** — the bundle's `checksum.json` is recomputed and
   compared; any mismatch (tamper/corruption) refuses.
3. **npm login** — `npm whoami`; not logged in refuses.
4. **Scope ownership** — you must have publish rights under the package's
   `@scope`.
5. **Two human confirmations** — first *"publish `<name>@<version>` to npm as
   `<you>`?"*, then *"this is PUBLIC and PERMANENT — npm does not allow unpublish
   after 72h. Confirm?"*. Either decline aborts.
6. **Size cap** — refuse if the tarball exceeds `--max-bytes` (default 5 MB).

Only after all six pass does `manta share` run `npm publish --access public`.
**A publish failure never deletes your local bundle** — the tarball survives for
re-inspection.

> **Publishing is PUBLIC and PERMANENT.** It is exactly like publishing any npm
> package: the world can install it, and npm does not allow unpublish after 72
> hours. Treat it accordingly.

---

## Exit codes

| Exit | Code | Meaning |
|---|---|---|
| 2 | (CLI guard) | `--publish` combined with `--non-interactive` (rejected before commander parses). |
| 20 | `share_cast_not_found` | The cast id has no manifest on disk. |
| 21 | `share_no_winner` | No `--clone` and no parseable merge-review winner. |
| 22 | `share_secret_detected` | A secret-format match in task text, approach hint, ZK note, post-mortem body, or worktree diff. |
| 23 | `share_nothing_to_ship` | The winning clone produced no shippable contribution (no skill/mode/command/template). |
| 24 | `share_warnings_unaccepted` | Non-fatal warnings exist and were not accepted (`--accept-warnings`), or `--non-interactive` saw any warning. |
| 25 | `share_author_missing` | Author could not be derived; pass `--author`. |
| 26 | `share_license_missing` | License could not be derived; pass `--license`. |
| 27 | `share_publish_blocked` | A publish gate failed (scan/checksum/login/scope/decline/size), or `--publish` was requested with `--non-interactive` (command-layer defense-in-depth). |

---

## What is *not* shipped (deferred)

| Surface | Status | Why |
|---|---|---|
| Code signing / signature verification | Not yet shipped | No key registry / revocation / rotation infra exists; "optional signing" without it is theater. |
| Author reputation (install counts, time-to-issue) | Not yet shipped | Needs a telemetry backend + a privacy story we do not have. |
| Runtime sandbox for cast-time mode execution | Indefinite | The dispatched clone has full shell access by design; sandboxing only the dispatcher is theater. |
| Auto-**publish** (a trigger fires `npm publish`) | **Never (policy)** | Violates informed consent. A trigger may build a bundle; a human always pulls the publish trigger. |

---

## See also

- [`manta install` / Manta Library](./manta-library.md) — the consumer side this
  bundle feeds.
- [`docs/internals/share-sanitization.md`](../internals/share-sanitization.md) —
  the architecture of the sanitization pipeline and the integrity model.
