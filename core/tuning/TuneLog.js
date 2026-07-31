/**
 * A log of every configuration that became the new best during a tune - the tuning counterpart to
 * core/logging/SpinLog.js, exporting JSON rather than CSV because what is being recorded is a CONFIG, not
 * a flat row of numbers.
 *
 * The problem it solves: a search reports one final answer, and the dozen candidates it accepted
 * along the way - several of which may be better for a purpose the loss function does not know
 * about - are gone. A run that ends at 96.02% RTP with a volatility of 11x may have passed through
 * 96.4% at 5x forty iterations earlier, and nothing recorded it. Worse, "best" means lowest LOSS,
 * which is a weighted blend; the candidate that best serves what you actually care about is often
 * not the one the search kept.
 *
 * Every entry therefore carries enough metadata to judge it WITHOUT re-running anything: what it
 * achieved, how trustworthy that measurement was, what its payout actually looks like, what it
 * violated, and the frequencies themselves.
 *
 * Pure - no DOM, no simulation. The panel renders it; core/simulation/SpinSimulator.js never knows it exists.
 */

import { downloadTextFile } from '../io/FileIO.js';
import { pctToSpinsPerTrigger, sigmaToVolatilityBand } from './Units.js';

/**
 * Builds one tune-log entry from a candidate the search just accepted as its new best.
 *
 * @param {Object} args
 * @param {number} args.index - 1-based position in the log.
 * @param {number} args.step - The search iteration this was accepted at.
 * @param {string|null} args.stage - Which Phase 2 stage produced it ('linked'/'refine'/...).
 * @param {Object} args.candidate - An evaluate() result (loss, rtp, penalties, roundStats, ...).
 * @param {Object} args.options - The resolved tuning options, for targets and weights.
 * @param {Object[]} args.reelFrequencyTables - The candidate's own tables.
 * @returns {Object}
 */
export function createTuneLogEntry({ index, step, stage, candidate, options, reelFrequencyTables }) {
  const rtp = candidate.rtp ?? null;
  const triggerRatePct = candidate.triggerRate ?? null;
  const rs = candidate.roundStats ?? null;
  const norm = options.penaltyNormalization === 'normalized';

  // The loss, broken into what each term actually contributed. Reconstructed from the candidate's
  // own reported values times the weights in force, rather than stored by the engine - so an entry
  // stays readable even if the loss composition changes, and a mismatch against `loss` below is
  // visible rather than hidden.
  const terms = [
    { key: 'rtpError', label: 'RTP error', weight: 1, value: candidate.error ?? 0 },
    { key: 'ordering', label: 'Payout ordering', weight: options.orderingPenaltyWeight ?? 0,
      value: norm ? (candidate.orderingPenaltyNormalized ?? 0) : (candidate.orderingPenalty ?? 0) },
    { key: 'limits', label: 'Frequency limits', weight: options.limitPenaltyWeight ?? 0,
      value: norm ? (candidate.limitPenaltyNormalized ?? 0) : (candidate.limitPenalty ?? 0) },
    { key: 'uniformity', label: 'Even spread', weight: options.uniformityPenaltyWeight ?? 0,
      value: norm ? (candidate.uniformityPenaltyNormalized ?? 0) : (candidate.uniformityPenalty ?? 0) },
    { key: 'spacing', label: 'Reel spacing', weight: options.spacingPenaltyWeight ?? 0,
      value: norm ? (candidate.spacingPenaltyNormalized ?? 0) : (candidate.spacingPenalty ?? 0) },
    { key: 'triggerRate', label: 'Trigger rate', weight: options.triggerRatePenaltyWeight ?? 0,
      value: candidate.triggerRatePenalty ?? 0 },
    { key: 'volatility', label: 'Volatility', weight: options.volatilityPenaltyWeight ?? 0,
      value: candidate.volatilityPenalty ?? 0 },
    { key: 'stdError', label: 'Measurement noise', weight: options.stdErrorPenaltyWeight ?? 0,
      value: candidate.trialRtpStdError ?? 0 },
  ].map(t => ({ ...t, contribution: t.weight * t.value }));

  const measurementSpins = candidate.measurementSpins ?? options.trialSpins ?? null;
  const measurementTrials = candidate.measurementTrials ?? options.trialsPerPoint ?? null;
  const varianceKnown = measurementTrials != null && measurementTrials > 1;
  const stdError = varianceKnown ? (candidate.trialRtpStdError ?? 0) : null;

  return {
    index,
    step,
    stage: stage ?? null,
    acceptedAt: new Date().toISOString(),

    // ---- What it achieved, against what was asked for ----
    achieved: {
      rtp,
      rtpError: candidate.error ?? null,
      targetRtp: options.targetRtp ?? null,
      withinRtpTolerance: rtp != null && options.targetRtp != null
        && Math.abs(rtp - options.targetRtp) <= (options.rtpTolerancePct ?? 1.5),
      triggerRatePct,
      spinsPerTrigger: triggerRatePct != null ? pctToSpinsPerTrigger(triggerRatePct) : null,
      targetTriggerRatePct: options.targetTriggerRatePct ?? null,
      withinTriggerTolerance: triggerRatePct != null && options.targetTriggerRatePct != null
        && Math.abs(triggerRatePct - options.targetTriggerRatePct) <= (options.triggerRateTolerancePct ?? 0.15),
    },

    // ---- How much to trust the numbers above ----
    // A candidate can look excellent purely because its particular sample landed well. Without
    // this an exported config is a number with no error bar, which is the same mistake the tuner
    // itself used to make before maxRtpStdError existed.
    measurement: {
      trialRtpStdDev: varianceKnown ? (candidate.trialRtpStdDev ?? null) : null,
      trialRtpStdError: stdError,
      trialRtpMin: candidate.trialRtpMin ?? null,
      trialRtpMax: candidate.trialRtpMax ?? null,
      maxRtpStdError: options.maxRtpStdError ?? null,
      reliable: varianceKnown && (options.maxRtpStdError == null || stdError <= options.maxRtpStdError),
      varianceKnown,
      trialSpins: measurementSpins,
      trialsPerPoint: measurementTrials,
    },

    // ---- What it feels like, not just what it returns ----
    // The reason a log is worth keeping at all: two candidates with the same RTP can be completely
    // different games, and the loss function cannot see the difference.
    shape: rs ? {
      volatilityIndex: rs.volatilityIndex,
      volatilityBand: sigmaToVolatilityBand(rs.volatilityIndex),
      hitRate: rs.hitRate,
      medianWin: rs.medianWin,
      p99: rs.p99,
      maxWin: rs.maxWin,
      top1PctShare: rs.top1PctShare,
      rounds: rs.rounds,
    } : null,

    // ---- What it broke ----
    violations: {
      ordering: (candidate.orderingViolations ?? []).length,
      limits: (candidate.limitViolations ?? []).length,
      spacing: (candidate.spacingViolations ?? []).length,
    },

    // ---- Why the search preferred it ----
    loss: {
      total: candidate.loss ?? null,
      penaltyNormalization: options.penaltyNormalization ?? 'raw',
      terms: terms.filter(t => t.weight > 0 || t.key === 'rtpError'),
    },

    // ---- The artifact itself ----
    reelFrequencyTables: JSON.parse(JSON.stringify(reelFrequencyTables)),
  };
}

/**
 * A one-line verdict per entry, plus the specific reasons behind it. The point of the log is to
 * make "is this any good?" answerable at a glance rather than by reading eight numbers, so the
 * reasons are the things that would make you reject it, named explicitly.
 */
export function describeTuneEntryQuality(entry) {
  const problems = [];
  const notes = [];
  // Logs exported before explicit provenance existed used the configured multi-trial budget.
  // Treat those as known unless they explicitly say otherwise, while new one-trial entries stay
  // visibly unvalidated.
  const varianceKnown = entry.measurement.varianceKnown ?? ((entry.measurement.trialsPerPoint ?? 2) > 1);
  if (!entry.achieved.withinRtpTolerance && entry.achieved.targetRtp != null) {
    problems.push(`RTP off by ${(entry.achieved.rtpError ?? 0).toFixed(2)}pp`);
  }
  if (!entry.achieved.withinTriggerTolerance && entry.achieved.targetTriggerRatePct != null) {
    problems.push('trigger rate out of band');
  }
  if (!varianceKnown) {
    problems.push('single exploration trial (variance unknown)');
  } else if (!entry.measurement.reliable) {
    problems.push(`noisy (±${entry.measurement.trialRtpStdError.toFixed(2)}pp)`);
  }
  if (entry.violations.ordering > 0) problems.push(`${entry.violations.ordering} ordering`);
  if (entry.violations.limits > 0) problems.push(`${entry.violations.limits} limit`);
  if (entry.violations.spacing > 0) notes.push(`${entry.violations.spacing} spacing`);
  if (entry.shape) {
    notes.push(`${entry.shape.volatilityBand} volatility`);
    // Concentration is not a pass/fail, but it is the thing most likely to make a numerically
    // perfect candidate feel wrong to play, so it is always surfaced rather than only when extreme.
    notes.push(`top 1% carry ${(entry.shape.top1PctShare * 100).toFixed(0)}%`);
  }
  return {
    ok: problems.length === 0,
    verdict: problems.length === 0 ? 'meets every target' : problems.join(', '),
    problems,
    notes,
  };
}

/** A compact single-line label for the log list. */
export function summarizeTuneLogEntry(entry) {
  const parts = [`#${entry.index}`, `step ${entry.step}`];
  if (entry.stage) parts.push(entry.stage);
  if (entry.achieved.rtp != null) parts.push(`RTP ${entry.achieved.rtp.toFixed(2)}%`);
  if (entry.achieved.spinsPerTrigger != null) parts.push(`bonus 1 in ${Math.round(entry.achieved.spinsPerTrigger)}`);
  if (entry.shape) parts.push(`vol ${entry.shape.volatilityIndex.toFixed(1)}x`);
  if (entry.loss.total != null) parts.push(`loss ${entry.loss.total.toFixed(4)}`);
  return parts.join(' · ');
}

/**
 * Serializes entries as pretty JSON with a run-level header.
 *
 * `meta` records what produced the run, for the same reason
 * formatReelFrequencyTablesForCopy emits a reproducibility header: frequencies alone are not a
 * reproducible artifact, and an exported config that cannot be reproduced is a screenshot.
 */
export function tuneLogToJson(entries, meta = {}) {
  return JSON.stringify({
    exportedAt: new Date().toISOString(),
    game: meta.game ?? null,
    run: meta.inputParameters ?? null,
    entryCount: entries.length,
    entries: entries.map(e => ({ ...e, quality: describeTuneEntryQuality(e) })),
  }, null, 2);
}

/**
 * Downloads the log as JSON. One entry or all - the same function either way, since "export this
 * one config" and "export the whole history" differ only in what is handed in.
 */
export function exportTuneLogJson(entries, meta = {}) {
  const json = tuneLogToJson(entries, meta);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const scope = entries.length === 1 ? `entry${entries[0].index}` : `all${entries.length}`;
  downloadTextFile(`tunelog_${meta.game ?? 'game'}_${scope}_${stamp}.json`, json, 'application/json');
}
