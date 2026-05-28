---
name: e2e-sample-skill
description: Skill carried by the e2e library fixture — exercises validator cross-checks during install
audience: clone
version: 0.1.0
related: []
---

# e2e-sample-skill

## Purpose

Skill carried by the Phase 7a end-to-end test's library package fixture. It
exists to satisfy `validatePackage`'s manifest-vs-disk cross-check during the
install round-trip — the fixture's `manta-package.json` declares this skill
under `contributes.skills`, so the directory has to exist with a valid
SKILL.md.

## Allowed

- Loaded purely as a fixture; not executed by any real clone.

## Forbidden

- Do not invoke at runtime — this is test material, not production guidance.

## Examples

The e2e test runs `manta install <fixture.tgz>` against this directory and
then exercises the library cast path; the skill body itself does not need to
do anything beyond passing schema validation.
