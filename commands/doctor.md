---
name: manta:doctor
description: Health-check your Manta environment — Node, the claude CLI, the bus MCP registration, git, and charges.
argument-hint: ""
allowed-tools: Bash
---

Run Manta's environment health check via the bundled binary.

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/bin/manta.cjs" doctor $ARGUMENTS
```

This is the setup diagnostic referenced in `/manta:help`: it checks your Node version, whether the `claude` CLI is on PATH, the `manta-bus` MCP registration, that cwd is a git repo, and your charges/cooldown state. Relay the report as-is; a non-zero exit means at least one check failed — surface the failing line so the user can fix it.
