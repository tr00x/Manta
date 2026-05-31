import { describe, it, expect } from 'vitest';
import {
  PRIMING,
  HOOK_EVENT_NAME,
  buildHookOutput,
  serializeHookOutput,
  runSessionPriming,
} from '../../src/bin/manta-session-priming.js';

describe('buildHookOutput', () => {
  it('emits the SessionStart hookSpecificOutput shape Claude Code reads', () => {
    const out = buildHookOutput();
    expect(out.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(out.hookSpecificOutput.hookEventName).toBe(HOOK_EVENT_NAME);
    expect(typeof out.hookSpecificOutput.additionalContext).toBe('string');
    expect(out.hookSpecificOutput.additionalContext).toBe(PRIMING);
  });

  it('uses the provided priming text when one is passed', () => {
    const out = buildHookOutput('custom priming');
    expect(out.hookSpecificOutput.additionalContext).toBe('custom priming');
  });
});

describe('PRIMING content — the orchestration contract', () => {
  it('points at the skills (does not duplicate them) and the key commands', () => {
    // It must NAME the skills that carry the detail, not inline their content.
    expect(PRIMING).toContain('manta-cast-decide');
    expect(PRIMING).toContain('manta-orchestrate');
    // The observe/recover playbook and serial-awareness gotchas.
    expect(PRIMING).toContain('/manta:status');
    expect(PRIMING).toContain('merge-review');
    expect(PRIMING).toMatch(/serial/i);
    expect(PRIMING).toContain('manta doctor');
  });

  it('stays concise — it is injected every session (≤ 8 lines)', () => {
    const lines = PRIMING.split('\n');
    expect(lines.length).toBeLessThanOrEqual(8);
    expect(lines.length).toBeGreaterThanOrEqual(4);
  });

  it('primes softly — never claims to force tool ordering', () => {
    // No-fake-enforcement rule: the hook is soft-but-always-seen, not a hard gate.
    expect(PRIMING).toMatch(/consider|guidance/i);
    expect(PRIMING).not.toMatch(/must (always|first|never)/i);
  });
});

describe('serializeHookOutput', () => {
  it('produces a single line of valid JSON that round-trips', () => {
    const line = serializeHookOutput();
    expect(line).not.toContain('\n\n'); // a single JSON blob, not multi-doc
    const parsed = JSON.parse(line);
    expect(parsed.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(parsed.hookSpecificOutput.additionalContext).toBe(PRIMING);
  });
});

describe('runSessionPriming — the hook script output', () => {
  it('writes the serialized hook output exactly once (prints the priming)', () => {
    const chunks: string[] = [];
    runSessionPriming((c) => chunks.push(c));
    expect(chunks).toHaveLength(1);
    const written = chunks[0] ?? '';
    expect(written).toBe(serializeHookOutput());
    // The written payload is the parseable JSON Claude Code injects as context.
    const parsed = JSON.parse(written);
    expect(parsed.hookSpecificOutput.additionalContext).toContain('manta-orchestrate');
  });

  it('never throws even if the write sink fails (so the hook exits 0)', () => {
    // The script entry guard does nothing but call runSessionPriming; proving it
    // swallows a failing sink proves the process can only exit 0.
    expect(() =>
      runSessionPriming(() => {
        throw new Error('stdout exploded');
      }),
    ).not.toThrow();
  });
});
