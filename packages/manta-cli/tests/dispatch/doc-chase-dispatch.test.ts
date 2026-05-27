import { describe, it, expect } from 'vitest';
import { DocChaseDispatcher } from '../../src/dispatch/doc-chase-dispatch.js';

describe('DocChaseDispatcher', () => {
  it('parses a multi-topic task into individual work items', () => {
    const items = DocChaseDispatcher.parseTaskIntoItems(
      'Document modules: packages/manta-bus/src/state/registry.ts, packages/manta-cli/src/commands/cast.ts',
      'DOC',
      'cast-1',
    );
    expect(items).toHaveLength(2);
    expect(items[0]!.target_clone_id).toBe('DOC');
    expect(items[0]!.prompt).toContain('registry.ts');
    expect(items[1]!.prompt).toContain('cast.ts');
  });

  it('falls back to single item when no paths found', () => {
    const items = DocChaseDispatcher.parseTaskIntoItems(
      'Document the auth system',
      'A',
      'cast-2',
    );
    expect(items).toHaveLength(1);
    expect(items[0]!.prompt).toContain('Document the auth system');
    expect(items[0]!.priority).toBe('normal');
  });

  it('isDone returns false (daemon-loop handles termination)', () => {
    const d = new DocChaseDispatcher({ cloneId: 'DOC', castId: 'cast-1' });
    expect(d.isDone).toBe(false);
  });

  it('sets cast_id on each work item', () => {
    const items = DocChaseDispatcher.parseTaskIntoItems(
      'Doc: packages/manta-bus/src/index.ts',
      'A',
      'cast-xyz',
    );
    expect(items[0]!.cast_id).toBe('cast-xyz');
  });
});
