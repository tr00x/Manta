import { describe, it, afterAll, afterEach } from 'vitest';
import { probeClaudeBin } from './helpers/claudeBin.js';
import { runAghsCastE2e } from './helpers/aghsCastRunner.js';
import type { SampleRepoFixture } from './helpers/sampleRepo.js';

// Proves the council HARNESS end-to-end: the Aghs unlock gate (via
// MANTA_UNLOCK_AGHS=council), mode dispatch, proposer priming/skill wiring,
// independent (peer-messaging-denied) spawn, proposal commit, and graceful
// death all carry 3 real `claude --print` clones through their full lifecycle.
// It does NOT assert the *quality* of the proposals nor synthesize them — the
// main agent aggregates the crowd (no auto-merge), which is the human's job.
//
// Probe once at module load so the skip is VISIBLE in the reporter (H1).
const claude = await probeClaudeBin();
const noClaude = !claude.available;

describe.skipIf(noClaude)('council end-to-end against real claude', () => {
  let fx: SampleRepoFixture | undefined;
  let suiteFailed = false;

  afterEach((ctx) => {
    if (ctx.task.result?.state === 'fail') suiteFailed = true;
  });

  afterAll(async () => {
    if (!fx) return;
    const force = process.env.MANTA_E2E_KEEP === '1';
    if (suiteFailed || force) {
      // eslint-disable-next-line no-console -- forensics signal for the human
      console.warn(
        `[council.e2e] preserving evidence at ${fx.root} (${force ? 'MANTA_E2E_KEEP=1' : 'test failed'})`,
      );
      return;
    }
    await fx.cleanup();
  });

  it('runs a 3-clone council cast: clones propose independently, commit, die gracefully, post-mortems written', async () => {
    const out = await runAghsCastE2e({
      mode: 'council',
      cloneCount: 3,
      task:
        'Independently propose how to organize the public exports in src/ into a documentation structure. ' +
        'Write your single reasoned proposal as proposal-<your-id>.md with Recommendation / Reasoning / ' +
        'Trade-offs / Confidence sections, commit it, then die gracefully. Do not coordinate with siblings.',
    });
    fx = out.fixture;
  }, 28 * 60 * 1000);
});
