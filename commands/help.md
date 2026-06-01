---
name: manta:help
description: List the /manta:* commands and point at `manta doctor` and the docs.
argument-hint: ""
allowed-tools: []
---

Show the user this Manta command reference verbatim (it is static — do not call the binary):

**Manta — self-cloning Claude Code pattern. Available commands:**

- `/manta:cast` — spawn N clones for a mode (recon-swarm, forking-realities, bug-hunt, …) against a task. The core verb.
- `/manta:status` — print the orchestrator snapshot: live clones, their state, heartbeat age, locks, claims.
- `/manta:inspect` — deep-dive one clone by id: registry, contract, locks, recent events.
- `/manta:tail` — stream one clone's events live (Tier 3 real-time watch).
- `/manta:replay` — replay a finished cast's timeline: phased events and per-clone summaries.
- `/manta:promote` — merge the winning candidate from a forking-realities cast and graveyard the losers.
- `/manta:recover` — run one orchestrator cycle: detect zombies, reap stale locks/claims, write missing post-mortems.
- `/manta:kill` — mark a single clone DEAD by id and write its post-mortem.
- `/manta:abort` — emergency stop: mark every live clone DEAD and write a post-mortem for each.
- `/manta:doctor` — health-check your environment: Node, the `claude` CLI, the `manta-bus` MCP, git.
- `/manta:help` — this reference.

**Terminal-only commands** (power-user or destructive — run these in a terminal, no slash wrapper): `manta daemon`, `manta retask`, `manta feedback`, `manta install` / `manta uninstall`, `manta share`, `manta library`, `manta limit`, `manta cleanup`, `manta audit`.

**Check your setup:** run `/manta:doctor` (or `manta doctor` in a terminal) — it health-checks your Node version, the `claude` CLI, the `manta-bus` MCP registration, and whether cwd is a git repo.

**Docs:** getting started → `docs/user/getting-started.md`. Plugin internals → `docs/internals/plugin-packaging.md`.

**First time?** Try `/manta:cast recon-swarm --task "Map this codebase"`, then watch with `/manta:status`.
