import { describe, it, expect } from 'vitest';
import { scanForSecrets, maskSecret } from '../../src/share/secret-scanner.js';

interface Case {
  kind: string;
  positive: string;
  negative: string;
}

// One positive + one negative per provider regex (acceptance: each provider has both).
const CASES: Case[] = [
  {
    kind: 'aws-access-key',
    positive: 'AKIAIOSFODNN7EXAMPLE',
    negative: 'AKIA-too-short',
  },
  {
    kind: 'openai-anthropic-key',
    // Merge-ceremony regex tightening (cast-1780020786877 code review):
    // bare `sk-…` form was too loose and false-positive'd on benign
    // prose. The scanner now requires a real provider prefix
    // (sk-ant/proj/live/test/or-...) or the 48+ char alphanumeric form.
    positive: 'sk-ant-abcdef0123456789ABCDEF0123',
    negative: 'sk-learn-version-0.24.1-installation-guide', // proves the false-positive fix
  },
  {
    kind: 'github-pat',
    positive: 'ghp_0123456789abcdef0123456789abcdef0123',
    negative: 'ghp_tooshort',
  },
  {
    kind: 'github-fine-grained-pat',
    positive: 'github_pat_' + 'A'.repeat(45),
    negative: 'github_pat_short',
  },
  {
    kind: 'slack-token',
    positive: 'xoxb-0123456789-abcdefABCDEF',
    negative: 'xoxz-nope',
  },
  {
    kind: 'google-api-key',
    positive: 'AIza' + 'B'.repeat(35),
    negative: 'AIza-too-short',
  },
  {
    kind: 'private-key',
    positive: '-----BEGIN OPENSSH PRIVATE KEY-----\nMIIEpAIBAAKCAQEA',
    negative: '----- not a private key header -----',
  },
  {
    kind: 'jwt',
    positive: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N',
    negative: 'eyJ.short',
  },
  {
    kind: 'generic-secret-assignment',
    positive: 'api_key=supersecretvalue123456',
    negative: 'token = short',
  },
];

describe('scanForSecrets', () => {
  for (const c of CASES) {
    it(`detects ${c.kind} (positive) and reports a masked sample`, () => {
      const findings = scanForSecrets(c.positive);
      expect(findings.length).toBeGreaterThanOrEqual(1);
      // The full token never appears verbatim in any masked sample.
      for (const f of findings) {
        expect(f.masked).not.toContain(c.positive.split(/\s|\n/)[0]!.slice(8));
        expect(f.masked.endsWith('…')).toBe(true);
      }
    });

    it(`does not flag the ${c.kind} negative control`, () => {
      const findings = scanForSecrets(c.negative);
      expect(findings.some((f) => f.kind === c.kind)).toBe(false);
    });
  }

  it('returns exactly one aws-access-key finding for the canonical example', () => {
    const findings = scanForSecrets('AKIAIOSFODNN7EXAMPLE');
    const aws = findings.filter((f) => f.kind === 'aws-access-key');
    expect(aws.length).toBe(1);
    expect(aws[0]!.masked).toBe('AKIA…');
  });

  it('returns ≥1 finding for an export OPENAI_KEY assignment and never leaks the token', () => {
    const findings = scanForSecrets('export OPENAI_KEY=sk-proj-abc123def456ghi789jkl012');
    expect(findings.length).toBeGreaterThanOrEqual(1);
    for (const f of findings) {
      expect(f.masked).not.toContain('abc123def456ghi789jkl012');
    }
  });

  it('returns [] for an ordinary sentence', () => {
    expect(scanForSecrets('a normal sentence about refactoring')).toEqual([]);
  });

  it('detects an OPENSSH private key header', () => {
    const findings = scanForSecrets('-----BEGIN OPENSSH PRIVATE KEY-----\nMIIE…');
    expect(findings.some((f) => f.kind === 'private-key')).toBe(true);
  });

  it('detects a JWT-shaped string', () => {
    const findings = scanForSecrets(
      'auth: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N',
    );
    expect(findings.some((f) => f.kind === 'jwt')).toBe(true);
  });

  it('detects multiple distinct secrets in one blob', () => {
    const blob = 'AKIAIOSFODNN7EXAMPLE and ghp_0123456789abcdef0123456789abcdef0123';
    const kinds = new Set(scanForSecrets(blob).map((f) => f.kind));
    expect(kinds.has('aws-access-key')).toBe(true);
    expect(kinds.has('github-pat')).toBe(true);
  });
});

describe('maskSecret', () => {
  it('keeps the first 4 chars and appends an ellipsis', () => {
    expect(maskSecret('ghp_0123456789abcdef0123456789abcdef0123')).toBe('ghp_…');
  });

  it('never returns the tail of the secret', () => {
    const secret = 'sk-supersecrettokenvalue999';
    expect(maskSecret(secret)).toBe('sk-s…');
    expect(maskSecret(secret)).not.toContain('supersecret');
  });

  it('handles a short input without throwing', () => {
    expect(maskSecret('ab')).toBe('ab…');
  });
});
