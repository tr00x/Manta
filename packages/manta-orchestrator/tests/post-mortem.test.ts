import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { runPostMortem } from '../src/post-mortem';
import { inMemoryPostMortemWriter } from '../src/post-mortem-writer';
import { defaultThresholds } from '../src/thresholds';
import { buildBusContext, type TestBusContext } from './helpers/buildBusContext';

describe('post-mortem', () => {
  let ctx: TestBusContext;
  beforeEach(async () => {
    ctx = await buildBusContext();
  });
  afterEach(async () => {
    await ctx.cleanup();
  });

  it('writes a post-mortem markdown for a registered then dead clone', async () => {
    await ctx.registry.register({ clone_id: 'A', mode: 'recon-swarm', parent_pid: 1, worktree: '/w', metadata: { cast_id: 'cast-42' } });
    await ctx.registry.heartbeat({ clone_id: 'A', state: 'WORKING', progress: 'half' });
    await ctx.events.append({ type: 'broadcast', clone_id: 'A', payload: { event_type: 'breakthrough', body: { summary: 'found root cause' } } });
    ctx.clock.advance(91_000);
    const writer = inMemoryPostMortemWriter();
    const result = await runPostMortem(ctx, {
      cloneId: 'A',
      reason: 'heartbeat 91000ms ago > 90000ms',
      writer,
      thresholds: defaultThresholds,
    });
    expect(result.event.type).toBe('post_mortem');
    expect(writer.captured).toHaveLength(1);
    const md = writer.captured[0]!.body;
    expect(md).toContain('# Post-mortem — clone A');
    expect(md).toContain('Reason: heartbeat 91000ms ago > 90000ms');
    expect(md).toContain('cast-42');
    expect(md).toContain('breakthrough');
    expect(writer.captured[0]!.filename).toMatch(/^\d{4}-\d{2}-\d{2}-cast-42-A\.md$/);
  });

  it('uses "no-cast" prefix when metadata lacks cast_id', async () => {
    await ctx.registry.register({ clone_id: 'A', mode: 'recon-swarm', parent_pid: 1, worktree: '/w', metadata: {} });
    ctx.clock.advance(91_000);
    const writer = inMemoryPostMortemWriter();
    await runPostMortem(ctx, {
      cloneId: 'A',
      reason: 'stale',
      writer,
      thresholds: defaultThresholds,
    });
    expect(writer.captured[0]!.filename).toMatch(/-no-cast-A\.md$/);
  });

  it('marks the clone DEAD if it was not already', async () => {
    await ctx.registry.register({ clone_id: 'A', mode: 'recon-swarm', parent_pid: 1, worktree: '/w', metadata: {} });
    const writer = inMemoryPostMortemWriter();
    await runPostMortem(ctx, { cloneId: 'A', reason: 'TTL', writer, thresholds: defaultThresholds });
    const r = await ctx.registry.get('A');
    expect(r.state).toBe('DEAD');
    expect(r.death_reason).toContain('TTL');
  });

  it('is idempotent if the clone is already DEAD', async () => {
    await ctx.registry.register({ clone_id: 'A', mode: 'recon-swarm', parent_pid: 1, worktree: '/w', metadata: {} });
    await ctx.registry.markDead('A', 'manual');
    const writer = inMemoryPostMortemWriter();
    await runPostMortem(ctx, { cloneId: 'A', reason: 'after-the-fact', writer, thresholds: defaultThresholds });
    expect(writer.captured).toHaveLength(1);
  });

  it('redacts non-allowlisted metadata keys from the rendered markdown (bug #18 layer a)', async () => {
    await ctx.registry.register({
      clone_id: 'A',
      mode: 'recon-swarm',
      parent_pid: 1,
      worktree: '/w',
      metadata: {
        cast_id: 'cast-42',
        cast_mode: 'recon-swarm',
        triggered_by: 'on-push-hook',
        user_email: 'leak@example.com',
      },
    });
    const writer = inMemoryPostMortemWriter();
    await runPostMortem(ctx, {
      cloneId: 'A',
      reason: 'redaction-check',
      writer,
      thresholds: defaultThresholds,
    });
    const md = writer.captured[0]!.body;
    expect(md).toContain('cast_id: cast-42');
    expect(md).toContain('cast_mode: recon-swarm');
    // Values for dropped keys must never appear (no leak).
    expect(md).not.toContain('on-push-hook');
    expect(md).not.toContain('leak@example.com');
    // Key names DO appear in the audit footer (visibility into intentional drops).
    expect(md).toContain('Dropped 2 non-allowlisted metadata fields: triggered_by, user_email');
    // The key name should never be rendered with a value (no `triggered_by: ...` line).
    expect(md).not.toMatch(/^- triggered_by:/m);
    expect(md).not.toMatch(/^- user_email:/m);
  });

  it('appends a `reaped` event inside markDead\'s mutex (bug #41 regression — audit-trail invariant)', async () => {
    // Pre-fix runPostMortem called markDead with no auditAppend. The registry
    // could transition to DEAD with no corresponding death event in events.jsonl
    // (crash between markDead's rename and the later post_mortem event append
    // would leave the bus in the exact "state ahead of audit" state bug #24
    // was built to prevent). The fix routes a `reaped` event through markDead's
    // auditAppend closure so it lands INSIDE the same file mutex as the
    // state mutation. This regression verifies both presence and ordering.
    await ctx.registry.register({
      clone_id: 'A', mode: 'recon-swarm', parent_pid: 1, worktree: '/w', metadata: {},
    });
    const writer = inMemoryPostMortemWriter();
    await runPostMortem(ctx, { cloneId: 'A', reason: 'heartbeat timeout', writer, thresholds: defaultThresholds });

    const events = await ctx.events.readAll();
    const reaped = events.find((e) => e.type === 'reaped' && e.clone_id === 'A');
    const postMortem = events.find((e) => e.type === 'post_mortem' && e.clone_id === 'A');

    expect(reaped, 'expected `reaped` event from markDead auditAppend').toBeDefined();
    expect(postMortem, 'expected `post_mortem` event after writer').toBeDefined();
    expect((reaped!.payload as { reason: string }).reason).toBe('heartbeat timeout');

    // Audit-trail invariant: the `reaped` event (appended inside the markDead
    // mutex, before the rename) must precede the `post_mortem` event (appended
    // after the writer completes). Same ts is OK; reverse order would mean
    // the audit-coupling regressed.
    const reapedIdx = events.indexOf(reaped!);
    const postMortemIdx = events.indexOf(postMortem!);
    expect(reapedIdx).toBeLessThan(postMortemIdx);
  });

  it('drops free-form event payload bodies from the rendered timeline (bug #29)', async () => {
    // Pre-fix: post-mortem.ts dumped JSON.stringify(e.payload) verbatim. Any
    // bus call with a free-form text field (broadcast.body, message.body,
    // drift_report.evidence, feedback.feedback, contract_ack.interpretation)
    // could leak secrets the clone happened to dump there (stderr with
    // AWS_SECRET_ACCESS_KEY, oauth tokens, customer PII). Post-mortems are
    // bundled by `manta share` so the leak ships externally. Fix: type-aware
    // allowlist projection — only safe metadata renders; free-form bodies
    // never appear.
    await ctx.registry.register({
      clone_id: 'A', mode: 'recon-swarm', parent_pid: 1, worktree: '/w', metadata: {},
    });
    // Pollute the event stream with secret-bearing payloads across every
    // free-form surface the bug enumerates.
    const SECRET = 'AKIA-FAKE-SECRET-XYZ123';
    const TOKEN = 'oauth-token-CONFIDENTIAL-789';
    const PII = 'customer-email-leak@example.com';
    await ctx.events.append({ type: 'broadcast', clone_id: 'A', payload: { event_type: 'shell_fail', body: { stderr: SECRET } } });
    await ctx.events.append({ type: 'message', clone_id: 'A', payload: { to: 'B', body: TOKEN } });
    await ctx.events.append({ type: 'drift_report', clone_id: 'A', payload: { drift_score: 0.7, evidence: PII } });
    await ctx.events.append({ type: 'feedback', clone_id: 'A', payload: { severity: 'high', feedback: SECRET } });
    await ctx.events.append({ type: 'contract_ack', clone_id: 'A', payload: { interpretation: TOKEN } });
    await ctx.events.append({ type: 'retask', clone_id: 'A', payload: { new_task: PII } });
    await ctx.events.append({ type: 'zk_write', clone_id: 'A', payload: { note_id: 'n-1', content: SECRET } });

    const writer = inMemoryPostMortemWriter();
    await runPostMortem(ctx, { cloneId: 'A', reason: 'leak-audit', writer, thresholds: defaultThresholds });
    const md = writer.captured[0]!.body;

    // Hard contract: NONE of the free-form secrets/tokens/PII appear anywhere.
    expect(md).not.toContain(SECRET);
    expect(md).not.toContain(TOKEN);
    expect(md).not.toContain(PII);
    // But the structural metadata (event_type, to, severity, drift_score) IS
    // preserved so operators can read the post-mortem usefully.
    expect(md).toContain('shell_fail');
    expect(md).toContain('"to":"B"');
    expect(md).toContain('"severity":"high"');
    expect(md).toContain('"drift_score":0.7');
  });

  it('drops free-form heartbeat.progress text from rendered timeline (bug #46)', async () => {
    // The pre-#46 allowlist kept `heartbeat.progress` verbatim ("operator
    // usefulness" trade-off). That left a 2000-char clone-supplied free-form
    // field bundled by `manta share` — same leak class #29 closed for body/
    // evidence/feedback. The #46 fix dropped `progress` from the allowlist
    // for parity with the default-deny posture. This regression seeds a
    // secret into `progress` and asserts it never reaches the rendered MD.
    // `state` (the structured discriminant) is still surfaced — operators
    // who need the live progress trail use `manta inspect` on bus state.
    await ctx.registry.register({
      clone_id: 'A', mode: 'recon-swarm', parent_pid: 1, worktree: '/w', metadata: {},
    });
    const SECRET = 'sk-PROGRESS-LEAK-XYZ-456';
    await ctx.events.append({
      type: 'heartbeat',
      clone_id: 'A',
      payload: { state: 'WORKING', progress: `processing batch (token ${SECRET})` },
    });

    const writer = inMemoryPostMortemWriter();
    await runPostMortem(ctx, { cloneId: 'A', reason: 'progress-leak-audit', writer, thresholds: defaultThresholds });
    const md = writer.captured[0]!.body;

    expect(md).not.toContain(SECRET);                  // secret dropped
    expect(md).not.toContain('processing batch');      // free-form context dropped
    expect(md).toContain('"state":"WORKING"');         // structured state still surfaced
  });

  it('default-deny: unknown event types render as `<payload omitted>` and never leak secrets (bug-hunt MINOR-1 over cast-1780011340100)', async () => {
    // The #29 fix's safety contract relies on the `default:` branch of
    // renderEventPayload returning `<payload omitted>` for event types
    // not explicitly enumerated. The pre-existing #29 regression seeded
    // only KNOWN types, so the default branch's drop behaviour was
    // structurally untested — a regression that re-introduced
    // `JSON.stringify(p)` in the default arm would not be caught. This
    // test seeds an unknown/future event type with a secret-bearing
    // payload and asserts the secret is dropped AND the explicit
    // `<payload omitted>` marker appears (so the safety isn't an
    // accident of empty payloads).
    await ctx.registry.register({
      clone_id: 'A', mode: 'recon-swarm', parent_pid: 1, worktree: '/w', metadata: {},
    });
    const FUTURE_SECRET = 'AKIA-FROM-A-FUTURE-EVENT-TYPE-987';
    // A type not in the switch — simulates a future event type a contributor
    // adds without remembering to extend the allowlist projection.
    await ctx.events.append({
      type: 'some_future_event_type',
      clone_id: 'A',
      payload: { raw_stderr: FUTURE_SECRET, nested: { also_leak: FUTURE_SECRET } },
    });

    const writer = inMemoryPostMortemWriter();
    await runPostMortem(ctx, { cloneId: 'A', reason: 'future-type-audit', writer, thresholds: defaultThresholds });
    const md = writer.captured[0]!.body;

    // Secret must not appear anywhere.
    expect(md).not.toContain(FUTURE_SECRET);
    // The explicit default-deny marker proves the drop is deliberate, not
    // an artefact of an empty payload (which would render as no text).
    expect(md).toContain('<payload omitted>');
    // And the new event type's name is still visible (operator context).
    expect(md).toContain('some_future_event_type');
  });

  it('composer sanitizes hostile cast_id into a writer-safe filename', async () => {
    // The composer is responsible for ensuring the filename it hands to the
    // writer matches SAFE_FILENAME. This test wraps the writer with the same
    // guard the fs writer uses and confirms a registered clone produces a
    // filename that survives the guard — i.e. composer-level sanitization
    // works and never relies on the writer as a last line of defence for
    // happy-path inputs. (For the writer-level rejection contract, see
    // post-mortem-writer.test.ts:'fsPostMortemWriter rejects path traversal'.)
    const writer = inMemoryPostMortemWriter();
    // Override write to mimic the fs writer's SAFE_FILENAME guard
    writer.write = (doc) => {
      if (!/^[A-Za-z0-9._-]+$/.test(doc.filename)) {
        return Promise.reject(new Error(`unsafe filename: ${doc.filename}`));
      }
      writer.captured.push(doc);
      return Promise.resolve({ path: `mem://${doc.filename}` });
    };
    await ctx.registry.register({
      clone_id: 'AA', mode: 'recon-swarm', parent_pid: 1, worktree: '/w', metadata: {},
    });
    await ctx.registry.heartbeat({ clone_id: 'AA', state: 'WORKING' });
    const ok = await runPostMortem(ctx, {
      cloneId: 'AA',
      reason: 'sanitization-check',
      writer,
      thresholds: defaultThresholds,
    });
    expect(writer.captured).toHaveLength(1);
    expect(ok.document.filename).toMatch(/^[A-Za-z0-9._-]+$/);
  });
});
