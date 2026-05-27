import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FakeClock } from '../../src/clock';
import { busPaths } from '../../src/state/paths';
import { Registry } from '../../src/state/registry';
import { EventsLog } from '../../src/state/events';
import { makeTmpRoot } from '../helpers/tmpRoot';
import { createLifecycleHandlers } from '../../src/tools/lifecycle';
import { BusValidationError } from '../../src/errors';

describe('lifecycle handlers', () => {
  let root: string;
  let cleanup: () => Promise<void>;
  let clock: FakeClock;
  let handlers: ReturnType<typeof createLifecycleHandlers>;

  beforeEach(async () => {
    ({ root, cleanup } = await makeTmpRoot());
    clock = new FakeClock(1_000_000);
    const paths = busPaths(root);
    handlers = createLifecycleHandlers({
      registry: new Registry(paths, clock),
      events: new EventsLog(paths, clock),
    });
  });
  afterEach(async () => {
    await cleanup();
  });

  it('register validates input and stores the clone', async () => {
    const result = await handlers.register({
      clone_id: 'A',
      mode: 'recon-swarm',
      parent_pid: 1234,
      worktree: '/w',
      metadata: {},
    });
    expect(result.clone.clone_id).toBe('A');
    expect(result.event.type).toBe('register');
  });

  it('register rejects invalid input via BusValidationError', async () => {
    await expect(
      handlers.register({ clone_id: 'bad id with spaces' }),
    ).rejects.toBeInstanceOf(BusValidationError);
  });

  it('heartbeat updates registry and emits event', async () => {
    await handlers.register({
      clone_id: 'A',
      mode: 'recon-swarm',
      parent_pid: 1,
      worktree: '/w',
      metadata: {},
    });
    clock.advance(2_000);
    const result = await handlers.heartbeat({ clone_id: 'A', state: 'WORKING' });
    expect(result.clone.last_heartbeat_at).toBe(1_002_000);
    expect(result.event.type).toBe('heartbeat');
  });

  it('heartbeat passes progress through into the event payload', async () => {
    await handlers.register({
      clone_id: 'A',
      mode: 'recon-swarm',
      parent_pid: 1,
      worktree: '/w',
      metadata: {},
    });
    const result = await handlers.heartbeat({
      clone_id: 'A',
      state: 'WORKING',
      progress: 'mapping routes',
    });
    expect(result.event.payload).toEqual({ state: 'WORKING', progress: 'mapping routes' });
  });

  it('suicideIntent records the intent without changing state to DEAD', async () => {
    await handlers.register({
      clone_id: 'A',
      mode: 'recon-swarm',
      parent_pid: 1,
      worktree: '/w',
      metadata: {},
    });
    const result = await handlers.suicideIntent({ clone_id: 'A', reason: 'drift' });
    expect(result.event.type).toBe('suicide_intent');
    expect(result.clone.state).toBe('WINDING_DOWN');
  });

  it('suicideIntent rejects empty reason', async () => {
    await expect(
      handlers.suicideIntent({ clone_id: 'A', reason: '' }),
    ).rejects.toBeInstanceOf(BusValidationError);
  });

  it('reportDeath transitions to DEAD and stores last-gasp path', async () => {
    await handlers.register({
      clone_id: 'A',
      mode: 'recon-swarm',
      parent_pid: 1,
      worktree: '/w',
      metadata: {},
    });
    const result = await handlers.reportDeath({
      clone_id: 'A',
      last_gasp_report_path: '/tmp/r.json',
    });
    expect(result.clone.state).toBe('DEAD');
    expect(result.event.type).toBe('death');
    expect(result.clone.death_reason).toContain('/tmp/r.json');
  });

  it('reportDeath rejects unknown clone via not-found', async () => {
    await expect(
      handlers.reportDeath({ clone_id: 'GHOST', last_gasp_report_path: '/tmp/x.json' }),
    ).rejects.toThrow(/GHOST/);
  });

  describe('retask handler', () => {
    it('validates input and calls registry.retask', async () => {
      await handlers.register({
        clone_id: 'D',
        mode: 'recon-swarm',
        parent_pid: 1,
        worktree: '/w',
        metadata: {},
      });
      await handlers.heartbeat({ clone_id: 'D', state: 'WORKING' });
      await handlers.heartbeat({ clone_id: 'D', state: 'IDLE' });

      const result = await handlers.retask({
        clone_id: 'D',
        new_task: 'implement feature X',
      });
      expect(result.clone.state).toBe('WORKING');
      expect(result.clone.progress).toContain('retasked');
      expect(result.event.type).toBe('retask');
    });

    it('rejects invalid clone state', async () => {
      await handlers.register({
        clone_id: 'E',
        mode: 'recon-swarm',
        parent_pid: 1,
        worktree: '/w',
        metadata: {},
      });
      await handlers.heartbeat({ clone_id: 'E', state: 'WORKING' });

      await expect(
        handlers.retask({ clone_id: 'E', new_task: 'cannot retask WORKING' }),
      ).rejects.toThrow(/WORKING/);
    });

    it('appends retask event with payload', async () => {
      await handlers.register({
        clone_id: 'F',
        mode: 'recon-swarm',
        parent_pid: 1,
        worktree: '/w',
        metadata: {},
      });
      await handlers.heartbeat({ clone_id: 'F', state: 'WORKING' });
      await handlers.heartbeat({ clone_id: 'F', state: 'IDLE' });

      const result = await handlers.retask({
        clone_id: 'F',
        new_task: 'new task text',
        new_approach_hint: 'start with tests',
      });
      expect(result.event.payload).toMatchObject({
        new_task: 'new task text',
        new_approach_hint: 'start with tests',
        new_scope: null,
        new_deadline_ms: null,
      });
    });

    it('rejects retask for unknown clone', async () => {
      await expect(
        handlers.retask({ clone_id: 'GHOST', new_task: 'nothing' }),
      ).rejects.toThrow(/GHOST/);
    });
  });

  describe('pause handler', () => {
    it('transitions to IDLE and appends pause event', async () => {
      await handlers.register({
        clone_id: 'P',
        mode: 'recon-swarm',
        parent_pid: 1,
        worktree: '/w',
        metadata: {},
      });
      await handlers.heartbeat({ clone_id: 'P', state: 'WORKING' });
      clock.advance(1_000);

      const result = await handlers.pause({ clone_id: 'P', reason: 'waiting for review' });
      expect(result.clone.state).toBe('IDLE');
      expect(result.event.type).toBe('pause');
      expect(result.event.payload).toMatchObject({ reason: 'waiting for review' });
    });
  });

  describe('resume handler', () => {
    it('transitions to WORKING and appends resume event', async () => {
      await handlers.register({
        clone_id: 'R',
        mode: 'recon-swarm',
        parent_pid: 1,
        worktree: '/w',
        metadata: {},
      });
      await handlers.heartbeat({ clone_id: 'R', state: 'WORKING' });
      await handlers.heartbeat({ clone_id: 'R', state: 'IDLE' });
      clock.advance(1_000);

      const result = await handlers.resume({ clone_id: 'R' });
      expect(result.clone.state).toBe('WORKING');
      expect(result.event.type).toBe('resume');
    });
  });

  describe('requestTask handler', () => {
    it('transitions to WAITING_FOR_TASK and appends request_task event', async () => {
      await handlers.register({
        clone_id: 'W',
        mode: 'recon-swarm',
        parent_pid: 1,
        worktree: '/w',
        metadata: {},
      });
      await handlers.heartbeat({ clone_id: 'W', state: 'WORKING' });
      clock.advance(1_000);

      const result = await handlers.requestTask({ clone_id: 'W' });
      expect(result.clone.state).toBe('WAITING_FOR_TASK');
      expect(result.event.type).toBe('request_task');
    });

    it('returns both clone record and event', async () => {
      await handlers.register({
        clone_id: 'X',
        mode: 'recon-swarm',
        parent_pid: 1,
        worktree: '/w',
        metadata: {},
      });
      await handlers.heartbeat({ clone_id: 'X', state: 'WORKING' });

      const result = await handlers.requestTask({ clone_id: 'X' });
      expect(result.clone).toBeDefined();
      expect(result.clone.clone_id).toBe('X');
      expect(result.event).toBeDefined();
      expect(result.event.clone_id).toBe('X');
    });
  });
});
