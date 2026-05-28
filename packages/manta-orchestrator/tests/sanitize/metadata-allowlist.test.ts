import { describe, it, expect } from 'vitest';
import {
  POST_MORTEM_METADATA_ALLOWLIST,
  redactPostMortemMetadata,
} from '../../src/sanitize/metadata-allowlist';

describe('redactPostMortemMetadata', () => {
  it('keeps allowlisted keys and reports no drops when metadata is fully allowlisted', () => {
    const r = redactPostMortemMetadata({ cast_id: 'cast-1', cast_mode: 'recon-swarm' });
    expect(r.kept).toEqual({ cast_id: 'cast-1', cast_mode: 'recon-swarm' });
    expect(r.dropped).toEqual([]);
  });

  it('drops non-allowlisted keys and lists them sorted', () => {
    const r = redactPostMortemMetadata({
      cast_id: 'cast-1',
      triggered_by: 'on-push-trigger',
      user_email: 'x@y.z',
    });
    expect(r.kept).toEqual({ cast_id: 'cast-1' });
    expect(r.dropped).toEqual(['triggered_by', 'user_email']);
  });

  it('returns empty kept and empty dropped when input is empty', () => {
    const r = redactPostMortemMetadata({});
    expect(r.kept).toEqual({});
    expect(r.dropped).toEqual([]);
  });

  it('drops every key when none are allowlisted', () => {
    const r = redactPostMortemMetadata({ foo: 'bar', baz: 'qux' });
    expect(r.kept).toEqual({});
    expect(r.dropped).toEqual(['baz', 'foo']);
  });

  it('exposes a frozen allowlist for cross-package consumption', () => {
    expect(POST_MORTEM_METADATA_ALLOWLIST).toContain('cast_id');
    expect(POST_MORTEM_METADATA_ALLOWLIST).toContain('cast_mode');
    expect(Object.isFrozen(POST_MORTEM_METADATA_ALLOWLIST)).toBe(true);
  });

  it('treats input as read-only — does not mutate the source', () => {
    const src = { cast_id: 'cast-1', triggered_by: 'evil' };
    const before = { ...src };
    redactPostMortemMetadata(src);
    expect(src).toEqual(before);
  });
});
