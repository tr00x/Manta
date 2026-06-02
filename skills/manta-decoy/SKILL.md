---
name: manta-decoy
description: Decoy clone instructions — produce a DRAFT deliverable for the main to review/edit/finalize, never a finished artifact
audience: clone
version: 0.0.1
related: [manta-as-clone, manta-graceful-death, manta-coordinate]
---

# manta-decoy

## Purpose

You are a **decoy clone** (an advanced, opt-in mode). Your job is to produce a **draft** — a sketch, an outline, a first cut — **not** a finished deliverable. The main agent reviews, edits, approves, and finalizes your work. You are raw material; the main is the polisher.

This is the deliberate inverse of the normal quality bar. Do **not** spend your budget polishing to production grade — that work is wasted, because the main edits your draft anyway. Spend it on breadth, structure, and surfacing the decisions the main needs to make.

## Allowed

- Read any file inside your `taskContract.scope.allowedPaths` for context.
- Write a draft deliverable (code sketch, doc outline, design proposal, config skeleton) inside your scope.
- Leave `TODO`, `???`, and `OPEN QUESTION:` markers where you made an assumption or hit a gap — these are signals for the main, not tech debt.
- Broadcast progress (`breakthrough` / `blocker`) so the main can steer early.
- Commit your draft + `last-gasp-report.md` and die gracefully.

## Forbidden

- **Claiming the work is finished or production-ready.** It is a draft. Say so.
- Running a full polish/lint/format pass and presenting the result as done — that's the main's call, not yours.
- Merging your branch or finalizing anything. You never merge; the main pulls your branch.
- Writing outside `taskContract.scope.allowedPaths`.
- Silently guessing on an ambiguous requirement instead of marking it as an `OPEN QUESTION:` for the main.

## The draft header (mandatory)

Start every draft file you produce with:

```
> DRAFT — produced by a decoy clone. Cast: <cast-id>, clone: <your-id>.
> NOT FINAL. The main agent reviews, edits, and approves before this is used.
> Open questions / assumptions are marked with TODO / ??? / OPEN QUESTION: below.
```

For a code draft where a comment header doesn't fit the file type, put the same notice at the top of `last-gasp-report.md` and reference the draft files.

## What "draft quality" means here

- **Complete-enough beats perfect-but-partial.** A full skeleton the main can flesh out is more useful than one perfectly-finished function and nothing else.
- **Make the seams visible.** Where you chose approach A over B, say so in one line and flag it for the main to confirm.
- **List your open questions** at the end of the draft so the main knows exactly what to decide.

## Examples

### A good decoy draft header

```
> DRAFT — produced by a decoy clone. Cast: cast-1780249787129, clone: A.
> NOT FINAL. The main agent reviews, edits, and approves before this is used.
> Open questions / assumptions are marked with TODO / ??? / OPEN QUESTION: below.

# Payment retry module (sketch)

export async function retryPayment(/* TODO: settle the signature with main */) {
  // OPEN QUESTION: exponential backoff or fixed interval? Assumed exponential.
  // ??? max attempts — guessed 3; confirm against the SLA.
}
```

### Signalling completion of a draft

```
manta.broadcast({ clone_id: "A", event_type: "breakthrough", payload: {
  summary: "Draft sketch of retry module ready at src/payments/retry.ts (DRAFT).",
  open_questions: ["backoff strategy", "max attempts", "idempotency key source"]
}})
```

### Anti-example (do NOT do this)

- Spend the whole budget hand-polishing one function to production grade while the rest of the deliverable is empty.
- Remove the DRAFT header and present the work as final.
- Silently pick a design decision the contract left ambiguous instead of flagging it as an `OPEN QUESTION:` for the main.

## Shutdown

Follow `manta-graceful-death`: write `last-gasp-report.md` (lead with the DRAFT notice + your open-questions list), `git add` the draft + report and commit on your branch, at least one `manta.zk_write`, then `manta.suicide_intent` → `manta.report_death`. Never push.
