import test from 'node:test';
import assert from 'node:assert/strict';
import { measureSimulationTrials, TRIAL_SEED_STRIDE } from '../core/simulation/TrialMeasurement.js';

const CONFIG = {
  reelsCount: 1,
  rowsCount: 1,
  paytable: { a: { payout: [1] } },
  reelStrips: [['a']],
  paylines: [[0]],
};

test('measureSimulationTrials uses deterministic independent seeds and disables detail collection', async () => {
  const calls = [];
  const result = await measureSimulationTrials({
    config: CONFIG,
    spins: 100,
    trials: 3,
    betPerLine: 1,
    linesCount: 1,
    rngSeed: 700,
    runTrial: async (config, spins, bet, lines, seed) => {
      calls.push({ config, spins, bet, lines, seed });
      return {
        rtpRaw: 1,
        freeSpinsTriggered: 0,
        baseSpins: spins,
        roundStats: { rounds: spins, hitRate: 1, meanWin: 1, volatilityIndex: 0, maxWin: 1, histogram: [{ index: 1, count: spins }] },
      };
    },
  });

  assert.deepEqual(calls.map(call => call.seed), [700, 700 + TRIAL_SEED_STRIDE, 700 + TRIAL_SEED_STRIDE * 2]);
  assert.ok(calls.every(call => call.config.collectDetailedWins === false && call.config.collectWinDistribution === false));
  assert.ok(calls.every(call => call.config.logSpins === false));
  assert.equal(result.rtp, 100);
  assert.equal(result.triggerRate, 0);
  assert.equal(result.trialRtpStdError, 0);
  assert.equal(result.roundStats.rounds, 300);
});

test('measureSimulationTrials validates the requested sample shape before scheduling work', async () => {
  await assert.rejects(
    () => measureSimulationTrials({ config: CONFIG, spins: 0, trials: 1, betPerLine: 1, linesCount: 1 }),
    /spins must be a positive integer/,
  );
  await assert.rejects(
    () => measureSimulationTrials({ config: CONFIG, spins: 1, trials: 0, betPerLine: 1, linesCount: 1 }),
    /trials must be a positive integer/,
  );
});

test('measureSimulationTrials can omit round-shape collection for RTP-only tuning candidates', async () => {
  let seenConfig = null;
  const result = await measureSimulationTrials({
    config: CONFIG,
    spins: 100,
    trials: 1,
    betPerLine: 1,
    linesCount: 1,
    rngSeed: 17,
    collectRoundStats: false,
    runTrial: async (config, spins) => {
      seenConfig = config;
      return { rtpRaw: 0.96, freeSpinsTriggered: 0, baseSpins: spins, roundStats: null };
    },
  });
  assert.equal(seenConfig.collectRoundStats, false);
  assert.equal(result.roundStats, null);
});
