import { describe, it, afterAll, afterEach } from 'vitest';
import { probeClaudeBin } from './helpers/claudeBin.js';
import { runAghsCastE2e } from './helpers/aghsCastRunner.js';
import type { SampleRepoFixture } from './helpers/sampleRepo.js';

// Proves the decoy HARNESS end-to-end: the Aghs unlock gate (via
// MANTA_UNLOCK_AGHS=decoy), mode dispatch, drafter priming/skill wiring, spawn,
// draft commit, and graceful death all carry 2 real `claude --print` clones
// through their full lifecycle and produce every on-disk artifact. It does NOT
// assert the *quality* of the drafts — that is the main agent's job (the whole
// point of decoy: clones draft, main finalizes).
//
// Probe once at module load so the skip is VISIBLE in the reporter (H1).
const claude = await probeClaudeBin();
const noClaude = !claude.available;

describe.skipIf(noClaude)('decoy end-to-end against real claude', () => {
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
        `[decoy.e2e] preserving evidence at ${fx.root} (${force ? 'MANTA_E2E_KEEP=1' : 'test failed'})`,
      );
      return;
    }
    await fx.cleanup();
  });

  it('runs a 2-clone decoy cast: clones draft, commit, die gracefully, post-mortems written', async () => {
    const out = await runAghsCastE2e({
      mode: 'decoy',
      cloneCount: 2,
      task:
        'Produce a DRAFT outline for a README documenting the public exports in src/. ' +
        'Sketch the sections — do not polish. Write it as docs/readme-draft.md, commit, then die gracefully.',
    });
    fx = out.fixture;
  }, 28 * 60 * 1000);
});
