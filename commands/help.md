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
- `/manta:cost` — show Manta spend: per-cast cost and accumulated charges against the budget.
- `/manta:promote` — merge the winning candidate from a forking-realities cast and graveyard the losers.
- `/manta:recover` — run one orchestrator cycle: detect zombies, reap stale locks/claims, write missing post-mortems.
- `/manta:kill` — mark a single clone DEAD by id and write its post-mortem.
- `/manta:abort` — emergency stop: mark every live clone DEAD and write a post-mortem for each.
- `/manta:help` — this reference.

**Check your setup:** run `manta doctor` in a terminal — it health-checks your Node version, the `claude` CLI, the `manta-bus` MCP registration, whether cwd is a git repo, and your charges/cooldown state.

**Docs:** getting started → `docs/user/getting-started.md`. Plugin internals → `docs/internals/plugin-packaging.md`.

**First time?** Try `/manta:cast recon-swarm --task "Map this codebase"`, then watch with `/manta:status`.
