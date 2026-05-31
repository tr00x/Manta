---
name: manta:cast
description: Spawn N Manta clones for a mode (recon-swarm, forking-realities, …) against a task. The core verb.
argument-hint: <mode> --task "<description>" [--clones N]
allowed-tools: Bash
---

Run the Manta CLI `cast` subcommand with the user's arguments via the bundled binary, then report the result.

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/bin/manta.cjs" cast $ARGUMENTS
```

The CLI is the single code path — this command does not re-implement any logic. After it returns:

- Tell the user the **cast id** the CLI printed.
- Suggest `/manta:status` to watch the clones and `/manta:abort` to stop them early.
- If the CLI exited non-zero (e.g. `invalid_input`, budget rejection), surface its stderr verbatim — do not paraphrase or retry with guessed flags.

Modes: `recon-swarm`, `bug-hunt`, `refactor-wave`, `forking-realities`, `pair-programming`, `test-storm`, `documentation-chase`, plus the opt-in `council` / `decoy`. Run with no mode to see the CLI's usage.
