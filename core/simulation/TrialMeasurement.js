import { createSeededRng } from '../math/SlotMath.js';
import { simulateSpins } from './SpinSimulator.js';
import { mergeRoundStats } from './RoundStatistics.js';

export const TRIAL_SEED_STRIDE = 104729;

function assertPositiveInteger(value, name) {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
}

function summarizeTrialResults(trialResults) {
  const rtps = trialResults.map(result => result.rtpRaw * 100);
  const rtp = rtps.reduce((sum, value) => sum + value, 0) / rtps.length;
  const trialRtpStdDev = rtps.length > 1
    ? Math.sqrt(rtps.reduce((sum, value) => sum + (value - rtp) ** 2, 0) / (rtps.length - 1))
    : 0;
  const roundStats = trialResults.map(result => result.roundStats).filter(Boolean);
  return {
    rtp,
    triggerRate: trialResults.reduce((sum, result) => sum + (result.freeSpinsTriggered / result.baseSpins) * 100, 0) / trialResults.length,
    trialRtpMin: Math.min(...rtps),
    trialRtpMax: Math.max(...rtps),
    trialRtpStdDev,
    trialRtpStdError: trialRtpStdDev / Math.sqrt(rtps.length),
    roundStats: roundStats.length ? mergeRoundStats(roundStats) : null,
  };
}

/**
 * Measures one candidate over independent deterministic trials. The returned standard error is
 * intentionally based on trial means, not individual spins: it remains valid for free-spin and
 * cascade correlations that make per-spin samples non-independent.
 */
export async function measureSimulationTrials({
  config,
  spins,
  trials,
  betPerLine,
  linesCount,
  rngSeed = null,
  runTrial = null,
}) {
  assertPositiveInteger(spins, 'spins');
  assertPositiveInteger(trials, 'trials');
  const measurementConfig = { ...config, collectDetailedWins: false, collectWinDistribution: false, logSpins: false };
  const seeds = Array.from({ length: trials }, (_, index) => rngSeed == null ? null : rngSeed + index * TRIAL_SEED_STRIDE);
  const trialResults = runTrial
    ? await Promise.all(seeds.map(seed => runTrial(measurementConfig, spins, betPerLine, linesCount, seed)))
    : seeds.map(seed => simulateSpins(
      measurementConfig, spins, betPerLine, linesCount,
      seed == null ? Math.random : createSeededRng(seed),
    ));
  return summarizeTrialResults(trialResults);
}