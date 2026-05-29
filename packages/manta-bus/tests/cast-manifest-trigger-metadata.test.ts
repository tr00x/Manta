import { describe, it, expect } from 'vitest';
import {
  CastManifestSchema,
  CastMetadataSchema,
  CastTriggerProvenanceSchema,
  CreateCastInputSchema,
} from '../src/schema';

// A valid Phase 0-7a manifest WITHOUT any metadata (the backward-compat baseline).
function baseManifest() {
  return {
    version: 1 as const,
    cast_id: 'cast-1700000000000',
    mode: 'forking-realities' as const,
    clones: [
      { clone_id: 'A', assignment: null },
      { clone_id: 'B', assignment: null },
    ],
    policy: {
      peer_messaging: 'denied' as const,
      auto_merge_threshold: null,
      session_mode: 'batch' as const,
    },
    created_at: 1700000000000,
  };
}

const validTrigger = {
  trigger_name: 'test-failure-bug-hunt',
  fired_at: 1700000000000,
  parent_cast_id: 'cast-1699999999999',
};

describe('CastTriggerProvenanceSchema', () => {
  it('accepts a well-formed provenance with a parent_cast_id', () => {
    const parsed = CastTriggerProvenanceSchema.parse(validTrigger);
    expect(parsed.trigger_name).toBe('test-failure-bug-hunt');
    expect(parsed.parent_cast_id).toBe('cast-1699999999999');
  });

  it('accepts parent_cast_id === null (user-fired sentinel)', () => {
    const parsed = CastTriggerProvenanceSchema.parse({ ...validTrigger, parent_cast_id: null });
    expect(parsed.parent_cast_id).toBeNull();
  });

  it('rejects a non-kebab trigger_name', () => {
    expect(() => CastTriggerProvenanceSchema.parse({ ...validTrigger, trigger_name: 'Bad_Name' })).toThrow();
  });

  it('rejects a trigger_name shorter than 2 chars', () => {
    expect(() => CastTriggerProvenanceSchema.parse({ ...validTrigger, trigger_name: 'x' })).toThrow();
  });

  it('rejects a negative fired_at', () => {
    expect(() => CastTriggerProvenanceSchema.parse({ ...validTrigger, fired_at: -1 })).toThrow();
  });

  it('rejects unknown keys (strict)', () => {
    expect(() => CastTriggerProvenanceSchema.parse({ ...validTrigger, extra: 1 })).toThrow();
  });
});

describe('CastMetadataSchema', () => {
  it('defaults cause_chain to [] when only trigger is present', () => {
    const parsed = CastMetadataSchema.parse({ trigger: validTrigger });
    expect(parsed.cause_chain).toEqual([]);
  });

  it('keeps a provided cause_chain', () => {
    const parsed = CastMetadataSchema.parse({ trigger: validTrigger, cause_chain: ['aa', 'bb'] });
    expect(parsed.cause_chain).toEqual(['aa', 'bb']);
  });

  it('rejects unknown keys (strict)', () => {
    expect(() =>
      CastMetadataSchema.parse({ trigger: validTrigger, cause_chain: [], extra: 1 }),
    ).toThrow();
  });

  it('rejects a cause_chain longer than 8 (poisoned-manifest backstop)', () => {
    const nine = Array.from({ length: 9 }, (_, i) => `t${i}`);
    expect(() => CastMetadataSchema.parse({ cause_chain: nine })).toThrow();
  });
});

describe('CastManifestSchema with metadata', () => {
  it('accepts a manifest with NO metadata (backward-compatible)', () => {
    const parsed = CastManifestSchema.parse(baseManifest());
    expect(parsed.metadata).toBeUndefined();
  });

  it('accepts a manifest with metadata.trigger + metadata.cause_chain', () => {
    const parsed = CastManifestSchema.parse({
      ...baseManifest(),
      metadata: { trigger: validTrigger, cause_chain: ['test-failure-bug-hunt'] },
    });
    expect(parsed.metadata?.trigger?.trigger_name).toBe('test-failure-bug-hunt');
    expect(parsed.metadata?.cause_chain).toEqual(['test-failure-bug-hunt']);
  });

  it('defaults cause_chain to [] when metadata present but cause_chain omitted', () => {
    const parsed = CastManifestSchema.parse({
      ...baseManifest(),
      metadata: { trigger: validTrigger },
    });
    expect(parsed.metadata?.cause_chain).toEqual([]);
  });
});

describe('CreateCastInputSchema with metadata', () => {
  it('accepts an input with metadata', () => {
    const parsed = CreateCastInputSchema.parse({
      cast_id: 'cast-1',
      mode: 'recon-swarm',
      clones: [{ clone_id: 'A', assignment: null }],
      policy: { peer_messaging: 'allowed', auto_merge_threshold: null, session_mode: 'batch' as const },
      metadata: { trigger: validTrigger, cause_chain: ['test-failure-bug-hunt'] },
    });
    expect(parsed.metadata?.cause_chain).toEqual(['test-failure-bug-hunt']);
  });

  it('accepts an input with NO metadata', () => {
    const parsed = CreateCastInputSchema.parse({
      cast_id: 'cast-1',
      mode: 'recon-swarm',
      clones: [{ clone_id: 'A', assignment: null }],
      policy: { peer_messaging: 'allowed', auto_merge_threshold: null, session_mode: 'batch' as const },
    });
    expect(parsed.metadata).toBeUndefined();
  });
});
