import { describe, it, expect } from 'vitest';
import { TriggerDefSchema } from '../src/trigger-schema';

// A minimal-but-valid trigger; helpers spread overrides on top to exercise each
// acceptance criterion. forbidden_paths always carries the two mandatory entries.
function validScope() {
  return {
    allowed_paths: ['src/'],
    forbidden_paths: ['.manta/state', 'secrets/'],
    max_files_changed: 5,
  };
}

function validAction(overrides: Record<string, unknown> = {}) {
  return {
    mode: 'bug-hunt',
    clones: 2,
    task_template: 'hunt the bug in ${changed_files}',
    scope: validScope(),
    budget: { per_clone_token_estimate: 1.5, per_cast_token_estimate: 3 },
    ...overrides,
  };
}

function validTrigger(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    name: 'test-failure-bug-hunt',
    enabled: false,
    event: { source: 'git', type: 'post-commit' },
    safety: { hourly_cap: 3, per_fire_token_cap: 3 },
    action: validAction(),
    ...overrides,
  };
}

describe('TriggerDefSchema — worked examples (research §2.4)', () => {
  it('§2.4.1 git post-commit → bug-hunt with a shell condition', () => {
    const parsed = TriggerDefSchema.parse(
      validTrigger({
        name: 'on-test-failure',
        conditions: [{ type: 'shell', cmd: 'pnpm test', timeout_ms: 120000 }],
      }),
    );
    expect(parsed.name).toBe('on-test-failure');
    // defaults populate
    expect(parsed.description).toBe('');
    expect(parsed.debounce_ms).toBe(0);
    expect(parsed.cooldown_s).toBe(300);
    expect(parsed.event.hook_matcher).toBeNull();
    expect(parsed.conditions[0]).toMatchObject({ type: 'shell', cwd: '${repo.root}' });
    expect(parsed.safety.loop.max_cause_chain_depth).toBe(3);
  });

  it('§2.4.2 claude-code-hook PostToolUse:Edit → recon-swarm with changed-files condition', () => {
    const parsed = TriggerDefSchema.parse(
      validTrigger({
        name: 'on-large-edit-recon',
        event: { source: 'claude-code-hook', type: 'PostToolUse', hook_matcher: 'Edit' },
        conditions: [{ type: 'changed_files_gt', value: 10 }],
        action: validAction({ mode: 'recon-swarm', clones: 3 }),
      }),
    );
    expect(parsed.event.source).toBe('claude-code-hook');
    expect(parsed.event.hook_matcher).toBe('Edit');
    expect(parsed.action.mode).toBe('recon-swarm');
  });

  it('§2.4.3 manual fire → refactor-wave with a glob condition + debounce/dedup', () => {
    const parsed = TriggerDefSchema.parse(
      validTrigger({
        name: 'manual-refactor',
        event: { source: 'manual', type: 'fire' },
        conditions: [{ type: 'changed_files_match_glob', glob: '**/*.ts' }],
        debounce_ms: 5000,
        dedup_key: '${changed_files[0]}',
        cooldown_s: 600,
        action: validAction({ mode: 'refactor-wave' }),
      }),
    );
    expect(parsed.debounce_ms).toBe(5000);
    expect(parsed.dedup_key).toBe('${changed_files[0]}');
    expect(parsed.cooldown_s).toBe(600);
  });
});

describe('TriggerDefSchema — refusal paths (bias toward no)', () => {
  it('rejects enabled: true (YAML can never self-arm)', () => {
    expect(() => TriggerDefSchema.parse(validTrigger({ enabled: true }))).toThrow();
  });

  it('rejects forbidden_paths missing .manta/state', () => {
    expect(() =>
      TriggerDefSchema.parse(
        validTrigger({ action: validAction({ scope: { allowed_paths: ['src/'], forbidden_paths: ['secrets/'], max_files_changed: 5 } }) }),
      ),
    ).toThrow();
  });

  it('rejects forbidden_paths missing secrets/', () => {
    expect(() =>
      TriggerDefSchema.parse(
        validTrigger({ action: validAction({ scope: { allowed_paths: ['src/'], forbidden_paths: ['.manta/state'], max_files_changed: 5 } }) }),
      ),
    ).toThrow();
  });

  it('rejects per_cast_token_estimate > safety.per_fire_token_cap (budget cap refine)', () => {
    expect(() =>
      TriggerDefSchema.parse(
        validTrigger({
          safety: { hourly_cap: 3, per_fire_token_cap: 3 },
          action: validAction({ budget: { per_clone_token_estimate: 1, per_cast_token_estimate: 4 } }),
        }),
      ),
    ).toThrow();
  });

  it('accepts per_cast_token_estimate === safety.per_fire_token_cap (boundary)', () => {
    expect(() =>
      TriggerDefSchema.parse(
        validTrigger({
          safety: { hourly_cap: 3, per_fire_token_cap: 3 },
          action: validAction({ budget: { per_clone_token_estimate: 1, per_cast_token_estimate: 3 } }),
        }),
      ),
    ).not.toThrow();
  });

  it('rejects action.mode outside the 10-mode enum', () => {
    expect(() => TriggerDefSchema.parse(validTrigger({ action: validAction({ mode: 'not-a-mode' }) }))).toThrow();
  });

  it('rejects an UPPER-case name (regex)', () => {
    expect(() => TriggerDefSchema.parse(validTrigger({ name: 'UPPER' }))).toThrow();
  });

  it('rejects an unknown key at the top level (strict)', () => {
    expect(() => TriggerDefSchema.parse(validTrigger({ extra: 1 }))).toThrow();
  });

  it('rejects an unknown key nested in action (strict everywhere)', () => {
    expect(() => TriggerDefSchema.parse(validTrigger({ action: validAction({ surprise: 1 }) }))).toThrow();
  });

  it('rejects a condition with an unknown type (discriminated union)', () => {
    expect(() => TriggerDefSchema.parse(validTrigger({ conditions: [{ type: 'unknown' }] }))).toThrow();
  });

  it('rejects clones: 9 (.max(8))', () => {
    expect(() => TriggerDefSchema.parse(validTrigger({ action: validAction({ clones: 9 }) }))).toThrow();
  });

  it('rejects a missing safety block (no default — must be explicit)', () => {
    const t = validTrigger();
    delete (t as Record<string, unknown>).safety;
    expect(() => TriggerDefSchema.parse(t)).toThrow();
  });

  it('rejects a shell condition with timeout_ms over 300000', () => {
    expect(() =>
      TriggerDefSchema.parse(
        validTrigger({ conditions: [{ type: 'shell', cmd: 'x', timeout_ms: 300001 }] }),
      ),
    ).toThrow();
  });
});
