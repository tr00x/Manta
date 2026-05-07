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

describe('buildInitialPrompt', () => {
  const snap = makeSnapshotFor({ cloneId: 'clone-A', task: 'map auth/* and billing/*' });

  it('includes the task description verbatim', () => {
    expect(buildInitialPrompt(snap)).toContain('map auth/* and billing/*');
  });

  it('does not embed the full snapshot inline (must reference env var)', () => {
    expect(buildInitialPrompt(snap).length).toBeLessThan(2_000);
  });
});
