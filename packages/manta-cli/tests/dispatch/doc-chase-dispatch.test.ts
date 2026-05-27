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

  it('returns single item for task without recognizable paths', () => {
    const items = DocChaseDispatcher.parseTaskIntoItems(
      'Document the overall architecture of the project',
      'DOC',
      'cast-1',
    );
    expect(items).toHaveLength(1);
    expect(items[0]!.prompt).toContain('overall architecture');
  });

  it('sets all items to normal priority', () => {
    const items = DocChaseDispatcher.parseTaskIntoItems(
      'Document: packages/manta-bus/src/schema.ts, src/util/sleep.ts',
      'DOC',
      'cast-1',
    );
    for (const item of items) {
      expect(item.priority).toBe('normal');
      expect(item.cast_id).toBe('cast-1');
    }
  });

  it('isDone returns false (daemon-loop handles termination)', () => {
    const d = new DocChaseDispatcher({ cloneId: 'DOC', castId: 'cast-1' });
    expect(d.isDone).toBe(false);
  });
});
