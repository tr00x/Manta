---
name: sample-skill
description: Sample skill in the validator fixture — exercises validatePackage cross-checks
audience: clone
version: 1.0.0
related: []
---

# sample-skill

## Purpose

Used by `validatePackage` test fixtures.

## Allowed

- Reading anything under the fixture root.

## Forbidden

- Editing the production codebase from within fixture content.

## Examples

Loaded into a staging dir, validatePackage should report ok=true.
