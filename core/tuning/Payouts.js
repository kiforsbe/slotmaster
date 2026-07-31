import { LineMechanic } from '../engine/mechanics/LineMechanic.js';

// Ranks symbols by descending payout (highest single-line payout = rank 0), tying symbols
// with equal payout to the same rank so their relative weight is preserved as a group.
// `payoutOf(paytable, symbol) -> number` is mechanic-specific (line-pay ranks by the highest
// N-of-a-kind payout, cascade ranks by the highest cluster-payout tier - see LineMechanic.js/
// CascadeSpinMechanic.js's own `defaultPayoutOf`) - defaults to the line-pay convention so
// existing callers that don't pass one keep working unchanged.
export function computeValueRanks(paytable, symbols, payoutOf = LineMechanic.defaultPayoutOf) {
  const sorted = [...symbols].sort((a, b) => payoutOf(paytable, b) - payoutOf(paytable, a));
  const rankOf = {};
  let rank = -1, lastPayout = null;
  for (const s of sorted) {
    const p = payoutOf(paytable, s);
    if (p !== lastPayout) { rank++; lastPayout = p; }
    rankOf[s] = rank;
  }
  return rankOf;
}

// Scales any positive per-symbol raw-weight map so it sums to valueBudget - used both to
// project Phase 2's Nelder-Mead candidates back onto each reel's fixed budget, and (via
// Phase 1) to keep the scatter-symbol scaling on the same footing.
/**
 * Scales `raw` to sum to `valueBudget` while keeping every entry inside its own [min, max].
 *
 * Plain `renormalizeWeights` cannot do this, and the gap is not academic. `minFrequency`/
 * `maxFrequency` are enforced (limitPenaltyOf) and displayed against the RENORMALIZED frequency,
 * but `initialWeightStrategy` sampled them as RAW weights and then renormalized - so asking for
 * "random between 0.005 and 0.5" on Candy Frenzy reliably produced values between 0.00125 and
 * 0.26: below the configured minimum at one end, nowhere near the maximum at the other, and
 * clustered around budget/N. The setting did not do what its label said, which is exactly the
 * complaint that "random ends up being like the overall average".
 *
 * Clamp-and-redistribute: scale the unclamped entries to absorb the budget, clamp whatever leaves
 * its bounds, repeat. Converges in a handful of passes because each one clamps at least one more
 * entry. Returns plain renormalization unchanged when the budget simply cannot be met inside the
 * bounds (sum of minima above it, or sum of maxima below it) - that is a config contradiction for
 * TuningValidation to report, not something to silently paper over here.
 */
export function renormalizeWithinBounds(raw, valueBudget, boundsOf) {
  const keys = Object.keys(raw);
  if (keys.length === 0 || !(valueBudget > 0)) return renormalizeWeights(raw, valueBudget);

  const lo = {}, hi = {};
  let sumLo = 0, sumHi = 0;
  keys.forEach(k => {
    const b = boundsOf(k) ?? {};
    lo[k] = b.min != null ? b.min : 0;
    hi[k] = b.max != null ? b.max : Infinity;
    sumLo += lo[k];
    sumHi += hi[k];
  });
  // Infeasible either way - no assignment inside the bounds sums to the budget.
  if (sumLo > valueBudget || sumHi < valueBudget) return renormalizeWeights(raw, valueBudget);

  const out = {};
  const clamped = new Set();
  keys.forEach(k => { out[k] = raw[k]; });

  for (let pass = 0; pass < keys.length + 2; pass++) {
    const free = keys.filter(k => !clamped.has(k));
    if (free.length === 0) break;
    const fixedTotal = keys.filter(k => clamped.has(k)).reduce((s, k) => s + out[k], 0);
    const freeRaw = free.reduce((s, k) => s + raw[k], 0);
    const remaining = valueBudget - fixedTotal;
    // Every free entry is zero-weighted: spread what is left evenly rather than dividing by zero.
    const scale = freeRaw > 0 ? remaining / freeRaw : 0;
    free.forEach(k => { out[k] = freeRaw > 0 ? raw[k] * scale : remaining / free.length; });

    let newlyClamped = false;
    free.forEach(k => {
      if (out[k] < lo[k]) { out[k] = lo[k]; clamped.add(k); newlyClamped = true; }
      else if (out[k] > hi[k]) { out[k] = hi[k]; clamped.add(k); newlyClamped = true; }
    });
    if (!newlyClamped) break;
  }
  return out;
}

export function renormalizeWeights(raw, valueBudget) {
  const rawTotal = Object.values(raw).reduce((a, b) => a + b, 0);
  const scale = valueBudget / rawTotal;
  const out = {};
  Object.keys(raw).forEach(s => { out[s] = raw[s] * scale; });
  return out;
}



/**
 * A copy of `paytable` with every payout multiplied by `scale`. Both the line-pay `payout` array
 * and the cluster `clusterPayout` tier list are scaled; everything else is carried through as-is,
 * and the input is never mutated.
 *
 * This is the one exact RTP lever there is: RTP is strictly proportional to a global multiplier on
 * every payout - verified on Candy Frenzy to 5 significant figures at both uniform and heavily
 * skewed frequencies (RTP/k constant at 9.791 and 21.754 respectively). Shared by the
 * closed-form payout solve and by the sensitivity sweep's own payoutScale ladder, so the two can
 * never disagree about what "scale the payouts by k" means.
 */
export function scalePaytable(paytable, scale) {
  const scaled = {};
  Object.keys(paytable).forEach(sym => {
    const entry = paytable[sym];
    const copy = { ...entry };
    if (Array.isArray(entry.clusterPayout)) {
      copy.clusterPayout = entry.clusterPayout.map(tier => ({ ...tier, multiplier: tier.multiplier * scale }));
    }
    if (Array.isArray(entry.payout)) {
      copy.payout = entry.payout.map(v => (typeof v === 'number' ? v * scale : v));
    }
    scaled[sym] = copy;
  });
  return scaled;
}

/**
 * Decides whether a payout-scale verification run actually confirmed the scaled paytable, and if
 * not, WHICH of the three possible reasons it was - rather than asserting one of them.
 *
 * The first version of this named a single culprit unconditionally ("your winEvaluator captured
 * its own paytable"). That is one real cause, and it is the one that motivated the check, but a
 * check run measured at 150k spins on a high-variance cascade game misses by more than the
 * tolerance routinely, and being told the wrong cause is worse than being told the result is
 * inconclusive: the developer goes and rewrites an evaluator that was never broken.
 *
 * The three cases are distinguishable from the numbers already in hand:
 *  - the run came back essentially where it started, i.e. scaling had NO effect -> the evaluator
 *    never read the paytable it was handed;
 *  - the miss is inside the run's own measurement noise -> the sample is too small to resolve a
 *    difference this size, and nothing is wrong except the spin count;
 *  - it moved, and moved further than noise explains, but not to where linearity requires -> this
 *    mechanic has a payout component that is not a plain multiplier.
 */
export function describePayoutScaleVerification({ rtpBeforeScaling, verifiedRtp, targetRtp, stdError = 0, tolerance }) {
  const miss = Math.abs(verifiedRtp - targetRtp);
  if (miss <= tolerance) return { verified: true, note: null };

  const shouldHaveMovedBy = Math.abs(targetRtp - rtpBeforeScaling);
  const movedBy = Math.abs(verifiedRtp - rtpBeforeScaling);
  // "Barely moved" is only meaningful when there was a real distance to cover in the first place;
  // a scale already within noise of 1 has nothing to detect.
  if (shouldHaveMovedBy > tolerance && movedBy < shouldHaveMovedBy * 0.25) {
    return {
      verified: false,
      note: 'Could not verify the scaled paytable: the check run came back at '
        + `${verifiedRtp.toFixed(2)}%, essentially unchanged from the ${rtpBeforeScaling.toFixed(2)}% measured before scaling, `
        + 'which means the win evaluator never read the scaled payouts at all. That is what happens when a game\'s '
        + 'winEvaluator is a closure over its own paytable (e.g. `(grid) => checkClusterWins(grid, PAYTABLE, ...)`) - '
        + 'overriding config.paytable has no effect on it. The scale itself is exact (RTP is strictly proportional to '
        + 'payout multipliers); pass `winEvaluatorFactory` so the check run can rebuild the evaluator around the scaled paytable.',
    };
  }

  if (stdError > 0 && miss <= stdError * 3) {
    return {
      verified: false,
      note: `Could not confirm the scaled paytable at this sample size: the check run measured ${verifiedRtp.toFixed(2)}% `
        + `against the ${targetRtp}% exact linearity requires, but its own standard error is ±${stdError.toFixed(2)}pp - `
        + 'the measurement is too noisy to resolve a difference this small. Nothing here suggests the scale is wrong; '
        + 'raise Trial Spins and/or Trials Averaged to confirm it.',
    };
  }

  return {
    verified: false,
    note: `Could not verify the scaled paytable: the check run measured ${verifiedRtp.toFixed(2)}% where exact linearity `
      + `requires ${targetRtp}%, and it moved too far to be explained by its own ±${stdError.toFixed(2)}pp measurement noise. `
      + 'Either this mechanic has a payout component that is not a plain multiplier (which would break the proportionality '
      + 'the solve relies on), or the check run needs more spins. Treat the scale as unconfirmed until one of those is ruled out.',
  };
}

export function beatsIncumbent(candidate, incumbent, z) {
  if (!incumbent) return true;
  const margin = z * Math.sqrt((candidate.trialRtpStdError ?? 0) ** 2 + (incumbent.trialRtpStdError ?? 0) ** 2);
  return (incumbent.loss - candidate.loss) > margin;
}