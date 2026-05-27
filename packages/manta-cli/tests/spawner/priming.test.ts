import { describe, expect, it } from 'vitest';
import { buildInitialPrompt, buildPrimingText } from '../../src/spawner/priming.js';
import { makeSnapshotFor } from '../helpers/snapshotFixture.js';

describe('buildPrimingText', () => {
  const snap = makeSnapshotFor({
    cloneId: 'clone-A',
    castId: 'cast-X',
    mode: 'recon-swarm',
    task: 'map auth/* and billing/*',
  });

  it('embeds the manta-as-clone skill name', () => {
    expect(buildPrimingText(snap)).toContain('manta-as-clone');
  });

  it('embeds the clone_id (snake_case, on-the-wire form)', () => {
    expect(buildPrimingText(snap)).toContain('clone-A');
  });

  it('does NOT contain the dead `--snapshot` flag', () => {
    expect(buildPrimingText(snap)).not.toMatch(/--snapshot/);
  });

  it('points at MANTA_SNAPSHOT_PATH for the snapshot location', () => {
    expect(buildPrimingText(snap)).toContain('MANTA_SNAPSHOT_PATH');
  });

  it('instructs the clone to heartbeat before "Begin the work" (step 3 precedes step 5)', () => {
    const text = buildPrimingText(snap);
    const heartbeatPos = text.indexOf('manta.heartbeat');
    const beginWorkPos = text.indexOf('Begin the work');
    expect(heartbeatPos).toBeGreaterThanOrEqual(0);
    expect(beginWorkPos).toBeGreaterThan(heartbeatPos);
  });

  it('fits under 4 KiB so argv length is never a concern', () => {
    expect(buildPrimingText(snap).length).toBeLessThan(4096);
  });

  it('substitutes all three template tokens (no leftover {{...}} placeholders)', () => {
    const text = buildPrimingText(snap);
    expect(text).not.toMatch(/\{CLONE_ID\}|\{CAST_ID\}|\{MODE\}/);
    expect(text).toContain('cast-X');
    expect(text).toContain('recon-swarm');
  });

  it('declares heartbeat as implicit bus auto-touch (bug #9 structural fix, supersedes v0.0.2 per-turn rule)', () => {
    const text = buildPrimingText(snap);
    expect(text).toMatch(/Heartbeat is implicit \(bus auto-touch\)/);
    expect(text).toMatch(/heartbeatTimeoutMs/);
    expect(text).toMatch(/last bus interaction of any kind/);
    // Forbid the v0.0.2 per-turn formulation that proved unenforceable.
    expect(text).not.toMatch(/first.*tool call.*every.*assistant turn/i);
  });

  it('requires final commit of deliverables in the shutdown ordering (closes bug seed #4)', () => {
    const text = buildPrimingText(snap);
    expect(text).toMatch(/git add.*deliverables/);
    expect(text).toMatch(/manta-clone-clone-A: <one-line summary>/);
    expect(text).toMatch(/never push, the main pulls/);
  });
});

describe('buildPrimingText — {APPROACH_HINT_BLOCK} substitution (Phase 2a)', () => {
  it('expands {APPROACH_HINT_BLOCK} to "Approach hint: ..." when set', () => {
    const snap = makeSnapshotFor({
      cloneId: 'A',
      approachHint: 'use an index on orders.customer_id',
    });
    const text = buildPrimingText(snap);
    expect(text).toContain('Approach hint: use an index on orders.customer_id');
    expect(text).not.toContain('{APPROACH_HINT_BLOCK}');
  });

  it('removes the {APPROACH_HINT_BLOCK} placeholder entirely when approachHint is null', () => {
    const snap = makeSnapshotFor({ cloneId: 'A', approachHint: null });
    const text = buildPrimingText(snap);
    expect(text).not.toContain('{APPROACH_HINT_BLOCK}');
    expect(text).not.toMatch(/Approach hint:\s*$/m); // no dangling label
    // No orphan triple newline either — the substitution returns "" not "\n":
    expect(text).not.toMatch(/\n\n\nHeartbeat is implicit/);
  });

  it('substitutes hint independently per clone', () => {
    const a = buildPrimingText(makeSnapshotFor({ cloneId: 'A', approachHint: 'index' }));
    const b = buildPrimingText(makeSnapshotFor({ cloneId: 'B', approachHint: 'denormalize' }));
    expect(a).toContain('Approach hint: index');
    expect(b).toContain('Approach hint: denormalize');
    expect(a).not.toContain('denormalize');
  });
});

describe('buildPrimingText — self-certainty (Phase 2c)', () => {
  it('forking-realities priming includes self_certainty broadcast instruction', () => {
    const snap = makeSnapshotFor({ cloneId: 'A', mode: 'forking-realities' });
    const text = buildPrimingText(snap);
    expect(text).toContain('self_certainty');
    expect(text).toContain('score');
    expect(text).not.toContain('{SELF_CERTAINTY_BLOCK}');
  });

  it('recon-swarm priming does NOT include self_certainty', () => {
    const snap = makeSnapshotFor({ cloneId: 'A', mode: 'recon-swarm' });
    const text = buildPrimingText(snap);
    expect(text).not.toContain('self_certainty');
    expect(text).not.toContain('{SELF_CERTAINTY_BLOCK}');
  });
});

describe('buildPrimingText — bug-hunt mode (Phase 4)', () => {
  it('includes BUG_HUNT_BLOCK when mode is bug-hunt', () => {
    const snap = makeSnapshotFor({ cloneId: 'A', mode: 'bug-hunt' as 'recon-swarm' });
    const text = buildPrimingText(snap);
    expect(text).toContain('Investigation Protocol');
    expect(text).toContain('manta.read_broadcasts');
    expect(text).toContain('REPORT SECTIONS');
  });

  it('does not include SELF_CERTAINTY_BLOCK for bug-hunt', () => {
    const snap = makeSnapshotFor({ cloneId: 'A', mode: 'bug-hunt' as 'recon-swarm' });
    const text = buildPrimingText(snap);
    expect(text).not.toContain('self_certainty');
    expect(text).not.toContain('{SELF_CERTAINTY_BLOCK}');
  });

  it('includes approach_hint when provided', () => {
    const snap = makeSnapshotFor({
      cloneId: 'B',
      mode: 'bug-hunt' as 'recon-swarm',
      approachHint: 'focus on the database layer',
    });
    const text = buildPrimingText(snap);
    expect(text).toContain('Approach hint: focus on the database layer');
  });
});

describe('buildInitialPrompt', () => {
  const snap = makeSnapshotFor({ cloneId: 'clone-A', task: 'map auth/* and billing/*' });

  it('includes the task description verbatim', () => {
    expect(buildInitialPrompt(snap)).toContain('map auth/* and billing/*');
  });

  it('does not embed the full snapshot inline (must reference env var)', () => {
    expect(buildInitialPrompt(snap).length).toBeLessThan(2_000);
  });
});
