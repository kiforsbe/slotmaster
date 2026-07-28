/**
 * A pure functional simulator for the SlotMachine game logic.
 * It models spins without any visual or audio side effects.
 */
import { generateReel, createSeededRng, resolveFrequencyBounds } from './math/SlotMath.js';
import { LineMechanic } from './LineMechanic.js';
import { cmaes } from './CMAES.js';
import { validateTuningConfig } from './TuningValidation.js';
import { buildLadders, summarize } from './StructuralSensitivity.js';
import { structuralSearch } from './StructuralSearch.js';
import { volatilityBandToSigma, sigmaToVolatilityBand } from './TuningUnits.js';

/**
 * Simulates multiple spins and returns statistical analysis. Mechanic-agnostic: how one spin
 * actually resolves (draw a target grid and evaluate paylines vs. resolve a full cascade
 * sequence) is delegated to `config.mechanic` (core/LineMechanic.js's default, or
 * core/CascadeSpinMechanic.js for cluster-pays games) - this function only owns what's common
 * to both: the base-spin loop, free-spins triggering/retriggering/award-table lookups, the
 * global free-spins safety cap, and result aggregation (RTP, win distribution, spin log).
 * @param {Object} config - Game configuration with reelStrips, paytable, etc.
 * @param {Object} [config.mechanic] - A spin-resolution mechanic (see core/LineMechanic.js's
 *   `LineMechanic` export for the contract: `createFreeSpinsState(simConfig, rng)` and
 *   `resolveSpin({ simConfig, betPerLine, linesCount, rng, isFreeSpin, freeSpinsState,
 *   spinIndex, chargedBet, logSpins }) -> { spinWin, scatterWin, detailedWins, logEntry }`).
 *   Defaults to `LineMechanic` - every existing line-pay caller keeps working unchanged without
 *   ever passing this. Candy Frenzy (and any future cascade game) passes
 *   `CascadeSpinMechanic` from core/CascadeSpinMechanic.js instead.
 * @param {Object} [config.freeSpinsMode] - Cascade-mechanic-only: the pluggable free-spins
 *   payout mode (core/FreeSpinsModes.js) to simulate, passed straight through to
 *   `mechanic.createFreeSpinsState`. Ignored by LineMechanic.
 * @param {number} [config.freeSpinsCount=10] - Flat number of free spins awarded per trigger,
 *   used whenever the triggering scatter count isn't found in `freeSpinsAwardTable` (or that
 *   table is omitted entirely).
 * @param {Object} [config.freeSpinsAwardTable] - Optional `{ scatterCount: awardedSpins }` map
 *   for the free-spins award granted by a BASE-game trigger, mirroring a real game's own award
 *   schedule (e.g. `{ 3: 10, 4: 15, 5: 20 }`). Falls back to `freeSpinsCount` for any count not
 *   listed.
 * @param {Object} [config.retriggerFreeSpinsAwardTable] - Same shape, for a qualifying scatter
 *   hit landing DURING an active free-spins round (a retrigger). Defaults to
 *   `freeSpinsAwardTable` when omitted. Its mere presence (directly or via that default) is
 *   what enables retrigger simulation at all - if neither table is set, free spins run for
 *   exactly `freeSpinsCount` spins with no retriggers, matching this function's original
 *   behavior exactly.
 * @param {boolean} [config.logSpins=false] - When true, records one entry per simulated spin
 *   (base and free alike) in the returned `spinLog` array - spin index, phase, bet, total win,
 *   and a breakdown of every scatter/line/expanding/cluster win that spin produced. Off by
 *   default since it holds one object per spin in memory for the whole run (relevant at the
 *   default 1,000,000+ spin counts); turn it on for a dev-tooling export (see
 *   SimulationPanel.js's "EXPORT SPIN LOG" button), not for routine RTP measurement.
 * @param {boolean} [config.hasExpandingWild=false] - LineMechanic-only: whether free spins here
 *   include a Book-of-Dead-style expanding-wild bonus (a random non-scatter symbol picked fresh
 *   each free-spins session, expanding to fill any reel it lands on - see checkExpandingWins).
 *   Off by default - without this, free spins pay out exactly like the base game, just at no
 *   cost. Omitting it for a game that doesn't actually have this mechanic isn't just "leaving
 *   a feature off": this used to run unconditionally for ANY game with free spins regardless
 *   of whether its real engine flow ever calls enterFreeSpins with an expanding symbol,
 *   fabricating extra "expanding win" payouts (against a real, randomly-chosen paytable
 *   symbol, so not even a harmless no-op) that inflated RTP for any such game.
 * @param {number} numBaseSpins - Number of base spins to simulate (default 100000)
 * @param {number} betPerLine - Bet per line (default 1). Cascade games (no per-line concept)
 *   pass their flat bet amount here alongside `linesCount: 1`.
 * @param {number} linesCount - Number of active paylines (default 10). Cascade games pass 1.
 * @param {() => number} [rng=Math.random] - Random source for spin outcomes. Pass a seeded
 *   rng (e.g. createSeededRng(seed) from SlotMath.js) for a reproducible run; defaults to
 *   Math.random for today's non-deterministic behavior.
 * @returns {Object} Simulation results including RTP, win distribution, etc.
 */
// ---- Round-level win shape ----------------------------------------------------------------
// A ROUND is one paid spin plus every free spin it bought. That is the unit a player actually
// experiences, and it is not the unit `winDistribution` records: that keys individual SPINS, base
// and free alike, and free spins are charged no bet - so they inflate the hit rate and deflate the
// mean win. A game whose bonus pays 40x across 12 free spins looks like twelve small wins there
// and like one 40x round here, and only the second describes what it feels like to play.
//
// Accumulated as running moments plus a fixed log-spaced histogram rather than a list of rounds:
// `logSpins` already holds one object per spin and is off by default at a million spins for
// exactly that reason. This has to be cheap enough to leave on always, so it is a handful of
// counters and 61 buckets regardless of how many rounds run.
const ROUND_HISTOGRAM_MIN = 0.01;   // 0.01x bet
const ROUND_HISTOGRAM_MAX = 10000;  // 10,000x bet - above this everything lands in the top bucket
const ROUND_HISTOGRAM_BUCKETS = 60; // plus one dedicated zero bucket, hence 61 below

function createRoundAccumulator() {
  return {
    rounds: 0, hits: 0, sum: 0, sumSq: 0, max: 0,
    // buckets[0] is exactly zero (a losing round); 1..60 are log-spaced over [0.01x, 10000x].
    // Zero needs its own bucket because log(0) has nowhere to go and "no win" is the single most
    // common outcome in every game here - folding it into the smallest positive bucket would put
    // roughly half of all rounds into a bucket labelled "0.01x to 0.014x".
    buckets: new Array(ROUND_HISTOGRAM_BUCKETS + 1).fill(0),
  };
}

function roundBucketIndex(multiple) {
  if (!(multiple > 0)) return 0;
  const lo = Math.log(ROUND_HISTOGRAM_MIN);
  const hi = Math.log(ROUND_HISTOGRAM_MAX);
  const t = (Math.log(multiple) - lo) / (hi - lo);
  return 1 + Math.min(ROUND_HISTOGRAM_BUCKETS - 1, Math.max(0, Math.floor(t * ROUND_HISTOGRAM_BUCKETS)));
}

// Representative value of a bucket - its geometric midpoint, which is the right centre for a
// log-spaced bucket in the same way the arithmetic midpoint is for a linear one.
function roundBucketValue(index) {
  if (index === 0) return 0;
  const lo = Math.log(ROUND_HISTOGRAM_MIN);
  const hi = Math.log(ROUND_HISTOGRAM_MAX);
  const width = (hi - lo) / ROUND_HISTOGRAM_BUCKETS;
  return Math.exp(lo + (index - 1 + 0.5) * width);
}

function summarizeRounds(acc) {
  const { rounds, hits, sum, sumSq, max, buckets } = acc;
  if (rounds === 0) {
    return { rounds: 0, hitRate: 0, meanWin: 0, medianWin: 0, p90: 0, p99: 0, p999: 0, maxWin: 0, top1PctShare: 0, volatilityIndex: 0, histogram: [] };
  }
  const meanWin = sum / rounds;
  // Population standard deviation of the per-round return, in units of the bet. This IS the
  // volatility index the industry quotes - it is not a measurement-noise figure like
  // trialRtpStdError, and the two must never be read as the same kind of number.
  const variance = Math.max(0, sumSq / rounds - meanWin * meanWin);
  const volatilityIndex = Math.sqrt(variance);

  // Percentiles read off the histogram's cumulative counts. Bucket-resolution, and deliberately
  // so: an exact percentile would need every round retained, which is precisely the cost this
  // avoids. The buckets are ~19% wide, which is far finer than any decision made on these.
  const percentileAt = (p) => {
    const target = p * rounds;
    let seen = 0;
    for (let i = 0; i < buckets.length; i++) {
      seen += buckets[i];
      if (seen >= target) return roundBucketValue(i);
    }
    return max;
  };

  // What share of ALL payout the top 1% of rounds carries - the single most useful number for
  // "will this feel flat or spiky". Approximated from the histogram: walk down from the top until
  // 1% of rounds is accounted for, summing bucket value x count.
  const topCount = rounds * 0.01;
  let counted = 0, topSum = 0;
  for (let i = buckets.length - 1; i >= 0 && counted < topCount; i--) {
    const take = Math.min(buckets[i], topCount - counted);
    topSum += take * roundBucketValue(i);
    counted += take;
  }

  return {
    rounds,
    hitRate: hits / rounds,
    meanWin,
    medianWin: percentileAt(0.5),
    p90: percentileAt(0.9),
    p99: percentileAt(0.99),
    p999: percentileAt(0.999),
    maxWin: max,
    top1PctShare: sum > 0 ? Math.min(1, topSum / sum) : 0,
    volatilityIndex,
    // Emitted as {from, to, count} so a consumer can render or resample it without needing to
    // know how the bucketing works.
    // `index` is carried so several trials' stats can be merged back together EXACTLY
    // (mergeRoundStats) - without it the buckets could only be matched by floating-point value,
    // which is a needless way to introduce disagreement between two runs of the same code.
    histogram: buckets.map((count, i) => ({
      index: i,
      from: i === 0 ? 0 : roundBucketValue(i) / Math.exp((Math.log(ROUND_HISTOGRAM_MAX) - Math.log(ROUND_HISTOGRAM_MIN)) / ROUND_HISTOGRAM_BUCKETS / 2),
      to: i === 0 ? 0 : roundBucketValue(i) * Math.exp((Math.log(ROUND_HISTOGRAM_MAX) - Math.log(ROUND_HISTOGRAM_MIN)) / ROUND_HISTOGRAM_BUCKETS / 2),
      value: roundBucketValue(i),
      count,
    })).filter(b => b.count > 0),
  };
}

/**
 * Combines several trials' `roundStats` into one, as if every round had come from a single run.
 *
 * Needed because a candidate is measured over `trialsPerPoint` independent trials, and averaging
 * their percentiles would be wrong: the mean of two medians is not the median of the union. Every
 * quantity here is instead recovered back to its underlying counter (count, sum, sum of squares,
 * bucket tallies), added, and re-derived - so merging N trials gives exactly what one trial of N
 * times the length would have.
 */
export function mergeRoundStats(statsList) {
  const usable = (statsList ?? []).filter(s => s && s.rounds > 0);
  if (usable.length === 0) return summarizeRounds(createRoundAccumulator());
  if (usable.length === 1) return usable[0];
  const acc = createRoundAccumulator();
  usable.forEach(s => {
    acc.rounds += s.rounds;
    acc.hits += Math.round(s.hitRate * s.rounds);
    acc.sum += s.meanWin * s.rounds;
    // variance = E[x^2] - mean^2, so E[x^2] = variance + mean^2 and the sum of squares follows.
    acc.sumSq += (s.volatilityIndex * s.volatilityIndex + s.meanWin * s.meanWin) * s.rounds;
    if (s.maxWin > acc.max) acc.max = s.maxWin;
    (s.histogram ?? []).forEach(b => { acc.buckets[b.index] += b.count; });
  });
  return summarizeRounds(acc);
}

export function simulateSpins(config, numBaseSpins = 100000, betPerLine = 1, linesCount = 10, rng = Math.random) {
  // Input validation
  if (!config || !config.reelStrips || !config.paytable) {
    throw new Error('Invalid config: reelStrips and paytable required');
  }
  if (numBaseSpins <= 0 || betPerLine <= 0 || linesCount <= 0) {
    throw new Error('All numeric parameters must be positive');
  }

  const results = {
    totalBets: 0,
    totalWins: 0,
    winDistribution: {}, // winAmount -> count
    detailedWins: [],     // New: Detailed breakdown of every win
    spinLog: [],           // Populated only when config.logSpins is true (see its own doc)
    scatterCounts: 0,
    maxWin: 0,
    minWin: Infinity,
    freeSpinsTriggered: 0,
    totalSimulatedSpins: 0
  };

  const simConfig = { ...config };
  simConfig.linesCount = linesCount;
  simConfig.betPerLine = betPerLine;
  simConfig.totalBet = betPerLine * linesCount;

  const mechanic = simConfig.mechanic || LineMechanic;

  // Get configuration values with defaults
  const freeSpinsCount = simConfig.freeSpinsCount || 10;
  // Optional { scatterCount: awardedSpins } lookups mirroring a real game's own award
  // schedule (e.g. barfruits' FREQUENCY_REEL-adjacent FREE_SPINS_AWARD = {3:10, 4:15, 5:20}).
  // Absent -> awardFor() falls back to the flat freeSpinsCount above, unchanged from before
  // these existed. retriggerFreeSpinsAwardTable additionally defaults to freeSpinsAwardTable
  // when only one is given, since most games use the same schedule for both; its mere
  // presence is what turns retrigger simulation on at all (see supportsRetrigger below) - a
  // config that sets neither table keeps the exact old behavior (flat freeSpinsCount spins,
  // no retriggers), so this is purely additive for any existing caller.
  const freeSpinsAwardTable = simConfig.freeSpinsAwardTable || null;
  const retriggerFreeSpinsAwardTable = simConfig.retriggerFreeSpinsAwardTable || freeSpinsAwardTable;
  const supportsRetrigger = retriggerFreeSpinsAwardTable != null;
  const awardFor = (table, count) => (table && table[count] != null) ? table[count] : freeSpinsCount;
  // Bounds the TOTAL free spins run across the whole call, not just one chain - a per-chain-only
  // cap still allows worst-case total work of numBaseSpins * cap, which for a candidate/baseline
  // with an extremely high trigger+retrigger rate (very plausible mid-search, before Phase 1 has
  // scaled anything down yet, or simply while a game's frequencies are still being hand-tuned)
  // could take impractically long even though each individual chain is itself bounded. Scaling
  // with numBaseSpins keeps a larger requested simulation proportionally better sampled while
  // still keeping worst-case runtime roughly O(numBaseSpins) regardless of how pathological the
  // configured frequencies are.
  const FREE_SPINS_GLOBAL_CAP = Math.max(numBaseSpins * 20, 50000);
  let totalFreeSpinsRun = 0;
  const logSpins = !!simConfig.logSpins;

  // Runs one spin (base or free) via the active mechanic, then folds its result into `results` -
  // the one piece of bookkeeping every mechanic shares, regardless of how it resolved the grid.
  function runOneSpin(isFreeSpin, freeSpinsState) {
    const chargedBet = isFreeSpin ? 0 : simConfig.totalBet;
    if (!isFreeSpin) results.totalBets += chargedBet;
    results.totalSimulatedSpins++;

    const { spinWin, scatterWin, detailedWins, logEntry } = mechanic.resolveSpin({
      simConfig, betPerLine, linesCount, rng, isFreeSpin, freeSpinsState,
      spinIndex: results.totalSimulatedSpins, chargedBet, logSpins,
    });

    if (scatterWin) {
      results.scatterCounts += scatterWin.count;
      if (scatterWin.triggerFreeSpins) results.freeSpinsTriggered++;
    }

    results.totalWins += spinWin;
    if (spinWin > results.maxWin) results.maxWin = spinWin;
    if (spinWin < results.minWin) results.minWin = spinWin;
    results.winDistribution[spinWin] = (results.winDistribution[spinWin] || 0) + 1;
    // Every spin's win joins the round currently open - free spins included, which is the whole
    // point: the bonus they pay belongs to the paid spin that bought it.
    roundWin += spinWin;
    detailedWins.forEach(w => results.detailedWins.push(w));
    if (logSpins && logEntry) results.spinLog.push(logEntry);

    return { scatterWin };
  }

  // The round currently being accumulated. Reset by the base-spin loop, added to by every spin.
  let roundWin = 0;
  const roundAcc = createRoundAccumulator();
  const closeRound = () => {
    // In units of the bet, so the figures are comparable across games and bet sizes - and so
    // `meanWin` is exactly `rtpRaw`, which is what makes the two reconcilable.
    const multiple = simConfig.totalBet > 0 ? roundWin / simConfig.totalBet : 0;
    roundAcc.rounds++;
    if (multiple > 0) roundAcc.hits++;
    roundAcc.sum += multiple;
    roundAcc.sumSq += multiple * multiple;
    if (multiple > roundAcc.max) roundAcc.max = multiple;
    roundAcc.buckets[roundBucketIndex(multiple)]++;
  };

  // Main simulation loop for base spins
  for (let i = 0; i < numBaseSpins; i++) {
    roundWin = 0;
    const result = runOneSpin(false, null);

    // If free spins were triggered by this base spin, simulate them (unless the global free
    // spins budget is already exhausted - base spins keep running either way, so the base-game
    // RTP/trigger-rate signal stays representative even once free-spin payouts are truncated).
    if (result.scatterWin && result.scatterWin.triggerFreeSpins && totalFreeSpinsRun < FREE_SPINS_GLOBAL_CAP) {
      // Built once per round (e.g. LineMechanic randomizes an expanding symbol,
      // CascadeSpinMechanic inits a free-spins-mode's persistent state) - never rebuilt by a
      // retrigger extending this same round.
      const freeSpinsState = mechanic.createFreeSpinsState(simConfig, rng);

      // A real free-spins round can retrigger itself (another qualifying scatter hit during
      // the bonus adds more spins on top, same as the live engine's retriggerFreeSpins) - the
      // remaining-spins count grows as the loop runs rather than being fixed up front.
      let freeSpinsRemaining = awardFor(freeSpinsAwardTable, result.scatterWin.count);
      let freeSpinsRun = 0;
      while (freeSpinsRun < freeSpinsRemaining && totalFreeSpinsRun < FREE_SPINS_GLOBAL_CAP) {
        const fsResult = runOneSpin(true, freeSpinsState);
        freeSpinsRun++;
        totalFreeSpinsRun++;
        if (supportsRetrigger && fsResult.scatterWin && fsResult.scatterWin.triggerFreeSpins) {
          freeSpinsRemaining += awardFor(retriggerFreeSpinsAwardTable, fsResult.scatterWin.count);
        }
      }
    }
    // After the free-spins chain, so the round carries what the bonus paid. This is exactly the
    // boundary the loop already had; nothing needed restructuring to find it.
    closeRound();
  }

  const rtp = results.totalBets > 0 ? (results.totalWins / results.totalBets) * 100 : 0;

  return {
    rtp: rtp.toFixed(2) + '%',
    rtpRaw: results.totalBets > 0 ? (results.totalWins / results.totalBets) : 0,
    totalSpins: results.totalSimulatedSpins,
    baseSpins: numBaseSpins,
    totalBets: results.totalBets,
    totalWins: results.totalWins,
    maxWin: results.maxWin,
    minWin: results.minWin === Infinity ? 0 : results.minWin,
    scatterCounts: results.scatterCounts,
    freeSpinsTriggered: results.freeSpinsTriggered,
    winDistribution: results.winDistribution,
    detailedWins: results.detailedWins,
    spinLog: results.spinLog,
    // The SHAPE of the payout, per round rather than per spin - see createRoundAccumulator.
    // Always produced: it costs a handful of counters and a fixed 61-bucket histogram, which is
    // cheap enough that making it optional would only add a way to not have the answer.
    roundStats: summarizeRounds(roundAcc),
  };
}

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
 * Generic 1D root-finder for tuning a single parameter against a target scalar metric,
 * replacing bisection with a gradient-informed step: at each iteration, the local
 * derivative of the metric with respect to the (log-space) parameter is estimated via a
 * finite difference, then the parameter is moved directly toward the target by an amount
 * proportional to (targetGap / estimatedSlope) - equivalent to a gradient descent step on
 * the squared-error loss (metric - target)^2, with the step size self-normalized by the
 * local slope instead of a fixed learning rate. That self-normalization is what keeps it
 * numerically stable across metrics with very different natural scales (a trigger rate
 * near 1% vs an RTP near 100%) without per-phase learning-rate tuning.
 *
 * Parameterized in log-space (x = ln(param)) since every tuned parameter here is a
 * positive multiplicative scale factor - a fixed step in x is a fixed *relative* change
 * in param regardless of its current magnitude.
 *
 * Uses common random numbers for the finite difference: both probe points in a step share
 * the same seed, so the estimated slope reflects the parameter change, not two independent
 * noisy Monte Carlo draws (measure() is stochastic unless given a fixed seed).
 *
 * Costs up to 2 simulated measurements per iteration (vs 1 for plain bisection) - the
 * probe measurement is skipped once tolerance is met or on the final iteration.
 *
 * @param {Object} args
 * @param {number} args.initialParam - Starting parameter value (> 0).
 * @param {number} args.minParam - Lower clamp (> 0).
 * @param {number} args.maxParam - Upper clamp (>= minParam).
 * @param {number} args.target - Target value for the metric.
 * @param {number} args.tolerance - Stop early once |metric - target| <= tolerance.
 * @param {(param: number) => Object} args.buildTrial - Builds a trial from a parameter value.
 * @param {(measureResult: Object) => number} args.metricOf - Extracts the scalar metric from a measure() result.
 * @param {(trial: Object, rngSeed: number) => (Object|Promise<Object>)} args.measure - Measures a
 *   trial (seeded, for CRN). May return a plain object or a Promise - always awaited, so a
 *   caller whose measurements run on a Worker pool (real parallelism) and one whose measurements
 *   run in-process (today's default) both work unchanged.
 * @param {number} args.maxIterations - Number of gradient steps.
 * @param {number} args.seedBase - Base seed for this phase's steps (offset per phase/mode to avoid correlated noise between phases).
 * @param {(i: number, param: number, result: Object & {error: number}, best: Object) => (void|Promise<void>)} [args.onProgress]
 * @param {(info: { iteration: number, operation: 'widen-probe', probeAttempt: number }) => (void|Promise<void>)} [args.onBusy] -
 *   Fired once the first slope probe comes back exactly flat and this iteration is about to
 *   spend several more (up to 7 further) measurements widening/flipping direction to find one -
 *   without this, that extra work is invisible between one onProgress call and the next. Never
 *   fired for the common case (a measurable slope on the first try). If widening drags on, it
 *   fires again with an updated `probeAttempt`, throttled to at most once every
 *   `busyReportIntervalMs` of real time - a plateau that resolves within a probe or two only
 *   ever fires once.
 * @param {number} [args.busyReportIntervalMs=300] - Minimum real time between successive
 *   `onBusy` calls within the same widen-probe search (see above).
 * @param {() => Promise<void>} args.yieldToEventLoop
 * @param {number} [args.trustFactor=0.8] - Fraction of the suggested step actually taken each
 *   iteration (damping against noisy slope estimates); decays each step.
 * @param {number} [args.trustFactorDecay=0.9]
 * @param {number} [args.epsilon=0.05] - Finite-difference probe distance in log-space.
 * @param {AbortSignal} [args.signal] - Checked once per iteration, after that iteration's own
 *   measurement (so `best` is always already set) and before the potentially-expensive
 *   widen-probe section - cooperative cancellation stops there rather than throwing.
 * @returns {Promise<{ mult: number, error: number, result: Object, trial: Object, converged: boolean }>} -
 *   `converged` is true iff the best candidate found landed within `tolerance` of `target`;
 *   false means the search exhausted its iterations (or every direction was a flat
 *   plateau) without reaching the target - callers should surface this rather than
 *   silently treating `best` as a successful tune.
 */
export async function gradientDescent1D({
  initialParam, minParam, maxParam, target, tolerance,
  buildTrial, metricOf, measure, maxIterations, seedBase,
  onProgress, onBusy, yieldToEventLoop,
  trustFactor = 0.8, trustFactorDecay = 0.9, epsilon = 0.05,
  busyReportIntervalMs = 300,
  signal = null,
}) {
  const minX = Math.log(minParam);
  const maxX = Math.log(maxParam);
  let x = Math.min(maxX, Math.max(minX, Math.log(initialParam)));
  let trust = trustFactor;
  let best = null;

  for (let i = 0; i < maxIterations; i++) {
    const stepSeed = seedBase + i * 7919;
    const param = Math.exp(x);
    const trial = buildTrial(param);
    const result = await measure(trial, stepSeed);
    const metric = metricOf(result);
    const error = Math.abs(metric - target);
    const resultWithError = { ...result, error };
    if (!best || error < best.error) best = { mult: param, error, result, trial };
    if (onProgress) await onProgress(i, param, resultWithError, best);
    await yieldToEventLoop();
    if (error <= tolerance || i === maxIterations - 1) break;
    // Checked after `best` is already guaranteed set from this iteration's own measurement (so
    // stopping here never leaves the caller without a usable result) and before the potentially
    // expensive widen-probe section below - a user-requested stop shouldn't spend several more
    // measurements searching for a slope it's about to discard anyway.
    if (signal?.aborted) break;

    // Probe for a measurable slope, widening the probe distance (and, failing that,
    // trying the opposite direction) when the first probe lands on a flat plateau -
    // generateReel() rounds symbol counts to whole numbers per reel, so a small parameter
    // change can measure as an *exactly* zero slope even though the metric does move at a
    // larger step. Without this, the search stalls permanently at the first such plateau
    // (trust decays every iteration regardless, but x itself never moves).
    let slope = 0, usedDx = epsilon;
    let probeAttempt = 0;
    let reportedBusy = false;
    let lastBusyReportTime = 0;
    outer: for (const sign of [1, -1]) {
      for (let widen = 1; widen <= 8; widen *= 2) {
        probeAttempt++;
        // First fired once the FIRST probe has already come back flat and this iteration is
        // about to spend several more measurements widening/flipping to escape the plateau -
        // not per probe attempt (up to 8 total). After that, fired again at most once every
        // `busyReportIntervalMs` of real time (not once per remaining probe) - a plateau that
        // resolves within a couple of probes reports once; one that grinds through several
        // gets an occasional "still on it" heartbeat with an updated attempt count, without a
        // log line per measurement.
        if (onBusy && probeAttempt >= 2) {
          const now = Date.now();
          if (!reportedBusy || now - lastBusyReportTime >= busyReportIntervalMs) {
            reportedBusy = true;
            lastBusyReportTime = now;
            await onBusy({ iteration: i, operation: 'widen-probe', probeAttempt });
          }
        }
        const xProbe = Math.min(maxX, Math.max(minX, x + sign * epsilon * widen));
        const dx = xProbe - x;
        if (dx === 0) continue;
        const probeResult = await measure(buildTrial(Math.exp(xProbe)), stepSeed);
        slope = (metricOf(probeResult) - metric) / dx;
        if (slope !== 0) { usedDx = dx; break outer; }
      }
    }
    if (slope !== 0) {
      // Cap the step to a small multiple of the distance actually probed - a shallow slope
      // measured only because the probe had to widen to escape a flat plateau is a coarse,
      // low-confidence estimate; extrapolating it at full strength is what previously sent
      // the search flying from one end of the parameter range to the other in a single step.
      const rawStep = ((target - metric) / slope) * trust;
      const maxStep = Math.abs(usedDx) * 4;
      const step = Math.max(-maxStep, Math.min(maxStep, rawStep));
      x = Math.min(maxX, Math.max(minX, x + step));
    }
    trust *= trustFactorDecay;
  }

  return { ...best, converged: best.error <= tolerance };
}

/**
 * Monotone 1-D bisection root-finder: finds the `param` whose measured metric lands within
 * `tolerance` of `target`, assuming the metric is monotone NON-DECREASING in `param`.
 *
 * This exists because gradientDescent1D is the wrong algorithm class for Phase 1's actual
 * objective. Trigger rate is not a smooth function of the scatter-frequency multiplier - it's
 * a coarse STEP function, because generateReel() converts each symbol's share into a whole
 * number of strip positions (`Math.max(1, Math.round(share * targetLength))`, see
 * core/SlotMath.js). Every multiplier inside one rounding bucket produces a byte-identical reel
 * strip and therefore an *exactly* identical measurement. Measured on games/bookbookbook at its
 * real REEL_LENGTH of 500, the multiplier range 0.70..1.36 contains only 13 distinct reachable
 * trigger rates, on plateaus 5-10% wide in multiplier.
 *
 * That breaks slope-based search in three compounding ways: (1) the finite-difference probe
 * (epsilon 0.05 log units = 5.1%) is usually NARROWER than a plateau, so the measured slope is
 * exactly zero and the widen-probe fallback burns up to 8 extra measurements hunting for one;
 * (2) when widening finally crosses a step edge, the "slope" is a secant across a
 * discontinuity, and the resulting Newton step (capped at 4x the probe distance, i.e. up to
 * ~49% in multiplier) overshoots the target window by several whole plateaus - the search
 * visibly flings between extremes on either side of the target; (3) `trust` decays every
 * iteration including the wasted plateau ones, so the step budget is exhausted before the
 * search settles anywhere.
 *
 * Bisection has none of those failure modes: it never estimates a slope, so a plateau is not a
 * special case and cannot stall it; it can never overshoot, since the answer stays bracketed by
 * construction; and it converges in ~log2(range/precision) iterations at ONE measurement each,
 * against gradientDescent1D's up-to-nine.
 *
 * Bisection also makes the genuinely-unreachable case detectable rather than silent. Because
 * the reachable metric values form a coarse lattice, a target can fall in the GAP between two
 * adjacent achievable values, in which case no multiplier satisfies `tolerance` and no search
 * of any kind can succeed. `reason: 'lattice-gap'` reports exactly that (with the closest
 * achievable value either side in `bracket`), instead of burning the whole iteration budget and
 * reporting a bare "did not converge" that reads like a tuning failure. The fix for that case
 * is a longer reel strip (a finer lattice) or a wider tolerance - not more search.
 *
 * Uses ONE fixed measurement seed for every evaluation, deliberately: the strips themselves are
 * already deterministic (generateReel is seeded per reel from `reelSeeds`, not from the
 * measurement seed), so holding the measurement seed fixed makes the whole objective a
 * deterministic monotone step function. That is what keeps the bracket invariant sound - a
 * per-iteration seed would let Monte Carlo noise flip a comparison and discard the half of the
 * range actually containing the answer, which bisection cannot recover from.
 *
 * @param {Object} args
 * @param {number} args.initialParam - Starting parameter (> 0). Measured FIRST, so a baseline
 *   already within tolerance costs exactly one measurement and returns unchanged - preserving
 *   the "trigger symbol's frequency doesn't need to change at all" fast path.
 * @param {number} args.minParam - Lower clamp (> 0).
 * @param {number} args.maxParam - Upper clamp (>= minParam).
 * @param {number} args.target - Target value for the metric.
 * @param {number} args.tolerance - Success means |metric - target| <= this.
 * @param {(param: number) => Object} args.buildTrial - Builds a trial from a parameter value.
 * @param {(measureResult: Object) => number} args.metricOf - Extracts the scalar metric.
 * @param {(trial: Object, rngSeed: number) => (Object|Promise<Object>)} args.measure
 * @param {number} args.maxIterations - Hard cap on total measurements.
 * @param {number} args.seedBase - The single measurement seed used for every evaluation.
 * @param {number} [args.latticeTolerance=0.002] - Bracket width in log-space below which the
 *   reachable lattice is considered exhausted (0.002 log units = 0.2% in param, far finer than
 *   any real rounding plateau). Reaching it means the target sits in a gap between two
 *   achievable values.
 * @param {(i: number, param: number, result: Object & {error: number}, best: Object) => (void|Promise<void>)} [args.onProgress]
 * @param {(info: { iteration: number, operation: 'bracket', endpoint: 'min'|'max' }) => (void|Promise<void>)} [args.onBusy] -
 *   Fired before each of the up-to-two range-endpoint measurements taken to establish the
 *   initial bracket - the only step here that isn't a plain halving, and the one a caller would
 *   otherwise see as an unexplained pause.
 * @param {() => Promise<void>} args.yieldToEventLoop
 * @param {AbortSignal} [args.signal] - Checked between measurements, after `best` is set.
 * @returns {Promise<{ mult: number, error: number, result: Object, trial: Object, converged: boolean, reason: string, bracket: Object }>} -
 *   `reason` is one of 'converged' | 'unreachable-low' (even `maxParam` measures below the
 *   target band) | 'unreachable-high' (even `minParam` measures above it) | 'lattice-gap' |
 *   'exhausted' | 'stopped'. `converged` is true iff `reason === 'converged'`.
 */
export async function bisect1D({
  initialParam, minParam, maxParam, target, tolerance,
  buildTrial, metricOf, measure, maxIterations, seedBase,
  latticeTolerance = 0.002,
  onProgress, onBusy, yieldToEventLoop,
  signal = null,
}) {
  const minX = Math.log(minParam);
  const maxX = Math.log(maxParam);
  const clampX = (x) => Math.min(maxX, Math.max(minX, x));

  let best = null;
  let evaluations = 0;

  async function evalAt(x) {
    const param = Math.exp(x);
    const trial = buildTrial(param);
    const result = await measure(trial, seedBase);
    const metric = metricOf(result);
    const error = Math.abs(metric - target);
    if (!best || error < best.error) best = { mult: param, error, result, trial, metric };
    if (onProgress) await onProgress(evaluations, param, { ...result, error }, best);
    evaluations++;
    await yieldToEventLoop();
    return metric;
  }

  let bracketInfo = null;
  const finish = (reason) => ({
    ...best,
    converged: reason === 'converged',
    reason,
    bracket: bracketInfo,
  });

  // The starting point is measured before anything else, so the common "baseline already sits
  // inside the target band" case costs exactly one measurement and leaves the parameter alone.
  const startX = clampX(Math.log(initialParam));
  const startMetric = await evalAt(startX);
  if (best.error <= tolerance) return finish('converged');
  if (signal?.aborted) return finish('stopped');

  // Establish a bracket by measuring whichever range endpoint lies on the far side of the
  // target from the starting point - monotonicity is what makes one endpoint sufficient.
  let loX, hiX, loMetric, hiMetric;
  if (startMetric < target) {
    loX = startX; loMetric = startMetric;
    if (onBusy) await onBusy({ iteration: evaluations, operation: 'bracket', endpoint: 'max' });
    hiX = maxX; hiMetric = await evalAt(maxX);
  } else {
    hiX = startX; hiMetric = startMetric;
    if (onBusy) await onBusy({ iteration: evaluations, operation: 'bracket', endpoint: 'min' });
    loX = minX; loMetric = await evalAt(minX);
  }
  bracketInfo = { loParam: Math.exp(loX), hiParam: Math.exp(hiX), loMetric, hiMetric };

  if (best.error <= tolerance) return finish('converged');
  if (signal?.aborted) return finish('stopped');
  // The whole reachable range sits on one side of the target band - no multiplier can work.
  if (hiMetric < target) return finish('unreachable-low');
  if (loMetric > target) return finish('unreachable-high');

  while (evaluations < maxIterations) {
    if (signal?.aborted) return finish('stopped');
    // The bracket has collapsed to a span far narrower than any rounding plateau, yet neither
    // side is in band: the target genuinely falls between two adjacent achievable values.
    if (hiX - loX < latticeTolerance) return finish('lattice-gap');

    const midX = (loX + hiX) / 2;
    const midMetric = await evalAt(midX);
    if (best.error <= tolerance) return finish('converged');
    if (midMetric < target) { loX = midX; loMetric = midMetric; }
    else { hiX = midX; hiMetric = midMetric; }
    bracketInfo = { loParam: Math.exp(loX), hiParam: Math.exp(hiX), loMetric, hiMetric };
  }
  return finish('exhausted');
}

/**
 * Generic Nelder-Mead simplex minimizer over an n-dimensional parameter vector.
 * Derivative-free - compares function values across n+1 simplex vertices (reflect, expand,
 * contract, shrink) rather than estimating a gradient - the standard choice (same algorithm
 * behind scipy.optimize.minimize(method='Nelder-Mead') / MATLAB's fminsearch) for objectives
 * that are noisy or expensive to differentiate, both true here: `evaluate` wraps a Monte
 * Carlo RTP measurement, not a closed-form function, and a numerical gradient across many
 * dimensions would need one extra evaluation per dimension per iteration, where Nelder-Mead
 * typically needs only one or two.
 *
 * Callers are responsible for their own CRN (common random numbers) discipline if
 * `evaluate` wraps something stochastic - e.g. closing over one fixed RNG seed for the
 * whole call, so every point (old or new) is evaluated under directly comparable
 * conditions and vertices never need re-evaluating just because time passed.
 *
 * Every vertex evaluation is awaited, so `evaluate` may be sync or async - a plain in-process
 * evaluate() works exactly as before, but one backed by a Worker pool (see
 * core/SimulationWorkerPool.js) gets genuine parallelism for free: the initial n+1-vertex
 * simplex and every simplex shrink (also n+1 vertices, and the one operation here that
 * re-evaluates the whole simplex at once) are dispatched together via Promise.all rather than
 * one at a time, so a pool-backed evaluate() measures every vertex concurrently instead of
 * queuing them on a single thread. Reflect/expand/contract stay sequential (each depends on
 * the previous result), but still benefit from whatever parallelism `evaluate` itself does
 * internally (e.g. averaging several trials per candidate across the pool).
 *
 * @param {Object} args
 * @param {number[]} args.initialPoint - Starting parameter vector.
 * @param {number} args.initialStepSize - Perturbation used to build the initial simplex
 *   (vertex i = initialPoint with dimension i-1 offset by this amount).
 * @param {(point: number[]) => ({ loss: number, [key: string]: any } | Promise<{ loss: number, [key: string]: any }>)} args.evaluate -
 *   Evaluates one point; must return (or resolve to) at least `{ loss }` (lower is better).
 *   Any extra fields are carried through onto the vertex object returned via onProgress/result.
 * @param {number} args.maxIterations
 * @param {number} [args.convergenceTolerance=1e-4] - Stop early once the spread between the
 *   simplex's best and worst loss is at or below this.
 * @param {(iteration: number, point: number[], result: Object, best: Object, attempted: Object|null) => (void|Promise<void>)} [args.onProgress] -
 *   `result`/`point` are the simplex's own best vertex (`vertices[0]`) *entering* this
 *   iteration - since only the worst vertex is normally replaced, this can be unchanged for
 *   several iterations in a row even though each one genuinely tried something new. `attempted`
 *   is that new thing: the actual vertex this iteration's reflect/expand/contract produced (or
 *   the best of a shrink's whole re-evaluated batch), regardless of whether it improved on
 *   `result`/`best` - `null` only when this iteration had nothing to try (already converged).
 *   Use `attempted` to show "what was just tried" distinct from "the best found so far", so a
 *   run of no-improvement iterations reads as active search rather than a frozen repeat.
 * @param {(info: { iteration: number, operation: 'shrink', verticesToEvaluate: number, verticesEvaluated?: number }) => (void|Promise<void>)} [args.onBusy] -
 *   Fired once per iteration, only when reflection, expansion, AND contraction all failed to
 *   improve and the whole simplex is about to shrink - the one operation here that re-evaluates
 *   every vertex (`verticesToEvaluate` = n+1) instead of just one or two, so it's the main
 *   source of a "stuck" gap between one onProgress call and the next in a high-dimensional
 *   search. Never fired for a plain reflection/expansion/contraction (1-2 evaluates - not
 *   worth a separate notification). The first call (before any vertex in this shrink has been
 *   re-evaluated) omits `verticesEvaluated`; while the shrink is actually running, it fires
 *   again at most once every `busyReportIntervalMs` of real time, each time with
 *   `verticesEvaluated` set - a shrink that finishes quickly never gets a second call, one that
 *   takes a while gets an occasional progress update instead of one call per vertex.
 * @param {number} [args.busyReportIntervalMs=300] - Minimum real time between successive
 *   `onBusy` progress updates within the same shrink (see above). Lower only for tests that
 *   need every vertex's update to fire deterministically.
 * @param {() => Promise<void>} args.yieldToEventLoop
 * @param {AbortSignal} [args.signal] - Checked once per iteration, before that iteration's own
 *   reflect/expand/contract/shrink work starts (safe even on iteration 0 - `best` is already
 *   valid from the initial simplex) - cooperative cancellation stops there rather than
 *   throwing, returning whatever `best` has been found so far with `iterations` less than
 *   `maxIterations`.
 * @returns {Promise<{ point: number[], loss: number, result: Object, iterations: number, converged: boolean }>} -
 *   `converged` is true iff the search stopped because the simplex's spread collapsed below
 *   `convergenceTolerance`, not because `maxIterations` ran out.
 */
export async function nelderMead({
  initialPoint, initialStepSize, evaluate, maxIterations,
  convergenceTolerance = 1e-4, onProgress, onBusy, yieldToEventLoop,
  busyReportIntervalMs = 300,
  signal = null,
}) {
  const n = initialPoint.length;
  const ALPHA = 1, GAMMA = 2, RHO = 0.5, SIGMA = 0.5;

  // `evaluate` may be sync or async (see its own caller's doc) - always awaited here so both
  // work unchanged. Awaiting a plain (non-Promise) value just resolves it on the next
  // microtask, so this is a no-op behavior change for every existing in-process caller; it's
  // what lets a caller whose `evaluate` dispatches to a Worker pool get genuine concurrency
  // out of the Promise.all batches below (initial simplex, shrink) without this function
  // needing to know or care whether that's happening.
  const evalPoint = async (point) => ({ point, ...(await evaluate(point)) });

  // Initial simplex: vertex 0 = initialPoint, vertex i (1..n) = initialPoint with dimension
  // i-1 perturbed by initialStepSize - the standard right-angled starting simplex. All n+1
  // vertices are independent of each other, so they're dispatched together via Promise.all
  // rather than one at a time - when `evaluate` is backed by a Worker pool, this lets every
  // vertex measure concurrently on its own thread instead of queuing behind the others.
  const initialVertexPoints = [initialPoint.slice()];
  for (let i = 0; i < n; i++) {
    const p = initialPoint.slice();
    p[i] += initialStepSize;
    initialVertexPoints.push(p);
  }
  let vertices = await Promise.all(initialVertexPoints.map(p => evalPoint(p)));

  let best = vertices.reduce((a, b) => (b.loss < a.loss ? b : a));
  let iterations = 0;
  let converged = false;

  for (let iter = 0; iter < maxIterations; iter++) {
    // `best` is already valid from the initial simplex above, so it's safe to stop here before
    // this iteration's own work even starts - unlike cmaes/gradientDescent1D, which only get a
    // usable `best` partway through their own first iteration (see their own signal-check
    // placement for why).
    if (signal?.aborted) break;
    iterations = iter + 1;
    vertices.sort((a, b) => a.loss - b.loss);
    if (vertices[0].loss < best.loss) best = vertices[0];

    // Checked here (before this iteration's own reflect/expand/contract/shrink work), same as
    // before - but the actual `break` is deferred to after onProgress fires below, so a
    // converged iteration still gets exactly one onProgress call reporting `attempted: null`
    // (nothing needed trying) rather than silently skipping it.
    const alreadyConverged = vertices[n].loss - vertices[0].loss <= convergenceTolerance;

    // The vertex this iteration's own work actually produced (reflected/expanded/contracted, or
    // the best of a shrink's batch) - distinct from `vertices[0]`/`best` above, which only ever
    // reflect a *previous* iteration's outcome until the *next* iteration's sort catches up.
    // Without this, a run of iterations that each try something new but fail to beat the
    // existing best all log the exact same "best so far" value, indistinguishable from a search
    // that's doing nothing at all - reporting the raw attempt too (even when it wasn't an
    // improvement) is what lets a caller show "this is what was just tried" alongside "this is
    // the best found so far". `null` when this iteration had nothing to try (already converged).
    let attempted = null;

    if (!alreadyConverged) {
      const worst = vertices[n];
      const centroid = new Array(n).fill(0);
      for (let i = 0; i < n; i++) {
        vertices[i].point.forEach((x, d) => { centroid[d] += x / n; });
      }

      const reflectedPoint = centroid.map((c, d) => c + ALPHA * (c - worst.point[d]));
      const reflected = await evalPoint(reflectedPoint);

      if (reflected.loss < vertices[0].loss) {
        // Better than the current best - try pushing further in the same direction.
        const expandedPoint = centroid.map((c, d) => c + GAMMA * (reflectedPoint[d] - c));
        const expanded = await evalPoint(expandedPoint);
        attempted = expanded.loss < reflected.loss ? expanded : reflected;
        vertices[n] = attempted;
      } else if (reflected.loss < vertices[n - 1].loss) {
        // Better than the second-worst - accept the plain reflection.
        attempted = reflected;
        vertices[n] = reflected;
      } else {
        // Reflection didn't help enough - contract toward whichever of {reflected, worst} is
        // better ("outside" vs "inside" contraction), or shrink the whole simplex toward the
        // best vertex if even that fails.
        const useOutside = reflected.loss < worst.loss;
        const basePoint = useOutside ? reflectedPoint : worst.point;
        const contractedPoint = centroid.map((c, d) => c + RHO * (basePoint[d] - c));
        const contracted = await evalPoint(contractedPoint);
        const contractedBetter = useOutside ? contracted.loss <= reflected.loss : contracted.loss < worst.loss;
        if (contractedBetter) {
          attempted = contracted;
          vertices[n] = contracted;
        } else {
          if (onBusy) await onBusy({ iteration: iter, operation: 'shrink', verticesToEvaluate: n + 1 });
          const bestPoint = vertices[0].point;
          // Every shrunk vertex is independent of the others, so all n+1 are dispatched together
          // via Promise.all rather than one at a time - when `evaluate` is backed by a Worker
          // pool, this is the single biggest win for a high-dimensional search (e.g. Candy
          // Frenzy's ~84 tunable dims: an 85-vertex shrink that used to run 85 measurements
          // back to back on one core now spreads across every available core at once).
          // Progress is still reported the same way (an occasional heartbeat, gated by
          // `busyReportIntervalMs`, never one call per vertex) - `completed` counts actual
          // resolutions as they arrive, not loop position, since vertices can now finish out of
          // order. The throttle check-and-stamp (`lastBusyReportTime = now`) happens synchronously,
          // before this vertex's own `await onBusy(...)` - JS never runs two callbacks' synchronous
          // bodies interleaved, so a second vertex resolving while the first's onBusy call is still
          // pending sees the already-updated timestamp rather than racing it (deliberately no
          // "in flight" flag - one was tried and gated a legitimate second report behind the
          // first's own await, silently dropping it under a zero/near-zero interval).
          let completed = 0;
          let lastBusyReportTime = Date.now();
          const shrinkPromises = vertices.map((v) => {
            const point = bestPoint.map((b, d) => b + SIGMA * (v.point[d] - b));
            return evalPoint(point).then(async (result) => {
              completed++;
              const isLast = completed === vertices.length;
              const now = Date.now();
              if (onBusy && !isLast && now - lastBusyReportTime >= busyReportIntervalMs) {
                lastBusyReportTime = now;
                await onBusy({ iteration: iter, operation: 'shrink', verticesToEvaluate: n + 1, verticesEvaluated: completed });
              }
              return result;
            });
          });
          vertices = await Promise.all(shrinkPromises);
          // Representative "what this iteration's work produced" for a shrink, since it
          // replaces the whole simplex at once rather than a single vertex.
          attempted = vertices.reduce((a, b) => (b.loss < a.loss ? b : a));
        }
      }
    }

    if (onProgress) await onProgress(iter, vertices[0].point, vertices[0], best, attempted);
    await yieldToEventLoop();

    if (alreadyConverged) { converged = true; break; }
  }

  vertices.sort((a, b) => a.loss - b.loss);
  if (vertices[0].loss < best.loss) best = vertices[0];

  return { point: best.point, loss: best.loss, result: best, iterations, converged };
}

/**
 * Whether `candidate` counts as a genuine improvement over `incumbent`, accounting for each
 * side's own measurement uncertainty (`trialRtpStdError` - see `measure()`'s own doc in
 * `tuneFrequencies`) rather than a raw `loss` comparison. A `candidate` only replaces a real
 * `incumbent` once it beats it by more than their combined standard error, scaled by `z` - so a
 * "better" result that's really just a luckier Monte Carlo sample can't silently become the new
 * best. Collapses to today's raw `<` comparison whenever both sides have zero (or missing)
 * `trialRtpStdError` - i.e. a deterministic evaluate, or `trialsPerPoint: 1`, is unaffected.
 * @param {{loss: number, trialRtpStdError?: number}} candidate
 * @param {{loss: number, trialRtpStdError?: number}|null} incumbent - `null` means "no incumbent
 *   yet", always accepted
 * @param {number} z - margin multiplier (tuneFrequencies' `bestAcceptanceZ` option)
 * @returns {boolean}
 */
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

/**
 * Automatically tunes each reel's own `frequency` values (one table per reel - see
 * `reelFrequencyTables`) to hit a target RTP and a target free-spin trigger rate, without
 * touching any payout values or the paytable itself. Runs the real simulator against
 * candidate reel tables, so it stays accurate to whatever SlotMath.js's actual win logic
 * does at the time it's run.
 *
 * Frequencies live only on the per-reel tables, never on `paytable` - `paytable` is used
 * only for payout-based tier ranking and type lookups (wild/scatter/exclusions), and is
 * returned unchanged (not included in the return value at all).
 *
 * Strategy:
 *  1. Scale every symbol with `paytable[symbol].triggerFreeSpins === true`'s frequency by one
 *     shared multiplier, applied identically to every reel's table (gradientDescent1D), until
 *     the free-spin trigger rate lands on target. A symbol with frequency 0 on a given reel
 *     stays 0 (0 * mult = 0).
 *  2. Jointly tune every reel's value-symbol weights via one Nelder-Mead simplex search
 *     over one free weight per (value symbol, reel) pair - true multi-dimensional
 *     optimization, not coordinate descent over reels. "A higher-paying symbol should not
 *     be more frequent than a lower-paying symbol on the same reel" is a soft penalty term
 *     added to the loss (see `nelderMead`'s `evaluate` closure below), not a hard
 *     constraint - a single scalar-per-reel tilt could not simultaneously fix an ordering
 *     violation and hit the RTP target when the two required different corrections for
 *     different symbols on the same reel; a genuinely free weight per symbol can. Any
 *     ordering violation still present once the search finishes is reported in
 *     `diagnostics.rtpPhase.orderingViolations`, not silently corrected.
 *     Any symbol with `fixed: true` on a given reel's own frequency table entry, and any
 *     symbol with baseline frequency 0 on a given reel, are excluded from the search entirely
 *     (held fixed / left at 0). `fixed` lives on the reel data itself, per (symbol, reel) -
 *     not derived from the paytable's `type` - so it's independent per reel: a symbol can be
 *     fixed on one reel and freely tuned on another.
 *     Phase 2 itself runs in short rounds rather than one long search: a round that fails to
 *     improve RTP error, the ordering-violation total, and the limit-violation total (each
 *     tracked independently) restarts from the best point found so far with a wider step and
 *     a different search seed, and gives up early after several such stalls rather than
 *     grinding through the rest of the iteration budget on a target that was never reachable -
 *     see `diagnostics.rtpPhase.reason` for why a given run stopped.
 *
 * @param {Object} paytable - Rules only (payout, type, wild, wildPenalty, wildExcludes,
 *   aloneBonus, friendlyName) - no `.frequency` field. Not mutated, not returned.
 * @param {Object[]} reelFrequencyTables - One table per reel, each
 *   `{ defaults?: { minGap?, maxStack?, minStack?, minFrequency?, maxFrequency? }, symbols: {
 *   symbol: { frequency, fixed?, minFrequency?, maxFrequency?, minGap?, maxStack?, minStack? } } }`
 *   (see generateReel's own doc in core/SlotMath.js for the shape and its `minGap`/`maxStack`/
 *   `minStack` fields - `tuneFrequencies` itself only reads/writes `.symbols[symbol].frequency`,
 *   `.fixed`, `.minFrequency`, `.maxFrequency` (both resolved via `resolveFrequencyBounds`, so a
 *   reel-level `defaults.minFrequency`/`.maxFrequency` applies to any symbol that doesn't
 *   override it); `.defaults` and any `.symbols[symbol].minGap`/`.maxStack`/`.minStack` pass
 *   through untouched). `fixed: true` is optional
 *   (defaults to falsy/tunable) and excludes that symbol from Phase 2 on that specific reel
 *   only - its frequency is left exactly as passed in. `min` and/or `max` are optional soft
 *   bounds (same units as `frequency`) on that symbol's frequency on that specific reel -
 *   like the ordering preference, a discouraged-but-not-forbidden preference (see
 *   `limitPenaltyWeight` below), not a hard clamp. Not mutated; a tuned clone is returned.
 * @param {Object} [options]
 * @param {number} [options.reelsCount=reelFrequencyTables.length]
 * @param {number} [options.rowsCount=3]
 * @param {number} [options.reelLength=220] - Virtual reel strip length passed to generateReel.
 * @param {number[]} [options.reelSeeds] - Base seeds, one per reel (reused/offset if fewer than reelsCount).
 * @param {number} [options.betPerLine=1]
 * @param {number} [options.linesCount=10]
 * @param {number} [options.targetRtp=96] - Target RTP as a percent (e.g. 96 for 96%).
 * @param {number} [options.rtpTolerancePct=1.5] - Acceptable +/- band around targetRtp.
 * @param {number} [options.maxRtpStdError=Infinity] - How large a candidate's own measurement
 *   uncertainty (its `trialRtpStdError` - the standard error of the mean across its
 *   `trialsPerPoint` repeats, see measure()'s own comment) is allowed to be before it can count
 *   as having genuinely hit `rtpTolerancePct`. Landing within tolerance on average means little
 *   if the individual trials that average was built from disagreed wildly with each other (a
 *   real risk for a high-variance mechanic, e.g. a cascade bonus whose multiplier can stack
 *   repeatedly) - such a candidate might just have gotten lucky this run, not actually pay out
 *   near target over a much larger sample. Gates both the early-accept check
 *   (`earlyAcceptErrorPct`) and the final 'converged'/'converged-with-violations' reason - a
 *   candidate whose RTP error is within tolerance but whose `trialRtpStdError` exceeds this is
 *   treated the same as one that missed the target outright (reason `'stalled'` or
 *   `'exhausted'`, same as any other unreached target), so the search keeps running (or reports
 *   honestly that it couldn't get a trustworthy fix) rather than settling on a number that
 *   looks right by chance. Defaults to `Infinity` (off) - every existing caller/test measures
 *   with settings where this was never the actual failure mode, so enabling it unconditionally
 *   would change what "converged" means for them without their asking; raise `trialsPerPoint`/
 *   `trialSpins` and set this explicitly for a mechanic/game where a Worker-pool-backed
 *   `runTrial` (see below) makes larger sample sizes cheap enough to afford.
 * @param {number} [options.targetTriggerRatePct=0.6] - Target % of spins that trigger free spins.
 * @param {number} [options.triggerRateTolerancePct=0.15] - Acceptable +/- band around that.
 * @param {number} [options.trialSpins=800000] - Base spins simulated per candidate.
 * @param {number} [options.trialsPerPoint=3] - Independent trials averaged per candidate (reduces rare-event noise).
 * @param {number} [options.maxIterations=150] - Nelder-Mead iterations for the one joint
 *   Phase 2 search (each iteration is cheap - usually one measure() call).
 * @param {number} [options.orderingPenaltyWeight=0.5] - Weight of the soft ordering-violation
 *   penalty added to Phase 2's loss alongside RTP error - higher discourages violations more
 *   strongly, but RTP convergence always wins when the two genuinely conflict.
 * @param {number} [options.limitPenaltyWeight=0.5] - Weight of the soft per-symbol min/max
 *   frequency penalty (see `reelFrequencyTables`' `min`/`max` above) added to Phase 2's loss
 *   alongside RTP error and the ordering penalty - same soft-preference semantics.
 * @param {number} [options.uniformityPenaltyWeight=0] - Weight of a soft per-reel penalty
 *   discouraging any one tunable symbol's frequency from landing far from a straight-line
 *   target across that reel's payout tiers - NOT a flat "every symbol should be equal" target.
 *   The line's slope is set by that reel's own `orderingBiasByReel` entry (direction and
 *   Strength together - see below): bias 0 (no ordering preference) collapses the line to
 *   flat/equal, same as if every symbol truly should match the reel's equal share; a nonzero
 *   bias tilts the line the same direction ordering already prefers (e.g. bias -1 tilts it so
 *   lower-paying symbols sit above the reel's equal share and higher-paying ones below, matching
 *   "high pay rarer"), so this penalty pulls toward the tilt ordering wants instead of fighting
 *   it with a competing flat preference. `uniformityPenaltyWeight` itself only controls how hard
 *   the search is pushed toward that line - it never changes the line's own slope, which is
 *   entirely `orderingBiasByReel`'s (Strength's) job. Any symbol with
 *   `paytable[symbol].type === 'scatter'` is excluded from this comparison entirely (neither
 *   pulled toward a target nor counted toward computing one), even one that doesn't happen to
 *   trigger free spins - a scatter's ideal frequency plays a fundamentally different role than
 *   the value symbols this penalty compares. Off by default (0) since it's an opt-in extra
 *   preference, not a default assumption about what a good distribution looks like; independent
 *   of orderingPenaltyWeight itself (a reel can be perfectly ordered by payout tier and still
 *   have one wildly disproportionate symbol relative to the ideal line) and of
 *   limitPenaltyWeight (which only fires for symbols with an explicit min/max configured, not
 *   every tunable symbol on the reel). Like the other two, always a soft preference - it steers
 *   the search but never blocks 'converged'/'converged-with-violations' classification (real
 *   payout-tiered reels essentially never land exactly on any target line, so requiring this to
 *   hit exactly 0 would make 'converged' unreachable whenever it's enabled).
 * @param {number} [options.stdErrorPenaltyWeight=0] - Weight of a soft penalty on a candidate's
 *   own measurement unreliability (`trialRtpStdError` - the standard error of the mean across
 *   its `trialsPerPoint` repeats, see `measure()`'s own doc) added directly into `loss`. Off by
 *   default (0), unlike `maxRtpStdError`/`bestAcceptanceZ` (which only ever GATE whether a
 *   result can count as 'converged' or replace the incumbent `best`, after the fact), this
 *   actively steers the search itself DURING the search - two candidates with identical RTP
 *   error but different std error no longer score identically; the noisier one now costs more,
 *   so the optimizer has a genuine incentive to prefer more reliably-reproducible regions of the
 *   search space, not just whichever one look best on a single noisy average. Collapses to
 *   today's behavior (loss ignores std error entirely) at the default of 0 - raise this instead
 *   of (or alongside) `maxRtpStdError`/`bestAcceptanceZ` if the search keeps landing on
 *   high-variance candidates that only pass those gates by chance rather than genuinely
 *   avoiding noisy regions in the first place.
 * @param {number} [options.maxTriggerRefineSteps=12] - Budget for Phase 1b, the per-reel
 *   refinement that runs ONLY when Phase 1's shared multiplier could not land the trigger rate
 *   inside its target band. Set to 0 to disable it and keep Phase 1 to a single shared
 *   multiplier across every reel (the pre-existing behavior).
 *
 *   Phase 1 scales the trigger symbol by one multiplier applied identically to every reel, so
 *   all reels cross their whole-number rounding thresholds at the same time and the trigger rate
 *   can only move in lockstep jumps. Where those jumps are large relative to the tolerance band,
 *   the target can sit in a gap between two of them and be unreachable by ANY multiplier - not
 *   because the target is unreasonable, but because a single shared scalar cannot express the
 *   distribution that would hit it. Candy Frenzy is the clear case: `bonus` lands only 2-6 times
 *   on its 500-position strip, and the shared multiplier produces 0.368% then 0.893%, straight
 *   over the default 0.45%-0.75% band.
 *
 *   Phase 1b instead walks a SINGLE trigger symbol at a time onto (or off) individual reels,
 *   re-measuring each step, which fills those gaps at the existing reel length - no change to
 *   `reelLength`, `targetTriggerRatePct`, or `triggerRateTolerancePct` required. Measured on
 *   Candy Frenzy: [4,4,4,4,4,4,4] -> 0.875%, [3,4,4,4,4,4,4] -> 0.775%, [3,3,4,4,4,4,4] ->
 *   0.505%, converged, against a shared multiplier that could not get inside the band at all.
 *
 *   Symbols go onto the reels holding the fewest first (and come off the ones holding the most),
 *   keeping the spread as even as possible - a deliberate choice rather than arbitrary
 *   tie-breaking, since concentrating trigger symbols on a few reels changes how the game feels
 *   (near-misses cluster on the same reels) even at an identical overall trigger rate. The
 *   resulting counts are reported as `diagnostics.scatterPhase.refinedPerReelCounts`, which is
 *   null whenever this did not run or did not improve on the shared multiplier.
 * @param {number} [options.triggerRatePenaltyWeight=0] - Weight of a soft penalty on how far a
 *   candidate's measured trigger rate sits OUTSIDE the `targetTriggerRatePct` +/-
 *   `triggerRateTolerancePct` band (exactly zero anywhere inside it, so this never competes with
 *   the RTP term over a trigger rate that was already acceptable).
 *
 *   This exists because Phase 2 is otherwise completely blind to the trigger rate: it excludes
 *   trigger symbols from its own dimensions, so it can only affect the trigger rate INDIRECTLY -
 *   and whether it does depends entirely on the mechanic.
 *
 *   For a line-pay mechanic it essentially cannot. Phase 2 preserves each reel's total weight and
 *   never touches a trigger symbol's own frequency, so P(scatter in view) is unchanged by
 *   construction, and leaving this at 0 (the default) costs nothing.
 *
 *   For a CASCADE mechanic it very much can, and the effect is large. The non-trigger symbols'
 *   weights govern how readily clusters form, which governs cascade depth, and every cascade
 *   refills the grid - handing out fresh chances to draw the scatter. Measured on Candy Frenzy
 *   with `bonus`'s frequency held byte-identical and every reel's candy budget preserved exactly,
 *   reweighting only the candies moves the trigger rate across a 0.75%-2.04% range (a 2.7x swing,
 *   against a default tolerance band of +/-0.15pp). Phase 1 tunes the scatter against the
 *   BASELINE distribution; Phase 2 then replaces that distribution wholesale while optimizing
 *   RTP, and with this weight at 0 nothing in `loss` registers the damage. That is the concrete
 *   reason a cascade tune can report a good RTP and a trigger rate nowhere near its target.
 *
 *   Set this non-zero for any cascade-mechanic game (games/candyfrenzy/game.js does). Units are
 *   percentage points of trigger rate, the same scale as the RTP `error` term, so a weight of 1
 *   trades 1pp of trigger-rate drift against 1pp of RTP error.
 * @param {number[]} [options.orderingBiasByReel] - Per-reel direction/strength for the
 *   ordering preference, indexed by reel. `-1` (the default for every reel, if omitted or if
 *   a specific reel's entry is missing) keeps today's behavior: a higher-paying symbol is
 *   discouraged from being *more* frequent than a lower-paying one on that reel. `1` reverses
 *   it for that reel: a higher-paying symbol is discouraged from being *less* frequent than a
 *   lower-paying one - useful for engineering a near-miss feel (e.g. reels 1 and 3 show
 *   premium symbols often, reel 2 almost never does, so lines rarely complete despite looking
 *   close). `0` disables the preference entirely for that reel. Any other magnitude scales
 *   how strongly that reel's preference is enforced relative to `orderingPenaltyWeight`.
 * @param {number} [options.initialStepSize=0.5] - Log-space perturbation used to build Phase
 *   2's initial Nelder-Mead simplex.
 * @param {number} [options.searchSeed=12345] - Base PRNG seed for the common-random-numbers
 *   gradient/simplex estimates - a given seed always explores the same sequence, for
 *   reproducible runs.
 * @param {number} [options.stallWindowIterations=15] - Phase 2 runs nelderMead() in rounds of
 *   this many iterations, checking after each round whether RTP error, the ordering-violation
 *   total, or the limit-violation total improved by at least 2% relative to its own
 *   best-so-far. A round where none of the three improved is a stall.
 * @param {number} [options.stallWidenFactor=1.5] - Multiplier applied to the Nelder-Mead initial
 *   step size each time a stall triggers a restart.
 * @param {number} [options.maxStallRestarts=4] - Consecutive stalled rounds before Phase 2
 *   gives up early (rather than spending the rest of maxIterations on a dead end) and reports
 *   `diagnostics.rtpPhase.reason` as `'stalled'` or `'converged-with-violations'`.
 * @param {number} [options.earlyAcceptErrorPct=0.01] - RTP error threshold (in percentage
 *   points) below which Phase 2 stops immediately if ordering/limit violations are also fully
 *   resolved - no reason to spend more budget refining an already-essentially-exact result.
 * @param {number} [options.freeSpinsCount] - Passed straight through to simulateSpins as
 *   `config.freeSpinsCount` - see its own doc. Only matters if `paytable` has a
 *   `triggerFreeSpins: true` symbol.
 * @param {Object} [options.freeSpinsAwardTable] - Passed straight through to simulateSpins as
 *   `config.freeSpinsAwardTable` (the real game's own scatter-count -> awarded-spins schedule)
 *   so a measured candidate's RTP reflects the same free-spins economics the live game actually
 *   awards, not a flat guess.
 * @param {Object} [options.retriggerFreeSpinsAwardTable] - Passed straight through to
 *   simulateSpins as `config.retriggerFreeSpinsAwardTable` - omitting both this and
 *   `freeSpinsAwardTable` measures with no retriggers at all, which understates RTP for any
 *   game whose live engine does support retriggering.
 * @param {boolean} [options.hasExpandingWild] - Passed straight through to simulateSpins as
 *   `config.hasExpandingWild` - see its own doc. Omitting this for a game that really does have
 *   an expanding-wild free-spins bonus understates its RTP.
 * @param {Object} [options.mechanic] - Spin-resolution mechanic (see simulateSpins' own doc) -
 *   defaults to LineMechanic. A cascade game passes CascadeSpinMechanic (core/
 *   CascadeSpinMechanic.js) instead, alongside `winEvaluator`/`scatterSymbol`/`freeSpinsMode`
 *   in place of `paylines`/`wildSymbol`/`hasExpandingWild`.
 * @param {Object} [options.freeSpinsMode] - Cascade-mechanic-only: passed straight through to
 *   simulateSpins as `config.freeSpinsMode` - see its own doc.
 * @param {(paytable: Object, symbol: string) => number} [options.payoutOf] - How Phase 2 ranks
 *   "value" symbols against each other for the soft ordering preference below - defaults to
 *   `mechanic.defaultPayoutOf` (line-pay: highest N-of-a-kind payout; cascade: highest
 *   cluster-payout tier). Override only for a mechanic whose payout shape doesn't fit either
 *   convention.
 * @param {'provided'|'uniform'|'normal'} [options.initialWeightStrategy='provided'] - How Phase
 *   2's starting point is chosen for a dimension that has BOTH a minFrequency and a
 *   maxFrequency configured (via `resolveFrequencyBounds` - a symbol missing either bound has
 *   no defined range to sample from, so it always starts from its provided baseline frequency
 *   regardless of this setting). `'provided'` (the default) starts every dimension at whatever
 *   frequency `reelFrequencyTables` already had - unchanged behavior. `'uniform'` picks a value
 *   uniformly at random between that dimension's min and max. `'normal'` picks from a normal
 *   distribution centered at the midpoint of min/max (std = a quarter of the range, clamped
 *   back into [min, max] as a backstop against the rare extreme tail sample) - useful for
 *   exploring whether the search reliably converges to the same answer from a meaningfully
 *   different starting shape, or gets stuck depending on where it started. Sampling is drawn
 *   from a dedicated RNG seeded off `searchSeed`, so the whole run - including which random
 *   starting point gets used - stays a pure function of `searchSeed` (same determinism
 *   guarantee as every other seeded part of this search).
 * @param {'nelderMead'|'cmaes'} [options.searchAlgorithm='nelderMead'] - Which algorithm Phase
 *   2 uses to search the joint per-symbol weight space. `'nelderMead'` (default, unchanged) is
 *   a simplex search - cheap and effective for a small number of tunable symbols. `'cmaes'`
 *   (`core/CMAES.js`) is a population-based search that scales better to many tunable symbols
 *   at once (e.g. Candy Frenzy's ~84) and is more tolerant of noisy per-candidate RTP
 *   measurements, at the cost of evaluating a whole population every generation instead of one
 *   or two points. Both return the same shape, so switching this option doesn't change anything
 *   else about how Phase 2's round loop (restarts, stall detection, `reason` classification)
 *   behaves.
 * @param {number} [options.bestAcceptanceZ=1.0] - Margin (in combined standard errors) a new
 *   candidate must beat the current cross-round incumbent by, via `trialRtpStdError`, before it
 *   replaces it as `best` (see `beatsIncumbent`) - independent of `searchAlgorithm`. Collapses
 *   to a raw loss comparison whenever both candidates have zero/missing `trialRtpStdError`
 *   (e.g. `trialsPerPoint: 1`), so this only changes behavior on a game whose RTP measurement is
 *   actually noisy.
 * @param {(phase: 'initial'|'scatter'|'shape'|'restart', iteration: number, multiplier: number|null, result: Object, best: Object) => (void|Promise<void>)} [options.onProgress] -
 *   Called (and awaited, if it returns a promise) at several points during the search:
 *   - `'initial'`: fired exactly once, before Phase 1 runs, with `result.trial` set to Phase
 *     2's actual starting reel tables (reflecting `initialWeightStrategy`) - `multiplier` and
 *     `best` are both `null` here, nothing has been measured yet.
 *   - `'scatter'`: one call per Phase 1 iteration, `result` is `{rtp, triggerRate, error,
 *     trialRtpMin, trialRtpMax}` - the last two are that candidate's own RTP spread across its
 *     `trialsPerPoint` repeats (equal to `rtp` when `trialsPerPoint` is 1), letting a caller
 *     flag a wide spread as "this number is noisy" rather than presenting it as precise.
 *   - `'shape'`: one call per Phase 2 iteration, after each candidate is measured. `multiplier`
 *     is always `null` here (Phase 2 moves every dimension together each iteration, so there's
 *     no longer one scalar to report per step). `result` (the simplex's own best vertex
 *     entering this iteration) additionally carries `result.attempted` - the vertex this
 *     specific iteration's own reflect/expand/contract/shrink actually produced (same shape as
 *     `result`/`best` themselves, or `null` if this iteration had nothing to try because the
 *     simplex had already converged) - see `nelderMead`'s own `onProgress` doc for why this
 *     matters: without it, several iterations in a row that each genuinely try something new
 *     but fail to beat the existing best all report the identical unchanged `result`/`best`,
 *     indistinguishable from a search doing nothing at all.
 *   - `'restart'`: fired whenever a stalled round triggers a restart, with `result` set to
 *     `{stepSize, restarts, stallStreak, maxStallRestarts, willStopNow}` - `multiplier` is
 *     `null`; `best` is the best vertex found so far. Without this, a stall/restart is
 *     invisible to a caller: the per-iteration `'shape'` log looks identical whether or not a
 *     restart just happened underneath it.
 *   - `'busy'`: fired at most once per iteration (`'scatter'` or `'shape'`), only when that
 *     iteration is doing several times its usual amount of work before it has anything new to
 *     report - a Phase 2 Nelder-Mead simplex shrink (re-evaluates every vertex, not just one or
 *     two) or a Phase 1 gradient-descent plateau-widening retry (see `gradientDescent1D`'s/
 *     `nelderMead`'s own `onBusy` doc for exactly when each fires). `result` is
 *     `{iteration, operation: 'shrink'|'widen-probe', sourcePhase: 'scatter'|'shape',
 *     verticesToEvaluate?, verticesEvaluated?, probeAttempt?}` - `sourcePhase` says which phase
 *     this came from, since `i` alone doesn't (Phase 1 and Phase 2 both number from 0). Use it
 *     to label a 'busy' line the same way as that phase's own progress lines (e.g. "Scatter
 *     frequency N" vs "Step N"). `multiplier` and `best` are always `null`. Deliberately NOT
 *     fired for the common case (a normal reflection, or a slope found on the first probe) - this is for
 *     explaining an otherwise silent, unusually long gap between two ordinary progress lines,
 *     not a per-measurement log. If the gap is long enough, a 'busy' event fires again -
 *     `verticesEvaluated`/`probeAttempt` set on that second and later calls - but throttled to
 *     at most once every `busyReportIntervalMs`, so a shrink/widen that resolves quickly still
 *     only ever fires once.
 * @param {number} [options.busyReportIntervalMs=300] - Minimum real time between successive
 *   'busy' progress updates within the same shrink/widen-probe - see above. Passed straight
 *   through to `gradientDescent1D`/`nelderMead`.
 * @param {(config: Object, numSpins: number, betPerLine: number, linesCount: number, rngSeed: number|null) => Promise<{ rtpRaw: number, freeSpinsTriggered: number, baseSpins: number }>} [options.runTrial] -
 *   Optional hook letting each Monte Carlo trial run on a separate thread (e.g. a pool of
 *   Workers - see core/SimulationWorkerPool.js) instead of in-process on whichever thread
 *   `tuneFrequencies` itself is running on. `config` is the same shape `measure()` would
 *   otherwise pass straight to `simulateSpins` (reelStrips already built, mechanic/winEvaluator/
 *   freeSpinsMode included as real objects - a caller crossing a postMessage boundary needs to
 *   convert those to names itself, the same way the existing tuning UI already does for its
 *   other options). When supplied: (1) the `trialsPerPoint` independent repeats `measure()`
 *   averages per candidate are dispatched together via Promise.all instead of one at a time,
 *   and (2) `nelderMead`'s initial simplex and every simplex shrink evaluate all of their
 *   vertices concurrently too (see its own doc) - together, the two biggest sources of "many
 *   sequential measurements on one CPU core" for a high-dimensional search (e.g. Candy Frenzy's
 *   ~84 tunable dims). Omitted (the default), every existing caller/test keeps running exactly
 *   today's in-process sequential loop - fully backward compatible.
 * @param {AbortSignal} [options.signal] - Lets a caller stop a long-running tune early (e.g. a
 *   STOP button) without losing whatever's already been found. Checked cooperatively - between
 *   Phase 1 and Phase 2, and once per round of Phase 2 (after that round's `nelderMead`/`cmaes`
 *   call returns, itself checking every iteration/generation - see each one's own doc) - never
 *   mid-measurement, and never throws: `reason` in the returned diagnostics becomes `'stopped'`
 *   (taking priority over `'converged'`/`'converged-with-violations'`/`'stalled'`/`'exhausted'`)
 *   and everything else in the result reflects whatever the best candidate found before the
 *   signal fired actually was, exactly as if `maxIterations` had simply been reached there.
 * @returns {Promise<{ reelFrequencyTables: Object[], rtp: number, triggerRatePct: number, diagnostics: Object }>} -
 *   `diagnostics.inputParameters` is a snapshot of every resolved (defaults-applied) tuning
 *   knob used to produce this specific result - see its own comment above the `return` statement
 *   for exactly what's included/excluded.
 */
/**
 * Diagnosis without a search: what is wrong with this config, what an even symbol distribution
 * pays, and which structural knob actually moves RTP - Phases 0a, 0b and 0c only.
 *
 * This exists as its own entry point because those answers should shape the inputs a developer
 * hands the tuner, and that is the wrong way round if they only ever arrive as the opening act of
 * a search already underway. Sensitivity in particular needs no search at all: it is ~30 cheap
 * measurements, it is the single most useful thing this module produces, and waiting out a
 * 150-iteration tune to see it is backwards.
 *
 * Runs `tuneFrequencies` with `diagnoseOnly`, so the two share every code path by construction and
 * cannot drift into disagreeing about what a config measures. `measureSensitivity` defaults to ON
 * here (unlike in `tuneFrequencies`, where it is off so no existing caller pays for it) - a
 * diagnosis without the sensitivity sweep would be missing its main course.
 *
 * @returns {Promise<Object>} the `diagnostics` object: `{ validation, structuralHeadroom,
 *   sensitivity, reelFeasibility }`. Throws on a blocking validation error, same as a real tune.
 */
export async function diagnoseConfig(paytable, reelFrequencyTables, options = {}) {
  const result = await tuneFrequencies(paytable, reelFrequencyTables, {
    ...options,
    measureSensitivity: options.measureSensitivity ?? true,
    diagnoseOnly: true,
  });
  return result.diagnostics;
}

export async function tuneFrequencies(paytable, reelFrequencyTables, options = {}) {
  if (!paytable || typeof paytable !== 'object') {
    throw new Error('tuneFrequencies requires a paytable');
  }
  // Checked before destructuring options below - `reelsCount`'s default reads
  // `reelFrequencyTables.length`, which would throw an unrelated TypeError first if this
  // isn't actually an array.
  if (!Array.isArray(reelFrequencyTables) || reelFrequencyTables.length === 0) {
    throw new Error('tuneFrequencies requires a non-empty array of reelFrequencyTables');
  }

  const {
    reelsCount = reelFrequencyTables.length,
    rowsCount = 3,
    reelLength = 220,
    reelSeeds = [1234, 567, 89, 765, 3321],
    betPerLine = 1,
    linesCount = 10,
    paylines,
    winEvaluator,
    // `(paytable) => winEvaluator` - supply this for any game whose evaluator captures its own
    // paytable, so measurements taken under a rescaled paytable actually use it. Without it, the
    // payout-scale solve cannot verify itself and the sensitivity sweep's payoutScale ladder
    // measures the original payouts at every point.
    winEvaluatorFactory = null,
    wildSymbol = null,
    scatterSymbol = null,
    targetRtp = 96,
    rtpTolerancePct = 1.5,
    maxRtpStdError = Infinity,
    targetTriggerRatePct = 0.6,
    triggerRateTolerancePct = 0.15,
    trialSpins = 800000,
    trialsPerPoint = 3,
    maxIterations = 150,
    orderingPenaltyWeight = 0.5,
    limitPenaltyWeight = 0.5,
    uniformityPenaltyWeight = 0,
    stdErrorPenaltyWeight = 0,
    triggerRatePenaltyWeight = 0,
    maxTriggerRefineSteps = 12,
    spacingPenaltyWeight = 0,
    reelCoupling = 'independent',
    maxReelDeviation = 0.25,
    rotateSeedPerGeneration = true,
    measureHeadroom = true,
    // Off by default despite being this package's headline feature. The sweep costs ~30 extra
    // measurements, which is right for a developer who clicked TUNE and wrong for every existing
    // caller and unit test that never asked for it. The tuning panel turns it on.
    measureSensitivity = false,
    sensitivitySpins = null,
    sensitivityAt = 'uniform',
    // Phase 0d. `false`, or `{ knobs?: string[], respectDesignIntent?: boolean, maxMeasurements?: number }`.
    // Needs Phase 0c's ladders to seed its grid, so turning it on turns the sweep on too.
    tuneStructural = false,
    skipValidation = false,
    diagnoseOnly = false,
    minClusterSize,
    scatterTriggerCount,
    solvePayoutScale = false,
    orderingBiasByReel = null,
    // 'raw' (default, unchanged behavior) or 'normalized'. Raw penalty totals are incommensurable
    // with each other and with the RTP error term they are added to - ordering is in frequency
    // units, spacing is a violation count - so a weight has no fixed meaning across games, or even
    // across terms within one game. Normalized re-denominates each into a scale-free fraction, so
    // a weight of 1 buys about one RTP percentage point everywhere.
    penaltyNormalization = 'raw',
    // Volatility as a soft target: either a named band ('low' | 'medium' | 'high', converted
    // through core/TuningUnits.js so the band asked for and the band reported come from one table)
    // or a raw sigma. `volatilityTolerance` widens a raw target into a band; a named band already
    // is one. Null (default) means no target and the penalty is inert whatever its weight.
    //
    // AN HONEST CAVEAT, and the reason this is documented rather than just shipped: on a
    // cluster-cascade game volatility is dominated by the payout ladder shape and maxStack, NOT by
    // symbol frequencies. Measured on Candy Frenzy, maxStack moves RTP by 255pp per integer step
    // while the entire frequency search is worth about +/-10pp, and volatility follows the same
    // pattern. So this target mostly steers the Phase 0c/0d structural work and the payout solve.
    // Pointing Phase 2 alone at it will move volatility very little - which is worth knowing
    // BEFORE spending a 150-iteration search discovering it.
    targetVolatility = null,
    volatilityTolerance = 0.5,
    volatilityPenaltyWeight = 0,
    initialStepSize = 0.5,
    searchAlgorithm = 'nelderMead',
    bestAcceptanceZ = 1.0,
    searchSeed = 12345,
    stallWindowIterations = 15,
    stallWidenFactor = 1.5,
    maxStallRestarts = 4,
    earlyAcceptErrorPct = 0.01,
    freeSpinsCount,
    freeSpinsAwardTable,
    retriggerFreeSpinsAwardTable,
    hasExpandingWild,
    mechanic = LineMechanic,
    freeSpinsMode,
    payoutOf = mechanic.defaultPayoutOf,
    initialWeightStrategy = 'provided',
    busyReportIntervalMs = 300,
    onProgress = null,
    runTrial = null,
    signal = null,
  } = options;

  // A snapshot of every resolved (defaults-applied) knob this run is using. Built HERE rather than
  // beside the `return` it also travels in, and emitted before any work starts, because the things
  // that consume it are live: the tune log lets a developer copy a candidate's frequencies out
  // mid-run, and frequencies alone are not a reproducible artifact. Deferring this to the end meant
  // anything exported before the run resolved carried a header of `undefined`s.
  //
  // Deliberately limited to the JSON-safe tuning knobs a user actually configures - not
  // `winEvaluator`/`mechanic`/`payoutOf`/`onProgress`/`runTrial` (functions, not serializable) or
  // `paylines` (game layout, not a tuning parameter).
  const inputParameters = {
    reelsCount, rowsCount, reelLength, reelSeeds, betPerLine, linesCount,
    targetRtp, rtpTolerancePct, maxRtpStdError,
    targetTriggerRatePct, triggerRateTolerancePct,
    trialSpins, trialsPerPoint, maxIterations,
    orderingPenaltyWeight, limitPenaltyWeight, uniformityPenaltyWeight, stdErrorPenaltyWeight,
    triggerRatePenaltyWeight, maxTriggerRefineSteps, spacingPenaltyWeight, orderingBiasByReel,
    penaltyNormalization, targetVolatility, volatilityTolerance, volatilityPenaltyWeight,
    reelCoupling, maxReelDeviation,
    initialStepSize, searchAlgorithm, bestAcceptanceZ, searchSeed,
    stallWindowIterations, stallWidenFactor, maxStallRestarts, earlyAcceptErrorPct,
    initialWeightStrategy, freeSpinsCount, hasExpandingWild, solvePayoutScale,
    rotateSeedPerGeneration, measureHeadroom, skipValidation,
    measureSensitivity, sensitivitySpins, sensitivityAt, tuneStructural,
  };

  const orderingBiasFor = (r) => (orderingBiasByReel && orderingBiasByReel[r] != null) ? orderingBiasByReel[r] : -1;

  const yieldToEventLoop = () => new Promise(resolve => setTimeout(resolve, 0));

  if (reelFrequencyTables.length !== reelsCount) {
    throw new Error(`tuneFrequencies requires reelFrequencyTables to be an array of length reelsCount (${reelsCount})`);
  }

  const baseReelTables = reelFrequencyTables.map(rt => JSON.parse(JSON.stringify(rt)));
  const triggerSymbols = Object.keys(paytable).filter(s => paytable[s].triggerFreeSpins === true);

  // First thing out, before validation and before a single spin - a caller that exports anything
  // mid-run needs these from the start, not once the run resolves.
  if (onProgress) await onProgress('input-parameters', 0, null, inputParameters, null);

  // ---- Phase 0a: config validation ----
  // Pure arithmetic on the config, no reels built and no spins run, so it costs nothing and runs
  // before everything else. Errors stop the tune: they describe a config no amount of searching
  // can compensate for, and spending 150 iterations to report a confident number derived from a
  // broken paytable is worse than failing immediately. Candy Frenzy is the case in point - it ran
  // for days against a premium ladder where a 7-cluster paid less than a 5-cluster, which makes
  // "raise RTP" and "make big clusters rarer" the same instruction.
  //
  // Warnings and notes are reported and the run proceeds. `skipValidation` exists for the
  // developer who has read the finding and disagrees; the findings are still reported either way.
  const validation = validateTuningConfig({
    paytable, reelFrequencyTables: baseReelTables, reelLength, reelsCount, rowsCount,
    minClusterSize: minClusterSize ?? null, scatterTriggerCount: scatterTriggerCount ?? null,
  });
  if (onProgress && validation.length > 0) {
    await onProgress('validation', 0, null, { findings: validation }, null);
  }
  const blocking = validation.filter(f => f.severity === 'error');
  if (blocking.length > 0 && !skipValidation) {
    throw new Error(
      `tuneFrequencies refuses to run: ${blocking.length} configuration error${blocking.length === 1 ? '' : 's'} ` +
      `no amount of tuning can compensate for.\n` +
      blocking.map(f => `  - ${f.message}\n    Fix: ${f.suggestion}`).join('\n') +
      `\nPass skipValidation: true to tune anyway.`);
  }

  // Linking writes ONE weight per symbol to every reel, so the reels have to agree on which
  // symbols exist. A best-effort merge would write a frequency onto a reel that never carried
  // that symbol (or silently skip one that did), producing a strip nobody configured - so this
  // is a hard error naming the offending reel and symbols instead.
  if (reelCoupling !== 'independent') {
    const canonical = Object.keys(baseReelTables[0].symbols).sort();
    baseReelTables.forEach((rt, r) => {
      const here = Object.keys(rt.symbols).sort();
      if (here.join(' ') === canonical.join(' ')) return;
      const missing = canonical.filter(s => !here.includes(s));
      const extra = here.filter(s => !canonical.includes(s));
      const detail = [
        missing.length ? `is missing [${missing.join(', ')}]` : null,
        extra.length ? `has extra [${extra.join(', ')}]` : null,
      ].filter(Boolean).join(' and ');
      throw new Error(`reelCoupling '${reelCoupling}' requires every reel to carry the same symbols; reel ${r} ${detail}`);
    });
  }

  // Mirrors generateReel's own resolution order (symbol override -> reel defaults -> built-in
  // fallback, see core/SlotMath.js) so a constraint is read here exactly as the strip builder
  // reads it. Shared by the Phase 0 feasibility check and Phase 2's spacing penalty.
  const resolveMinGapFor = (reelTable, s) => reelTable.symbols[s].minGap
    ?? reelTable.defaults?.minGap
    ?? (paytable[s]?.triggerFreeSpins === true ? 3 : 1);
  const resolveMaxStackFor = (reelTable, s) => reelTable.symbols[s].maxStack
    ?? reelTable.defaults?.maxStack
    ?? Infinity;

  // `lengthOverride` exists for Phase 1's reel-length reachability probe (see
  // findReachableReelLength below), which needs to ask "what would this same frequency table
  // measure on a LONGER strip?" without disturbing the real `reelLength` every other phase and
  // the returned result are built against. Omitted everywhere else, i.e. unchanged behavior.
  function buildReelStrips(reelTables, lengthOverride) {
    // paytable (this function's outer `paytable` param, the real canonical rules table) is
    // passed as the 6th arg so generateReel's scatter min-gap spacing works correctly even
    // though these per-reel tables carry only `.frequency`, never `.type`. Seeded identically
    // to how every game.js itself builds its production REEL_STRIPS (generateReel(rt,
    // reelLength, reelSeeds[i], ...), no extra offset) - a mismatched seed here would tune
    // against a reel arrangement that's never actually the one built and shipped, which
    // previously made a candidate's measured RTP a (small but real) misprediction of what
    // pasting the same frequencies back into game.js would actually produce.
    return reelTables.map((rt, i) => generateReel(rt, lengthOverride ?? reelLength, reelSeeds[i % reelSeeds.length], [], 3, paytable));
  }

  // rngSeed is optional - omitted, this falls back to unseeded Math.random per trial (via
  // simulateSpins' own default). When provided, each trialsPerPoint repeat gets its own
  // derived seed, but that derived seed is identical across different candidate measurements
  // for the same trial index and rngSeed - the common-random-numbers property gradientDescent1D's
  // finite difference relies on.
  //
  // The `trialsPerPoint` repeats measured for one candidate are fully independent of each
  // other (same reel tables, different seeds) - when `runTrial` is supplied (see its own doc
  // above `tuneFrequencies`), they're dispatched together via Promise.all instead of one at a
  // time, so a Worker-pool-backed `runTrial` measures all of them concurrently. Without
  // `runTrial` (the default - every existing caller/test), this falls back to today's exact
  // in-process sequential loop; summation always proceeds in trial-index order regardless of
  // which trial's promise settles first (Promise.all preserves input order), so the result is
  // bit-for-bit identical to the sequential loop either way.
  // Also tracks each individual trial's own RTP (trialRtpMin/trialRtpMax), not just their
  // average - a high-variance mechanic (e.g. a cascade bonus whose multiplier stacks
  // repeatedly, producing a fat-tailed win distribution) can average out to a plausible-looking
  // number while individual trials still swing wildly - one lucky trialsPerPoint sample can
  // report a "converged" RTP that's really just noise, not a reliable measurement of what the
  // frequencies actually pay out over a much larger run. Surfacing the per-trial spread (not
  // just the mean) is what lets a caller (see SimulationPanel.js's live log/summary) tell "this
  // number is trustworthy" apart from "this number got lucky" - trialsPerPoint: 1 collapses
  // trialRtpMin/trialRtpMax to the same single value, which correctly signals "no repeat
  // measurement was taken, so no variance information is available."
  // `paytableOverride` exists for the payout-value solve, which needs to measure the SAME reels
  // under a rescaled paytable to verify the scale actually landed on target. Omitted everywhere
  // else, i.e. unchanged behavior.
  // `spinsOverride`/`trialsOverride` exist for the Phase 0c sensitivity sweep, which deliberately
  // measures many points cheaply (fewer spins, one trial each) because it ranks knobs by leverage
  // rather than converging any one of them - and reports its own measured noise floor so that
  // cheapness stays visible. Omitted everywhere else, i.e. unchanged behavior.
  async function measure(reelTables, rngSeed, lengthOverride, paytableOverride, spinsOverride, trialsOverride) {
    const spins = spinsOverride ?? trialSpins;
    const trials = trialsOverride ?? trialsPerPoint;
    const reelStrips = buildReelStrips(reelTables, lengthOverride);
    // A cascade game's `winEvaluator` is typically a closure over its own paytable - e.g.
    // `(grid) => checkClusterWins(grid, PAYTABLE, ...)` - so swapping `config.paytable` alone has
    // no effect on it and the run silently measures the ORIGINAL payouts. That is not a
    // hypothetical: the Phase 0c payoutScale ladder came back perfectly flat on Candy Frenzy
    // (0.8 and 1.25 both measuring 105%), which is arithmetically impossible for a lever RTP is
    // strictly proportional to. `winEvaluatorFactory` lets a caller rebuild an equivalent
    // evaluator around whichever paytable is actually being measured.
    const evaluatorForRun = (paytableOverride && winEvaluatorFactory)
      ? winEvaluatorFactory(paytableOverride)
      : winEvaluator;
    const config = {
      reelsCount, rowsCount, paytable: paytableOverride ?? paytable, reelStrips, paylines, winEvaluator: evaluatorForRun, wildSymbol, scatterSymbol,
      freeSpinsCount, freeSpinsAwardTable, retriggerFreeSpinsAwardTable, hasExpandingWild,
      mechanic, freeSpinsMode,
    };
    let triggerSum = 0;
    const trialRtps = [];
    const trialRoundStats = [];
    if (runTrial) {
      const trialResults = await Promise.all(Array.from({ length: trials }, (_, i) => {
        const seed = rngSeed != null ? rngSeed + i * 104729 : null;
        return runTrial(config, spins, betPerLine, linesCount, seed);
      }));
      trialResults.forEach(r => {
        triggerSum += (r.freeSpinsTriggered / r.baseSpins) * 100;
        trialRtps.push(r.rtpRaw * 100);
        // Absent from an older//custom runTrial that doesn't return it - merged as nothing rather
        // than treated as a run with zero rounds, which would drag every percentile to 0.
        if (r.roundStats) trialRoundStats.push(r.roundStats);
      });
    } else {
      for (let i = 0; i < trials; i++) {
        const rng = rngSeed != null ? createSeededRng(rngSeed + i * 104729) : Math.random;
        const results = simulateSpins(config, spins, betPerLine, linesCount, rng);
        triggerSum += (results.freeSpinsTriggered / results.baseSpins) * 100;
        trialRtps.push(results.rtpRaw * 100);
        trialRoundStats.push(results.roundStats);
      }
    }
    const rtp = trialRtps.reduce((a, b) => a + b, 0) / trials;
    // Sample standard deviation (n-1 denominator) of the individual trials' own RTP - only
    // meaningful with more than one trial; a single trial has no variance to observe from, so
    // it's reported as 0 (not NaN) - same "no variance information available" signal as
    // trialRtpMin === trialRtpMax already gives.
    const trialRtpStdDev = trialRtps.length > 1
      ? Math.sqrt(trialRtps.reduce((sum, v) => sum + (v - rtp) ** 2, 0) / (trialRtps.length - 1))
      : 0;
    // Standard error of the MEAN (stdDev / sqrt(n)) - how much the reported `rtp` above (an
    // average, not a single trial) is expected to vary from the true underlying RTP if this
    // exact measurement were repeated. Unlike trialRtpStdDev itself, this shrinks as
    // trialsPerPoint grows - the whole point of averaging more trials - so it's what
    // `maxRtpStdError` (see tuneFrequencies' own doc) actually gates acceptability on, not the
    // raw per-trial spread.
    const trialRtpStdError = trialRtpStdDev / Math.sqrt(trials);
    return {
      rtp,
      triggerRate: triggerSum / trials,
      trialRtpMin: Math.min(...trialRtps),
      trialRtpMax: Math.max(...trialRtps),
      trialRtpStdDev,
      trialRtpStdError,
      // Merged across trials rather than averaged - see mergeRoundStats for why the mean of two
      // medians is the wrong answer. Null when no trial reported any, so a caller can tell
      // "not measured" from "measured as empty".
      roundStats: trialRoundStats.length > 0 ? mergeRoundStats(trialRoundStats) : null,
    };
  }

  // ---- Early preview: report Phase 2's chosen starting point immediately, before Phase 1 runs ----
  // Without this, initialWeightStrategy's effect stayed invisible in a live caller (e.g. the
  // TUNE FREQUENCIES panel) until well after Phase 1's scatter-frequency rounds finished AND
  // Phase 2's own first Nelder-Mead iteration completed - and even then, that first reported
  // vertex can be one of the simplex's *perturbed* corners rather than the literal sampled
  // starting point (nelderMead sorts its initial n+1 vertices by loss before its own first
  // onProgress call, so whichever corner happens to score lowest is reported, not necessarily
  // vertex 0). This block independently recomputes just the starting shape - using the exact
  // same seed formula and dims iteration order as Phase 2's own setup further below, so the
  // sampled values agree exactly - purely to report it early; it doesn't feed into or replace
  // Phase 2's own computation, so there's no risk of the two ever disagreeing about what the
  // real search actually starts from.
  if (onProgress) {
    const previewRng = createSeededRng(searchSeed + 424242);
    const previewSampleUniform = (min, max) => min + previewRng() * (max - min);
    const previewSampleNormal = (min, max) => {
      const mean = (min + max) / 2, std = (max - min) / 4;
      const u1 = Math.max(previewRng(), Number.EPSILON), u2 = previewRng();
      const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      return Math.min(max, Math.max(min, mean + z * std));
    };
    const previewTrial = baseReelTables.map(rt => JSON.parse(JSON.stringify(rt)));
    // Under any LINKED coupling Phase 2 samples ONE value per symbol and applies it to every reel,
    // so sampling per (reel, symbol) here would both consume the shared RNG at a different rate
    // and show per-reel variation the search will never produce. Measured before this cache
    // existed: the preview reported `crystal` varying 44x across reels while the search actually
    // started them within 1.8x of each other - the preview was describing a different run, which
    // is precisely what its own comment promised could never happen.
    const previewShared = (reelCoupling !== 'independent') ? new Map() : null;
    baseReelTables.forEach((reelTable, r) => {
      const symbolsTable = reelTable.symbols;
      const nonScatterSymbols = Object.keys(symbolsTable).filter(s => !triggerSymbols.includes(s) && symbolsTable[s].frequency > 0);
      const valueSymbols = nonScatterSymbols.filter(s => symbolsTable[s].fixed !== true);
      if (valueSymbols.length === 0) return;
      const nonScatterTotal = nonScatterSymbols.reduce((sum, s) => sum + symbolsTable[s].frequency, 0);
      const fixedShapeTotal = nonScatterSymbols.filter(s => symbolsTable[s].fixed === true)
        .reduce((sum, s) => sum + symbolsTable[s].frequency, 0);
      const valueBudget = nonScatterTotal - fixedShapeTotal;
      if (valueBudget <= 0) return;
      const raw = {};
      valueSymbols.forEach(s => {
        const bounds = resolveFrequencyBounds(reelTable, s);
        const provided = symbolsTable[s].frequency;
        if (initialWeightStrategy === 'provided' || bounds.minFrequency == null || bounds.maxFrequency == null) {
          raw[s] = provided;
        } else if (previewShared?.has(s)) {
          raw[s] = previewShared.get(s);
        } else {
          const sampled = initialWeightStrategy === 'normal'
            ? previewSampleNormal(bounds.minFrequency, bounds.maxFrequency)
            : previewSampleUniform(bounds.minFrequency, bounds.maxFrequency);
          raw[s] = Math.max(sampled, Number.MIN_VALUE);
          previewShared?.set(s, raw[s]);
        }
      });
      // Bounds-aware, so what the preview shows actually lies inside the min/max the developer
      // configured - see renormalizeWithinBounds for why plain renormalization does not.
      const renormalized = initialWeightStrategy === 'provided'
        ? renormalizeWeights(raw, valueBudget)
        : renormalizeWithinBounds(raw, valueBudget, (s) => {
            const b = resolveFrequencyBounds(reelTable, s);
            return { min: b.minFrequency, max: b.maxFrequency };
          });
      Object.keys(renormalized).forEach(s => { previewTrial[r].symbols[s].frequency = renormalized[s]; });
    });
    await onProgress('initial', 0, null, { trial: previewTrial }, null);
  }

  // ---- Phase 1: scale trigger symbol(s) to hit the target trigger rate ----
  // One shared multiplier applied identically to every reel's table - a symbol with
  // frequency 0 on a given reel stays 0 (0 * mult = 0), so this is safe even for reels
  // that don't carry the trigger symbol at all.
  //
  // This is the ONLY place a triggerFreeSpins symbol's frequency can change - Phase 2 (below)
  // explicitly excludes trigger symbols from its dimensions entirely (they're filtered out
  // of nonScatterSymbols before valueSymbols/fixedShapeSymbols are even computed), so a
  // trigger symbol untouched here stays untouched for the rest of the run.
  //
  // It's expected - not a bug - for this phase to converge with mult staying at its starting
  // value of 1 (i.e. the trigger symbol's frequency doesn't change at all): bisect1D measures
  // the starting point first and stops immediately if the measured trigger rate is already
  // within `triggerRateTolerancePct` of `targetTriggerRatePct`, so if the *baseline* frequency
  // already lands inside that band, there's simply nothing to correct. Confirmed for
  // games/bookbookbook/game.js's real data: baseline trigger rate ~0.57% already sits inside
  // the default 0.6% +/- 0.15 target band, so `diagnostics.scatterPhase.multiplier` comes back
  // exactly 1 and `book`'s frequency is unchanged on every reel.
  //
  // Searched by bisection rather than by slope, because the trigger rate is a coarse STEP
  // function of this multiplier, not a smooth one - generateReel() rounds each symbol's share
  // to a whole number of strip positions, so the reachable trigger rates form a sparse lattice
  // and every multiplier in between measures identically. See bisect1D's own doc for the
  // measured numbers and for why a finite-difference search cannot work against that shape.
  // A consequence worth surfacing to callers: the target can land in a GAP between two
  // achievable values, in which case `scatterPhase.reason` is 'lattice-gap' and no amount of
  // searching will help - the reel strip needs to be longer, or the tolerance wider.
  // ---- Phase 0: reel-constraint feasibility check ----
  // Run before any tuning, purely as a report. Answers a question the tuner otherwise leaves a
  // developer to discover the hard way: are this game's own spacing constraints actually
  // satisfiable at this reel length and these frequencies?
  //
  // They frequently are not, and the failure is SILENT. generateReel enforces minGap/maxStack
  // best-effort - on a strip too dense to space a symbol out it hits a `candidates.length === 0`
  // bailout, returns the strip as-is, and reports nothing (core/SlotMath.js). So a game can ship
  // reels that clump far more than its config asks for, with nothing anywhere saying so.
  //
  // The hard ceiling is simple arithmetic: a symbol whose runs must sit `minGap` apart can have
  // at most floor(reelLength / minGap) of them. Exceeding it is not a tuning problem and no
  // penalty weight can fix it - the reel is too short, the gap too wide, or that symbol's
  // frequency too high, and one of those three has to give. Candy Frenzy at minGap 8 had 6 of its
  // 84 symbol-reel pairs over the ceiling before tuning even started; at minGap 4, one remains
  // (`chocolate` on reel 2 needs 174 runs against a ceiling of 125, because its frequency is
  // 0.4433 while its reel-mates sit at 0.014-0.072 - an over-abundance problem wearing a spacing
  // problem's clothes).
  function checkReelFeasibility(reelTables) {
    const infeasible = [];
    const strips = buildReelStrips(reelTables);
    reelTables.forEach((reelTable, r) => {
      const strip = strips[r];
      const n = strip.length;
      Object.keys(reelTable.symbols).forEach(s => {
        if (!(reelTable.symbols[s].frequency > 0)) return;
        const minGap = resolveMinGapFor(reelTable, s);
        if (minGap <= 1) return;
        let runs = 0;
        for (let i = 0; i < n; i++) if (strip[i] === s && strip[(i - 1 + n) % n] !== s) runs++;
        const ceiling = Math.floor(n / minGap);
        if (runs > ceiling) {
          infeasible.push({ reel: r, symbol: s, runs, ceiling, minGap, frequency: reelTable.symbols[s].frequency });
        }
      });
    });
    return infeasible;
  }

  // Every tunable (non-trigger) symbol on a reel set to that reel's own equal share, preserving
  // the reel's total weight exactly. This is the "no over-abundance at all" reference point, and
  // it is what the structural checks below measure against - the question they answer is "can a
  // PERFECTLY EVEN symbol distribution reach the RTP target?", which is precisely the question a
  // dev is really asking when the tuner keeps producing lopsided reels.
  function uniformizeTables(tables) {
    return tables.map(rt => {
      const clone = JSON.parse(JSON.stringify(rt));
      const tunable = Object.keys(clone.symbols)
        .filter(s => !triggerSymbols.includes(s) && clone.symbols[s].frequency > 0 && clone.symbols[s].fixed !== true);
      if (tunable.length === 0) return clone;
      const budget = tunable.reduce((sum, s) => sum + clone.symbols[s].frequency, 0);
      const share = budget / tunable.length;
      tunable.forEach(s => { clone.symbols[s].frequency = share; });
      return clone;
    });
  }

  // Overrides the reel-level `defaults` that govern how symbols are ARRANGED rather than how
  // often they appear - the structural knobs (see structuralSearch's own doc).
  function withStructuralDefaults(tables, params) {
    return tables.map(rt => ({
      ...JSON.parse(JSON.stringify(rt)),
      defaults: { ...(rt.defaults ?? {}), ...params },
    }));
  }

  const reelFeasibility = checkReelFeasibility(baseReelTables);

  // ---- Phase 0b: structural headroom ----
  // Measures RTP once with every tunable symbol at its reel's equal share. The gap between that
  // and `targetRtp` is the single most useful number a dev can have before a tune, because it
  // says how much the search will be FORCED to skew frequencies to make the target.
  //
  // Frequencies are the only thing Phase 2 can move. If an even distribution pays far under
  // target, the search's only route to the target is concentrating symbols - which is exactly the
  // "some symbols get an over-abundance" complaint, and it is the optimizer behaving correctly
  // rather than misbehaving. On a cluster mechanic the usual culprit is not the symbol
  // frequencies at all but the ARRANGEMENT knobs: measured on Candy Frenzy at uniform
  // frequencies, `stackChance` 0.10 (shipped) pays 9.7% while 0.50 pays 94.5%, because clusters
  // form when a vertical run in one column overlaps a run in the next (63-75% of its clusters
  // span exactly 2 columns), and at 0.10 those runs barely exist.
  //
  // One extra measurement, always taken when there is anything to tune, because a dev who never
  // asks the question is exactly the one who needs the answer.
  let structuralHeadroom = null;
  if (measureHeadroom) {
    const uniformRtp = (await measure(uniformizeTables(baseReelTables), searchSeed + 990001)).rtp;
    structuralHeadroom = {
      uniformRtp,
      targetRtp,
      // How many times over the target an even distribution falls short (or overshoots). Near 1
      // means the target is comfortably reachable without skewing anything.
      shortfallFactor: uniformRtp > 0 ? targetRtp / uniformRtp : Infinity,
      reachableWithEvenFrequencies: Math.abs(uniformRtp - targetRtp) <= rtpTolerancePct,
    };
    if (onProgress) await onProgress('headroom', 0, null, structuralHeadroom, null);
  }
  if (onProgress && reelFeasibility.length > 0) {
    await onProgress('feasibility', 0, null, { infeasible: reelFeasibility, reelLength }, null);
  }

  // ---- Phase 0c: structural sensitivity ----
  // Phase 0b answers "can an even distribution reach the target?" with one number. This answers
  // the question a developer actually has next: WHICH knob do I turn, and how far?
  //
  // Measured on Candy Frenzy at uniform frequencies, maxStack 4->5 is worth +87pp while minGap
  // across its whole range moves ~3pp with no monotone trend. That is a ~90x difference in
  // leverage between two settings that look equally important in a game.js file, and no amount of
  // frequency search can substitute for the larger one.
  //
  // Measured at UNIFORM frequencies by default so a knob's effect is isolated from whatever the
  // current frequencies happen to be - the shipped Candy Frenzy tables pay 74.70% against 101.48%
  // for the same reels at even frequencies, so sweeping at the current shape would measure both
  // things at once and attribute the sum to the knob.
  let sensitivity = null;
  // Kept in scope past the sweep block so Phase 0d can measure its grid cells under the EXACT same
  // conditions the ladders were measured under. It composes those ladders' ratios to rank cells,
  // so a cell measured at a different spin count or against different frequencies would be scored
  // against a baseline it does not share.
  let sweepContext = null;
  // Phase 0d composes the ladders' ratios to rank its grid, so asking for it necessarily asks for
  // them. Implied rather than validated as a conflicting-options error: there is exactly one thing
  // the caller can have meant.
  if (measureSensitivity || tuneStructural) {
    const sweepBase = sensitivityAt === 'current' ? baseReelTables : uniformizeTables(baseReelTables);
    const sweepSpins = sensitivitySpins ?? Math.max(1, Math.round(trialSpins / 4));
    // Trials are held at 1 and spins reduced: this ranks knobs by leverage, and a ranking survives
    // noise that a converged RTP would not. The noise floor below is what keeps that honest.
    const sweepMeasure = (tables, seed, lengthOverride, paytableOverride) =>
      measure(tables, seed, lengthOverride, paytableOverride, sweepSpins, 1);

    // The sweep's own noise floor, measured rather than assumed: the same config under three
    // different seeds, reported as twice the sample standard deviation. Without it a 1pp
    // difference between two ladder points reads exactly like a 100pp one, only smaller - and the
    // whole purpose here is to stop a developer chasing a parameter that did nothing.
    const noiseSamples = [];
    for (let i = 0; i < 3; i++) {
      noiseSamples.push((await sweepMeasure(sweepBase, searchSeed + 880011 + i * 7919)).rtp);
    }
    const noiseMean = noiseSamples.reduce((a, b) => a + b, 0) / noiseSamples.length;
    const noiseSd = Math.sqrt(noiseSamples.reduce((s, v) => s + (v - noiseMean) ** 2, 0) / (noiseSamples.length - 1));
    const noiseFloorPct = 2 * noiseSd;

    const ladders = buildLadders(sweepBase, { reelLength });
    const ladderResults = [];
    for (const { knob, current, values } of ladders) {
      const ladder = [];
      for (const value of values) {
        if (signal?.aborted) break;
        // Each knob reaches the measurement by its own route: the reel-arrangement knobs through
        // `defaults`, reel length through the strip builder, payout scale through the paytable.
        const tables = ['stackChance', 'maxStack', 'minStack', 'minGap'].includes(knob)
          ? withStructuralDefaults(sweepBase, { [knob]: value })
          : sweepBase;
        const lengthOverride = knob === 'reelLength' ? value : undefined;
        const paytableOverride = knob === 'payoutScale' ? scalePaytable(paytable, value) : undefined;
        const m = await sweepMeasure(tables, searchSeed + 880100, lengthOverride, paytableOverride);
        ladder.push({ value, rtp: m.rtp, triggerRate: m.triggerRate });
        if (onProgress) {
          await onProgress('sensitivity', ladder.length, null,
            { event: 'point', knob, value, current, rtp: m.rtp, triggerRate: m.triggerRate, of: values.length }, null);
        }
        await yieldToEventLoop();
      }
      if (ladder.length >= 2) ladderResults.push({ knob, current, ladder });
    }

    const baselinePoint = { rtp: noiseMean, triggerRate: null };
    sensitivity = {
      measuredAt: sensitivityAt,
      spinsPerPoint: sweepSpins,
      noiseFloorPct,
      ...summarize(baselinePoint, ladderResults, { targetRtp, noiseFloorPct }),
    };
    if (onProgress) await onProgress('sensitivity', 0, null, { event: 'complete', ...sensitivity }, null);
    sweepContext = { sweepBase, sweepMeasure, sweepSpins };
  }

  // ---- Phase 0d: structural recommendation ----
  // Phase 0c says which knob to turn, one at a time. This says what to set them all TO, which is
  // the question that actually blocks a developer - and it is not answerable one knob at a time,
  // because the knobs interact (maxStack does nothing if stackChance is too low to produce runs
  // for it to cap).
  //
  // Off by default. It is a recommendation about design values, and a caller who did not ask for
  // one should not pay for the measurements. See core/StructuralSearch.js for why a grid, and for
  // why the grid is ranked for free and measured sparingly.
  let structuralRecommendation = null;
  if (tuneStructural && sensitivity && sweepContext) {
    const opts = typeof tuneStructural === 'object' ? tuneStructural : {};
    let pointsSeen = 0;
    structuralRecommendation = await structuralSearch({
      ladders: sensitivity.knobs,
      baselineRtp: sensitivity.baseline.rtp,
      targetRtp,
      rtpTolerancePct,
      // The sweep's own measured noise floor, so the search can tell a demonstrated winner from a
      // lucky draw. Without it, ten cells measured at Candy Frenzy's ±17.89pp against a ±1.5pp
      // tolerance guarantee a spurious "hit".
      noiseFloorPct: sensitivity.noiseFloorPct ?? 0,
      knobs: opts.knobs ?? null,
      respectDesignIntent: opts.respectDesignIntent ?? true,
      maxMeasurements: opts.maxMeasurements ?? 8,
      signal,
      // Every trial differs from the sweep baseline ONLY in the structural defaults under test -
      // this is the call site withStructuralDefaults' own comment always anticipated.
      measure: async (params) => {
        const tables = withStructuralDefaults(sweepContext.sweepBase, params);
        await yieldToEventLoop();
        return sweepContext.sweepMeasure(tables, searchSeed + 770100);
      },
      onPoint: onProgress
        ? async (point) => {
          pointsSeen++;
          await onProgress('structural', pointsSeen, null, { event: 'point', ...point }, null);
        }
        : null,
    });
    if (onProgress) {
      await onProgress('structural', 0, null, { event: 'complete', ...structuralRecommendation }, null);
    }
  }

  let currentReelTables = baseReelTables;
  let scatterPhase = null;
  // Builds the Phase 1 trial for a given multiplier - shared by the search itself and by the
  // reel-length reachability probe below, so both scale the trigger symbol identically.
  const buildScatterTrial = (mult) => baseReelTables.map(rt => {
    const trial = JSON.parse(JSON.stringify(rt));
    triggerSymbols.forEach(s => { if (trial.symbols[s]) trial.symbols[s].frequency = rt.symbols[s].frequency * mult; });
    return trial;
  });

  // How many positions of `symbol` a reel's frequency table currently produces on the strip -
  // the same rounding generateReel itself applies (core/SlotMath.js), so this is the real
  // integer count, not an idealized share.
  function stripCountOf(reelTable, symbol, length) {
    const total = Object.values(reelTable.symbols).reduce((sum, v) => sum + (v.frequency > 0 ? v.frequency : 0), 0);
    return Math.max(1, Math.round((reelTable.symbols[symbol].frequency / total) * length));
  }

  // Inverse of the above: the frequency that makes `symbol` land exactly `count` times on this
  // reel. share = freq / (freq + others) and count = round(share * length), so solving
  // share = count/length gives freq = count * others / (length - count).
  function frequencyForCount(reelTable, symbol, count, length) {
    const others = Object.entries(reelTable.symbols)
      .filter(([s]) => s !== symbol)
      .reduce((sum, [, v]) => sum + (v.frequency > 0 ? v.frequency : 0), 0);
    return (count * others) / (length - count);
  }

  // Phase 1b: per-reel integer refinement, run only when the shared multiplier could not reach
  // the target band.
  //
  // Phase 1a applies ONE multiplier to every reel identically, so all reels cross their rounding
  // thresholds together and the trigger rate can only move in whole-lockstep jumps. That lockstep
  // IS the coarseness: on Candy Frenzy the shared multiplier can produce 0.368% and then 0.893%
  // with nothing in between, straight over a 0.45%-0.75% target band.
  //
  // Letting individual reels differ by a single symbol dissolves that. Measured on Candy Frenzy
  // at its real REEL_LENGTH of 500, walking one bonus symbol at a time across reels fills the
  // gap the shared multiplier jumped: [3,3,6,3,3,3,3] -> 0.382%, [4,3,6,3,3,3,3] -> 0.427%,
  // [4,4,6,3,3,3,3] -> 0.695% (in band). No change to reel length, tolerance, or target needed -
  // the target was always reachable, Phase 1 just had no way to express it.
  //
  // Symbols are added to (or removed from) the reels with the fewest (most) first, so the
  // distribution stays as even as it can. That is a deliberate design choice, not just
  // tie-breaking: concentrating trigger symbols on a few reels changes how the game FEELS
  // (near-misses cluster on the same reels every time) even at an identical overall trigger rate.
  //
  // Costs one measurement per single-symbol step, and stops the moment the target band is
  // reached or the walk crosses the target without landing in it (which means the remaining
  // lattice really is too coarse - at which point a longer reel strip is the genuine fix).
  async function refineTriggerCountsPerReel(startTables, startTriggerRate) {
    const counts = startTables.map(rt => stripCountOf(rt, triggerSymbols[0], reelLength));
    const goingUp = startTriggerRate < targetTriggerRatePct;
    let best = null;
    let current = startTriggerRate;

    for (let step = 0; step < maxTriggerRefineSteps; step++) {
      if (signal?.aborted) break;
      // Pick the reel that keeps the spread tightest: lowest count when adding, highest when
      // removing. Reels already at the floor of 1 can't give a symbol up.
      const eligible = counts.map((c, i) => ({ c, i })).filter(({ c }) => goingUp || c > 1);
      if (eligible.length === 0) break;
      eligible.sort((a, b) => goingUp ? a.c - b.c : b.c - a.c);
      const pick = eligible[0].i;
      counts[pick] += goingUp ? 1 : -1;

      const trial = startTables.map((rt, i) => {
        const t = JSON.parse(JSON.stringify(rt));
        triggerSymbols.forEach(s => {
          if (t.symbols[s]) t.symbols[s].frequency = frequencyForCount(rt, s, counts[i], reelLength);
        });
        return t;
      });
      const measured = await measure(trial, searchSeed);
      const error = Math.abs(measured.triggerRate - targetTriggerRatePct);
      if (!best || error < best.error) best = { trial, error, triggerRate: measured.triggerRate, counts: [...counts] };
      if (onProgress) {
        await onProgress('scatter-refine', step, null,
          { ...measured, error, counts: [...counts], target: targetTriggerRatePct, tolerance: triggerRateTolerancePct }, best);
      }
      await yieldToEventLoop();

      if (error <= triggerRateTolerancePct) return { ...best, converged: true, reason: 'converged' };
      // Crossed the target without landing inside the band - one symbol is simply too big a
      // step here, and no further walking in this direction can help.
      if (goingUp ? measured.triggerRate > targetTriggerRatePct : measured.triggerRate < targetTriggerRatePct) {
        return { ...best, converged: false, reason: 'lattice-gap' };
      }
      current = measured.triggerRate;
    }
    return best ? { ...best, converged: false, reason: 'exhausted' } : null;
  }

  // `!diagnoseOnly` because Phase 1 is a SEARCH - it moves the trigger symbol's frequency. A
  // diagnosis reports on the config as it stands and changes nothing, so it skips this and leaves
  // `currentReelTables` at the baseline, which is also exactly the config the loss preview below
  // should be describing.
  if (triggerSymbols.length > 0 && !diagnoseOnly) {
    scatterPhase = await bisect1D({
      initialParam: 1,
      minParam: 0.05,
      maxParam: 8,
      target: targetTriggerRatePct,
      tolerance: triggerRateTolerancePct,
      buildTrial: buildScatterTrial,
      metricOf: (result) => result.triggerRate,
      measure,
      maxIterations,
      seedBase: searchSeed,
      onProgress: onProgress ? (i, mult, result, best) => onProgress('scatter', i, mult, result, best) : null,
      onBusy: onProgress ? (info) => onProgress('busy', info.iteration, null, { ...info, sourcePhase: 'scatter' }, null) : null,
      busyReportIntervalMs,
      yieldToEventLoop,
      signal,
    });
    currentReelTables = scatterPhase.trial;

    // Phase 1b - only when the shared multiplier left the trigger rate outside the band, and
    // only when there is something left to try (a user-requested stop is not a lattice problem).
    if (!scatterPhase.converged && scatterPhase.reason !== 'stopped' && maxTriggerRefineSteps > 0) {
      const refined = await refineTriggerCountsPerReel(currentReelTables, scatterPhase.result?.triggerRate ?? 0);
      if (refined && refined.error < scatterPhase.error) {
        currentReelTables = refined.trial;
        scatterPhase = {
          ...scatterPhase,
          error: refined.error,
          converged: refined.converged,
          reason: refined.reason,
          trial: refined.trial,
          result: { ...scatterPhase.result, triggerRate: refined.triggerRate },
          // The per-reel counts the refinement settled on, and the fact that it ran at all -
          // without this a caller can't tell an even, shared-multiplier result apart from one
          // that deliberately differs by a symbol on some reels.
          refinedPerReelCounts: refined.counts,
        };
      }
    }
    // Announced at the moment Phase 1 hands over, not just in the final diagnostics. Phase 1
    // stopping SHORT of the target is a normal, expected outcome (the reachable trigger rates
    // are a coarse lattice - see bisect1D's own doc), but without this the log jumps straight
    // from the last scatter measurement into Phase 2's steps, which reads as the phase silently
    // giving up. Phase 2 cannot fix it either: it excludes trigger symbols from its dimensions
    // entirely, so whatever trigger rate this phase settled on is final for the whole run, and
    // that is worth saying out loud exactly once, right here.
    if (onProgress) {
      await onProgress('scatter-complete', 0, scatterPhase.mult, {
        converged: !!scatterPhase.converged,
        reason: scatterPhase.reason,
        refinedPerReelCounts: scatterPhase.refinedPerReelCounts ?? null,
        triggerRate: scatterPhase.result?.triggerRate,
        target: targetTriggerRatePct,
        tolerance: triggerRateTolerancePct,
        error: scatterPhase.error,
        bracket: scatterPhase.bracket,
      }, null);
    }
  }

  // ---- Phase 2: joint multi-dimensional tuning of every reel's value-symbol weights ----
  // One free weight per (value symbol, reel) pair, searched jointly via Nelder-Mead -
  // replacing the old per-reel scalar-tilt coordinate descent, which could not
  // simultaneously fix an ordering violation and hit the RTP target when the two required
  // different corrections (see the design doc for the concrete case that proved this: a
  // single scalar can't move one symbol without dragging every other symbol on that reel
  // along with it). "Higher payout should not be more frequent" is now a soft penalty term
  // in the loss (below), not a hard post-hoc floor - the optimizer can accept a small
  // remaining violation rather than force RTP far off target, and any violation still
  // present at the end is reported in diagnostics rather than silently corrected.
  const dims = []; // [{ reelIndex, symbol }] - one entry per free parameter
  const fixedSymbols = []; // [{ reel, symbol }] - excluded from the search entirely (fixed: true)
  const valueBudgetByReel = [];
  const tierOfByReel = [];
  const equalShareByReel = []; // valueBudgetByReel[r] / (tunable symbol count on reel r)
  const isFixed = (symbolsTable, s) => symbolsTable[s].fixed === true;
  currentReelTables.forEach((reelTable, r) => {
    const symbolsTable = reelTable.symbols;
    const nonScatterSymbols = Object.keys(symbolsTable).filter(s => !triggerSymbols.includes(s) && symbolsTable[s].frequency > 0);
    const nonScatterTotal = nonScatterSymbols.reduce((sum, s) => sum + symbolsTable[s].frequency, 0);
    const fixedShapeSymbols = nonScatterSymbols.filter(s => isFixed(symbolsTable, s));
    const valueSymbols = nonScatterSymbols.filter(s => !isFixed(symbolsTable, s));
    const fixedShapeTotal = fixedShapeSymbols.reduce((sum, s) => sum + symbolsTable[s].frequency, 0);
    const valueBudget = nonScatterTotal - fixedShapeTotal;
    valueBudgetByReel[r] = valueBudget;
    tierOfByReel[r] = computeValueRanks(paytable, valueSymbols, payoutOf);
    fixedShapeSymbols.forEach(s => fixedSymbols.push({ reel: r, symbol: s }));
    if (valueSymbols.length > 0 && valueBudget > 0) {
      equalShareByReel[r] = valueBudget / valueSymbols.length;
      valueSymbols.forEach(s => {
        const bounds = resolveFrequencyBounds(reelTable, s);
        dims.push({ reelIndex: r, symbol: s, min: bounds.minFrequency, max: bounds.maxFrequency });
      });
    }
  });

  // Under `reelCoupling` other than 'independent', collapse the per-(symbol, reel) dims down to
  // one dimension per SYMBOL, carrying `reelIndex: null` to mean "every reel". On a cluster-pays
  // game reel index carries no meaning - a cluster forms from grid-adjacent cells, not from a
  // position in a payline - so a free weight per (symbol, reel) simply hands the search degrees
  // of freedom that nothing in the design asked for and nothing in the loss can justify. Measured
  // on Candy Frenzy at 849bc8a, that freedom produced `chewy` at 0.4105 on reel 2 against 0.0056
  // on reel 3, and the resulting tables paid 74.70% RTP - 27pp WORSE than setting every candy to
  // the same frequency. Linking makes that spread unrepresentable rather than merely penalized,
  // and cuts the search from 84 dimensions to 12.
  //
  // Bounds are the TIGHTEST across reels, not the loosest: a bound configured on any one reel
  // still means something once the weight is shared, and taking the widest would let the shared
  // value violate a reel that had specifically asked for a narrower range.
  //
  // `dims` itself is deliberately left intact - the ordering/limit/uniformity penalties below
  // iterate it to find (reel, symbol) pairs, and they measure the PROJECTED reel tables, which
  // always carry real per-reel frequencies regardless of how few free parameters produced them.
  const linkedCoupling = reelCoupling !== 'independent';
  let activeDims = dims;
  if (linkedCoupling && dims.length > 0) {
    const bySymbol = new Map();
    dims.forEach(d => {
      const prev = bySymbol.get(d.symbol);
      if (!prev) { bySymbol.set(d.symbol, { reelIndex: null, symbol: d.symbol, min: d.min, max: d.max }); return; }
      if (d.min != null) prev.min = prev.min == null ? d.min : Math.max(prev.min, d.min);
      if (d.max != null) prev.max = prev.max == null ? d.max : Math.min(prev.max, d.max);
    });
    activeDims = [...bySymbol.values()];
  }

  // uniformityPenaltyOf's own per-symbol targets - excluded from any symbol whose paytable
  // `type` is 'scatter' - even one that doesn't happen to trigger free spins (the only thing
  // that otherwise excludes a symbol from `dims` above). A scatter's ideal frequency plays a
  // fundamentally different role (rare, spread out) than the "value" symbols this penalty
  // compares, so it should neither be pulled toward a target nor count toward computing one.
  // Ordering/limit penalties are untouched by this - a scatter still participates in those, and
  // in the search itself (`dims`), same as before.
  //
  // The target ISN'T flat ("every symbol should equal the reel's equal share") - it's a
  // straight line across tier rank, tilted the same direction and strength as that reel's own
  // ordering preference (orderingBiasFor(r), already direction * Strength from the tune panel's
  // per-reel dropdown/input). uniformityPenaltyWeight controls how hard the search is pushed
  // toward this line; the bias controls the line's slope - two independent knobs, not one
  // fighting the other the way a flat target vs. a genuine ordering preference otherwise would.
  // bias === 0 (no ordering preference for that reel) collapses the line back to flat/equal,
  // exactly the old behavior - `centered` term drops out entirely below.
  const uniformityDimsByReel = Array.from({ length: reelsCount }, () => []);
  dims.forEach(d => {
    if (paytable[d.symbol]?.type !== 'scatter') uniformityDimsByReel[d.reelIndex].push(d);
  });
  const uniformityTargetsByReel = uniformityDimsByReel.map((reelDims, r) => {
    if (reelDims.length === 0) return null;
    const budget = reelDims.reduce((sum, d) => sum + currentReelTables[r].symbols[d.symbol].frequency, 0);
    const equalShare = budget / reelDims.length;
    const bias = orderingBiasFor(r);
    const ranks = reelDims.map(d => tierOfByReel[r][d.symbol]);
    const meanRank = ranks.reduce((a, b) => a + b, 0) / ranks.length;
    // How far tier ranks spread from their own mean, on this reel - normalizes `centered` to
    // roughly [-1, 1] regardless of how many tiers/symbols this specific reel has, so the same
    // bias magnitude tilts every reel comparably.
    const maxSpread = Math.max(...ranks.map(t => Math.abs(t - meanRank))) || 1;
    const targets = {};
    reelDims.forEach(d => {
      // Sign matches orderingPenaltyOf's own convention exactly (see its doc): bias < 0
      // ("high pay rarer") wants frequency to INCREASE with tier rank (worse-paying symbols
      // more frequent); bias > 0 ("high pay more frequent") wants it to DECREASE.
      const centered = (tierOfByReel[r][d.symbol] - meanRank) / maxSpread;
      targets[d.symbol] = equalShare * (1 - bias * centered);
    });
    return targets;
  });

  // Resolved once: a named band comes straight from core/TuningUnits.js so the band a developer
  // ASKED for and the band a result is CLASSIFIED into are the same table - otherwise picking
  // "Low" and being told the answer is "Low" would prove nothing. A raw number becomes a band by
  // widening with volatilityTolerance. Null when no target was set, which is what makes the weight
  // inert rather than penalizing against an implied target of zero.
  const volatilityBand = targetVolatility == null ? null
    : typeof targetVolatility === 'string' ? volatilityBandToSigma(targetVolatility)
    : { min: targetVolatility - volatilityTolerance, max: targetVolatility + volatilityTolerance, label: `${targetVolatility}x` };

  let rtpPhaseResult = null;
  // What the loss is made of at the starting point - see the "Loss budget preview" block below.
  // Declared out here so it survives into `diagnostics` alongside the phase results.
  let lossPreview = null;

  if (dims.length > 0) {
    // Dedicated RNG for initialWeightStrategy sampling, seeded off searchSeed like every other
    // random part of this search - so which random starting point gets used (when the
    // strategy isn't 'provided') stays a pure function of searchSeed, not of call order or
    // wall-clock time.
    const initialWeightRng = createSeededRng(searchSeed + 424242);
    function sampleUniformFrequency(min, max) {
      return min + initialWeightRng() * (max - min);
    }
    // Box-Muller transform, centered at the min/max midpoint with std = a quarter of the
    // range (so [min, max] covers roughly the middle 95%) - clamped back into [min, max] as a
    // backstop against the rare sample landing outside that range in either tail.
    function sampleNormalFrequency(min, max) {
      const mean = (min + max) / 2;
      const std = (max - min) / 4;
      const u1 = Math.max(initialWeightRng(), Number.EPSILON); // avoid log(0)
      const u2 = initialWeightRng();
      const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      return Math.min(max, Math.max(min, mean + z * std));
    }
    // A dimension only has a defined [min, max] to sample from once both bounds are
    // configured (via resolveFrequencyBounds - symbol override or reel default) - one missing
    // either bound, or the strategy being 'provided', always starts at its baseline frequency.
    // A linked dim (`reelIndex: null`) has no single reel to read a baseline from - reel 0 stands
    // in for all of them, which is exact for the identical-reel starting point every cluster game
    // here uses, and a reasonable anchor otherwise since the first projection renormalizes each
    // reel against its own budget anyway.
    const baselineReelOf = (d) => d.reelIndex ?? 0;
    const rawSampled = activeDims.map(d => {
      const provided = currentReelTables[baselineReelOf(d)].symbols[d.symbol].frequency;
      if (initialWeightStrategy === 'provided' || d.min == null || d.max == null) return provided;
      const sampled = initialWeightStrategy === 'normal'
        ? sampleNormalFrequency(d.min, d.max)
        : sampleUniformFrequency(d.min, d.max);
      return Math.max(sampled, Number.MIN_VALUE);
    });
    // Projected onto the reel's budget WITHIN each symbol's own bounds before being handed to the
    // search. Without this the sampled values are renormalized by projectPoint against a fixed
    // budget, which drags them toward budget/N and routinely outside the very bounds they were
    // drawn from - measured on Candy Frenzy, a request for [0.005, 0.5] produced 0.00125.
    //
    // Anchored to the baseline reel: under linked coupling one shared weight serves every reel and
    // the reels have different budgets, so no single vector can sit inside the bounds after each
    // reel's own renormalization. Being in-bounds for the reel it was drawn against is the most
    // that is available, and any residual crossing is real and correctly charged by limitPenaltyOf
    // rather than hidden.
    let initialFrequencies = rawSampled;
    if (initialWeightStrategy !== 'provided') {
      const anchorReel = baselineReelOf(activeDims[0] ?? { reelIndex: 0 });
      const budget = valueBudgetByReel[anchorReel];
      if (budget > 0) {
        const rawByKey = {};
        activeDims.forEach((d, i) => { rawByKey[i] = rawSampled[i]; });
        const projected = renormalizeWithinBounds(rawByKey, budget,
          (i) => ({ min: activeDims[i].min, max: activeDims[i].max }));
        initialFrequencies = activeDims.map((d, i) => projected[i]);
      }
    }
    const initialPoint = initialFrequencies.map(f => Math.log(Math.max(f, Number.MIN_VALUE)));
    // Generous per-dimension bounds (relative to that dimension's own starting frequency,
    // not a shared absolute range) - wide enough to not artificially constrain the search,
    // just enough to keep the simplex from drifting to a degenerate near-zero or runaway
    // value on a reel whose other symbols have a very different scale.
    const dimBounds = activeDims.map(d => {
      const base = currentReelTables[baselineReelOf(d)].symbols[d.symbol].frequency;
      return { minX: Math.log(base * 0.001), maxX: Math.log(base * 1000) };
    });

    // Which dimensions and bounds the CURRENTLY RUNNING search stage is exploring. `reelCoupling:
    // 'linked-then-refine'` runs two stages back to back - a linked one over `activeDims`, then a
    // per-reel one over `dims` bounded tightly around the linked answer - and every closure below
    // (projectPoint, and through it makeEvaluate) reads whichever pair is active. Stages run
    // strictly sequentially and never interleave, so a mutable pair here is simpler and harder to
    // get wrong than threading both through every call site. For every other coupling mode these
    // are set once and never change, i.e. exactly the previous behavior.
    let stageDims = activeDims;
    let stageBounds = dimBounds;

    // Turns a raw parameter vector into a full N-reel array: clamp each dimension to its
    // bounds, exponentiate out of log-space, then renormalize each reel's value-symbol
    // weights back to that reel's fixed budget - every other reel/symbol not in `dims`
    // (scatter, wild-excluded, or baseline-zero) is carried through from currentReelTables
    // untouched.
    function projectPoint(x) {
      const reelTables = currentReelTables.map(rt => JSON.parse(JSON.stringify(rt)));
      const rawByReel = {};
      stageDims.forEach((d, i) => {
        const xi = Math.min(stageBounds[i].maxX, Math.max(stageBounds[i].minX, x[i]));
        const value = Math.exp(xi);
        // `reelIndex: null` is a LINKED dimension - the same raw weight goes to every reel. Each
        // reel is still renormalized against its OWN valueBudget below, which is what preserves
        // that reel's scatter:candy ratio, so Phase 1's trigger-rate result survives linking
        // unchanged even though the candy weights are now shared.
        if (d.reelIndex == null) {
          for (let r = 0; r < reelTables.length; r++) (rawByReel[r] ??= {})[d.symbol] = value;
        } else {
          (rawByReel[d.reelIndex] ??= {})[d.symbol] = value;
        }
      });
      Object.keys(rawByReel).forEach(rIdxStr => {
        const rIdx = Number(rIdxStr);
        const renormalized = renormalizeWeights(rawByReel[rIdx], valueBudgetByReel[rIdx]);
        Object.keys(renormalized).forEach(s => { reelTables[rIdx].symbols[s].frequency = renormalized[s]; });
      });
      return reelTables;
    }

    // Soft ordering penalty: sums, per reel, how much that reel's own preferred direction is
    // violated for each pair of value symbols present. Direction/strength is per-reel via
    // orderingBiasFor(r): bias -1 (default) penalizes a higher-paying symbol (a) being more
    // frequent than a lower-paying one (b) on the same reel; bias +1 reverses that (penalizes
    // a being *less* frequent than b instead - e.g. for a "near-miss" reel design where
    // premium symbols should show up often but rarely align); bias 0 disables the preference
    // for that reel. diff = bias * (freq(b) - freq(a)) unifies both directions: it's positive
    // exactly when that reel's own preference is violated, by construction, for either sign
    // of bias.
    function orderingPenaltyOf(reelTables) {
      let total = 0;
      // Each violation re-expressed as a fraction of its own reel's equal share, then averaged
      // over every pair CONSIDERED (not just the violated ones). That makes it "the average pair
      // is out of order by this fraction of a symbol's fair share" - a quantity with the same
      // meaning on a 3-symbol line game and a 12-symbol cluster grid, which the raw sum does not
      // have: the raw total grows with both the frequency scale and the symbol count.
      let normalizedSum = 0;
      let pairsConsidered = 0;
      const violations = [];
      dims.forEach(({ reelIndex: r, symbol: a }) => {
        const bias = orderingBiasFor(r);
        if (bias === 0) return;
        const tierOf = tierOfByReel[r];
        const share = equalShareByReel[r];
        dims.forEach(({ reelIndex: r2, symbol: b }) => {
          if (r !== r2 || a === b || tierOf[a] >= tierOf[b]) return;
          pairsConsidered++;
          const diff = bias * (reelTables[r].symbols[b].frequency - reelTables[r].symbols[a].frequency);
          if (diff > 0) {
            total += diff;
            if (share > 0) normalizedSum += diff / share;
            violations.push({ reel: r, higherPaySymbol: a, lowerPaySymbol: b, amount: diff, bias });
          }
        });
      });
      return { total, normalized: pairsConsidered > 0 ? normalizedSum / pairsConsidered : 0, violations };
    }

    // Soft per-symbol frequency limits: each dim optionally carries its own `min`/`max`
    // (from that symbol's entry in its reel's frequency table - see reelFrequencyTables'
    // doc above). Violating either costs `limitPenaltyWeight` times how far outside the
    // bound the symbol's *projected* (post-renormalization) frequency actually landed - a
    // preference, like ordering, not a hard clamp: the search can still cross a limit if
    // hitting the RTP target genuinely requires it, and any crossing is reported rather than
    // silently prevented.
    function limitPenaltyOf(reelTables) {
      let total = 0;
      // Each overshoot as a fraction of the bound it crossed, averaged over the violations. "20%
      // past its limit" carries the same weight whether the limit was 0.5 or 50, which the raw
      // difference does not.
      let normalizedSum = 0;
      const violations = [];
      dims.forEach(({ reelIndex: r, symbol: s, min, max }) => {
        const freq = reelTables[r].symbols[s].frequency;
        if (min != null && freq < min) {
          const amount = min - freq;
          total += amount;
          if (min > 0) normalizedSum += amount / min;
          violations.push({ reel: r, symbol: s, bound: 'min', limit: min, amount });
        }
        if (max != null && freq > max) {
          const amount = freq - max;
          total += amount;
          if (max > 0) normalizedSum += amount / max;
          violations.push({ reel: r, symbol: s, bound: 'max', limit: max, amount });
        }
      });
      return { total, normalized: violations.length > 0 ? normalizedSum / violations.length : 0, violations };
    }

    // Soft uniformity penalty: discourages any one tunable symbol's frequency on a reel from
    // sitting drastically far from that reel's "equal share" (valueBudget split evenly across
    // every tunable symbol on that reel) - e.g. one symbol at 1.45 while its reel-mates sit at
    // 0.02-0.065. Deliberately measured as a *relative* deviation (how many multiples of
    // equalShare a symbol's frequency is off by), not an absolute one, so it means the same
    // thing on a reel whose budget is spread thin across many symbols as on one with few -
    // and left unbounded above (no cap on how "high" a symbol can be penalized) so a single
    // runaway outlier costs proportionally more than a handful of comparatively modest ones,
    // matching what actually goes wrong in practice. This is independent of - and can pull in
    // a different direction than - orderingPenaltyOf: ordering only cares that higher-paying
    // symbols land on the correct side of lower-paying ones, not by how much, so a reel can be
    // perfectly ordered and still have one symbol drastically more/less frequent than the rest.
    function uniformityPenaltyOf(reelTables) {
      let total = 0;
      // Already a relative deviation per symbol, so the only thing the raw sum carries that it
      // should not is the DIMENSION COUNT: the same lopsidedness scores 7x higher on Candy
      // Frenzy's 84 dims than on a 12-dim line game. Averaging removes that.
      let counted = 0;
      dims.forEach(({ reelIndex: r, symbol: s }) => {
        if (paytable[s]?.type === 'scatter') return;
        const target = uniformityTargetsByReel[r]?.[s];
        if (!(target > 0)) return;
        const freq = reelTables[r].symbols[s].frequency;
        total += Math.abs(freq - target) / target;
        counted++;
      });
      return { total, normalized: counted > 0 ? total / counted : 0 };
    }

    // Soft penalty on reel-SPACING constraints the generated strip fails to honor - measured on
    // the real strip generateReel actually produces, not on the frequency numbers.
    //
    // This is the one constraint class the search was previously blind to, and the blindness is
    // consequential because generateReel enforces minGap/maxStack on a BEST-EFFORT basis: when a
    // strip is too dense to space a symbol out, `_enforceMinGap`/`_enforceMaxStack` hit their
    // `candidates.length === 0` bailout, return the strip as-is, and report nothing (see
    // core/SlotMath.js). So pushing a symbol's frequency up past what the strip can represent
    // looks completely free to the optimizer, while in the game it produces exactly the clumping
    // the constraints existed to prevent - and on a cluster-pays mechanic, clumping is precisely
    // what inflates cluster wins and RTP.
    //
    // There is a hard ceiling worth understanding: a symbol needing `minGap` between its runs can
    // have at most floor(reelLength / minGap) of them. Candy Frenzy sits over it at BASELINE -
    // minGap 8 on a 500-position strip allows 62 runs, and `gummy` already has 70 (46 violations)
    // and `cake` 61 (42 violations), with 426 total runs across 12 candies leaving 1.17 positions
    // of average spacing. So this penalty starts non-zero there and cannot be driven to zero by
    // tuning alone; its job is to stop the search making it dramatically WORSE, which it otherwise
    // does freely (at frequency 0.5 - the configured maxFrequency - `cake` reaches 170
    // violations; above it, runs of 36+ against a maxStack of 4).
    //
    // Counted as: one unit per adjacent same-symbol run pair closer than minGap, plus one per
    // position by which a run exceeds maxStack. Both are raw counts, so `spacingPenaltyWeight`
    // alone sets their scale against the RTP error term.

    function spacingPenaltyOf(reelTables) {
      let total = 0;
      // Violations as a fraction of the runs that COULD have violated. This is the term the raw
      // scale hurt worst: measured on Candy Frenzy the shipped tables carry 301 violations, so at
      // spacingPenaltyWeight 0.25 the term contributes 75 against an RTP error term of about 21 -
      // the search stops optimizing RTP and nothing says so. As a fraction it is bounded by 1 per
      // symbol-reel, so a weight of 1 buys about one RTP point per fully-broken reel.
      let violatingRuns = 0;
      let totalRuns = 0;
      const violations = [];
      const strips = buildReelStrips(reelTables);
      strips.forEach((strip, r) => {
        const n = strip.length;
        const reelTable = reelTables[r];
        Object.keys(reelTable.symbols).forEach(s => {
          if (!(reelTable.symbols[s].frequency > 0)) return;
          const minGap = resolveMinGapFor(reelTable, s);
          const maxStack = resolveMaxStackFor(reelTable, s);
          if (minGap <= 1 && maxStack === Infinity) return;
          // Walk the strip once collecting this symbol's runs (circular).
          const runs = [];
          for (let i = 0; i < n; i++) {
            if (strip[i] !== s || strip[(i - 1 + n) % n] === s) continue;
            let len = 0;
            while (len < n && strip[(i + len) % n] === s) len++;
            runs.push({ start: i, len });
          }
          if (runs.length === 0) return;
          totalRuns += runs.length;
          let gapViolations = 0;
          if (runs.length > 1 && minGap > 1) {
            for (let x = 0; x < runs.length; x++) {
              const a = runs[x], b = runs[(x + 1) % runs.length];
              const gap = (((b.start - (a.start + a.len)) % n) + n) % n;
              if (gap < minGap) gapViolations++;
            }
          }
          const stackExcess = maxStack === Infinity ? 0
            : runs.reduce((sum, run) => sum + Math.max(0, run.len - maxStack), 0);
          if (gapViolations > 0 || stackExcess > 0) {
            total += gapViolations + stackExcess;
            violatingRuns += gapViolations + stackExcess;
            violations.push({ reel: r, symbol: s, gapViolations, stackExcess, runs: runs.length, minGap, maxStack });
          }
        });
      });
      return { total, normalized: totalRuns > 0 ? violatingRuns / totalRuns : 0, totalRuns, violations };
    }

    // Base seed for Phase 2's common-random-numbers comparability - every point evaluated
    // within one round needs to stay directly comparable. A stalled restart shifts this by a
    // large offset per restart (see the round loop below) so it explores under genuinely
    // different Monte Carlo noise, not just a wider step at the same noisy seed - the whole
    // sequence is still a pure function of `searchSeed`, so tuneFrequencies stays
    // deterministic end-to-end (verified by a dedicated regression test).
    const baseNmSeed = searchSeed + 700000;

    let rtpMin = Infinity, rtpMax = -Infinity;

    // `generation` is supplied by cmaes (nelderMead leaves it undefined). When
    // `rotateSeedPerGeneration` is on, it shifts the measurement seed so every generation sees a
    // FRESH Monte Carlo draw while all candidates within one generation still share a seed.
    //
    // That split is the whole point. Common random numbers within a generation is what makes a
    // generation's ranking fair, and rank is all CMA-ES consumes. But holding ONE seed across the
    // entire run - which is what happened before, since cmaes gets its full budget in a single
    // call and the seed only advanced on a stall-restart - turns the objective into a single
    // fixed noise realization. The search then does not merely overfit it passively: covariance
    // adaptation actively learns the directions in which that particular draw is favorable. The
    // result looks converged and fails to reproduce on any other seed.
    //
    // Rotating per generation makes this proper stochastic approximation, which converges on the
    // TRUE objective rather than one sample of it. Still fully deterministic: the whole sequence
    // remains a pure function of searchSeed.
    function makeEvaluate(nmSeed) {
      return async function evaluate(x, generation) {
        const reelTables = projectPoint(x);
        const seedForThisPoint = (rotateSeedPerGeneration && generation != null)
          ? nmSeed + generation * 65537
          : nmSeed;
        const measured = await measure(reelTables, seedForThisPoint);
        const { total: orderPenalty, normalized: orderNorm, violations: orderingViolations } = orderingPenaltyOf(reelTables);
        const { total: boundsPenalty, normalized: boundsNorm, violations: limitViolations } = limitPenaltyOf(reelTables);
        const { total: uniformityPenalty, normalized: uniformityNorm } = uniformityPenaltyOf(reelTables);
        // Skipped entirely at weight 0 - this regenerates every reel strip, which is cheap
        // beside a Monte Carlo run but pointless when it cannot affect `loss`.
        const { total: spacingPenalty, normalized: spacingNorm, violations: spacingViolations } = spacingPenaltyWeight > 0
          ? spacingPenaltyOf(reelTables)
          : { total: 0, normalized: 0, violations: [] };
        // Which denomination the LOSS is built from. Both are always reported either way, so a
        // weight tuned in one mode can be translated into the other instead of guessed at.
        const norm = penaltyNormalization === 'normalized';
        // How far this candidate's volatility sits OUTSIDE its target band, in sigma. Zero
        // anywhere inside, exactly like the trigger-rate term - a band rather than a point target,
        // so it never competes with RTP over a volatility that was already acceptable.
        const sigma = measured.roundStats?.volatilityIndex ?? null;
        const volatilityPenalty = (volatilityBand && sigma != null)
          ? Math.max(0, sigma - volatilityBand.max, volatilityBand.min - sigma)
          : 0;
        const error = Math.abs(measured.rtp - targetRtp);
        if (measured.rtp < rtpMin) rtpMin = measured.rtp;
        if (measured.rtp > rtpMax) rtpMax = measured.rtp;
        // How far this candidate's trigger rate sits OUTSIDE the target band (zero anywhere
        // inside it) - a band, not a point target, so this never fights the RTP term over
        // trigger-rate differences that were already acceptable.
        const triggerPenalty = Math.max(0, Math.abs(measured.triggerRate - targetTriggerRatePct) - triggerRateTolerancePct);
        return {
          loss: error
            + orderingPenaltyWeight * (norm ? orderNorm : orderPenalty)
            + limitPenaltyWeight * (norm ? boundsNorm : boundsPenalty)
            + uniformityPenaltyWeight * (norm ? uniformityNorm : uniformityPenalty)
            // Already in RTP percentage points, so normalization leaves them alone - the whole
            // point is to bring the others onto THIS scale, not to invent a third one.
            + stdErrorPenaltyWeight * (measured.trialRtpStdError ?? 0)
            + triggerRatePenaltyWeight * triggerPenalty
            // Already in sigma, which is a bet-multiple - dimensionally the same kind of quantity
            // as the RTP error term, so it needs no normalization either.
            + volatilityPenaltyWeight * volatilityPenalty
            + spacingPenaltyWeight * (norm ? spacingNorm : spacingPenalty),
          triggerRatePenalty: triggerPenalty,
          volatilityPenalty,
          spacingPenalty,
          spacingPenaltyNormalized: spacingNorm,
          spacingViolations,
          rtp: measured.rtp,
          triggerRate: measured.triggerRate,
          trialRtpMin: measured.trialRtpMin,
          trialRtpMax: measured.trialRtpMax,
          trialRtpStdDev: measured.trialRtpStdDev,
          trialRtpStdError: measured.trialRtpStdError,
          // The shape of this candidate's payout, not just its average. Carried on every candidate
          // so the winning one can be described without re-simulating it.
          roundStats: measured.roundStats ?? null,
          error,
          orderingPenalty: orderPenalty,
          orderingPenaltyNormalized: orderNorm,
          limitPenalty: boundsPenalty,
          limitPenaltyNormalized: boundsNorm,
          uniformityPenalty,
          uniformityPenaltyNormalized: uniformityNorm,
          orderingViolations,
          limitViolations,
          trial: reelTables,
        };
      };
    }

    // A value only counts as "improved" if it beat its own best-so-far by more than 2%
    // relative - a small, fixed threshold isn't used since RTP error, ordering-penalty
    // totals, and limit-penalty totals live on completely different scales across games.
    function improved(newValue, prevBest) {
      if (prevBest <= 0) return false; // already at zero - nothing left to improve
      return (prevBest - newValue) > prevBest * 0.02;
    }

    // A candidate's RTP only counts as trustworthy if its own measurement uncertainty
    // (trialRtpStdError - see measure()'s own comment) is small enough per maxRtpStdError -
    // see that option's own doc for why landing within rtpTolerancePct on average isn't enough
    // on its own. Always true when maxRtpStdError is left at its Infinity default.
    function reliable(candidate) {
      return (candidate.trialRtpStdError ?? 0) <= maxRtpStdError;
    }

    // Phase 2 runs nelderMead() in rounds of `stallWindowIterations` iterations rather than
    // one long call. A round that improves none of RTP error, the ordering-violation total,
    // or the limit-violation total (each tracked against its own best-so-far, not blended
    // into one number - this is what lets "RTP is stuck but ordering is still improving" keep
    // the search going instead of restarting) is a stall: the next round restarts from the
    // best point found so far, with a wider step and a shifted seed, rather than continuing
    // to grind at the same spot. After `maxStallRestarts` consecutive stalls, the search gives
    // up early rather than spending the rest of `maxIterations` on a dead end - see the design
    // doc for the barfruits case (a genuinely infeasible target that used to run the full
    // budget with no way to notice or explain that) that motivated this.
    // One complete run of the round loop over one set of dimensions. Factored out of the loop
    // body it used to be so `reelCoupling: 'linked-then-refine'` can run it twice - once linked,
    // once per-reel - without duplicating any of the stall/restart/acceptance logic, which is the
    // subtlest code in this file and the last thing that should exist in two copies.
    //
    // `iterationOffset` keeps the 'shape' progress events numbered continuously across both
    // stages, so a caller's log reads as one search rather than two restarting from zero.
    async function runSearchStage({ dims: sDims, bounds: sBounds, startPoint, iterationBudget, iterationOffset = 0, stageTag = null, precomputedBaseline = null }) {
    stageDims = sDims;
    stageBounds = sBounds;
    let point = startPoint;
    let stepSize = initialStepSize;
    let restarts = 0;
    let iterationsUsed = 0;
    let best = null; // best-ever vertex across all rounds, by RTP error
    let bestOrderingPenalty = Infinity;
    let bestLimitPenalty = Infinity;
    let bestUniformityPenalty = Infinity;
    let stallStreak = 0;
    let stalledOut = false;
    let userStopped = false;
    let stillImproving = { rtp: true, ordering: true, limits: true, uniformity: true };

    // CMA-ES-only: seed `best` with an actual measurement of the starting point itself, before
    // any search runs. Nelder-Mead's own initial simplex always includes `initialPoint` as one
    // of its real, competing vertices (vertex 0) - if nothing in the search ever beats it, that
    // exact starting candidate naturally IS the round's own result, so `best` ends up correctly
    // anchored at (never worse than) whatever was passed in, even continuing from a previous
    // run's result. CMA-ES has no equivalent: it only ever samples random perturbations AROUND
    // its mean (never the literal mean itself, i.e. never `initialPoint` unperturbed) and, unlike
    // Nelder-Mead, gets its FULL iteration budget in one uninterrupted call (see the comment
    // below), so there is otherwise nothing stopping a long, noisy search from wandering to a
    // final result that's actually WORSE than the point it started from - which is exactly what
    // "continue tuning from this result" must never do. Measured under `baseNmSeed` - the same
    // seed the first round's own candidates use - so it's directly comparable to them.
    if (searchAlgorithm === 'cmaes') {
      // The loss preview measured exactly this point under exactly this seed a moment ago, so the
      // first stage is handed that result rather than paying for an identical measurement. Only
      // the first: a later stage starts from a different point, and reusing it there would anchor
      // the search to a candidate it never evaluated.
      const baseline = precomputedBaseline ?? { point: startPoint, ...(await makeEvaluate(baseNmSeed)(startPoint)) };
      best = baseline;
      bestOrderingPenalty = baseline.orderingPenalty;
      bestLimitPenalty = baseline.limitPenalty;
      bestUniformityPenalty = baseline.uniformityPenalty;
    }

    do {
      // CMA-ES doesn't chop into short `stallWindowIterations` rounds the way Nelder-Mead
      // does: it continuously adapts its own step size and covariance matrix generation to
      // generation, so judging it "stalled" after only a handful of generations - especially
      // on an expensive, many-dimensional, many-spin search - cuts it off before it's had a
      // real chance to make progress, then throws away its learned covariance/step-size state
      // for no good reason. It gets the FULL remaining budget in one call instead, and only
      // loops back around here at all if it stops on its own before using all of it (its own
      // sigma-collapse convergence check, `nm.converged` below) - at which point a widened
      // restart (same mechanism as Nelder-Mead's) is a legitimate "try a wider net after
      // genuine convergence" step, not a premature interruption.
      const roundIterations = searchAlgorithm === 'cmaes'
        ? iterationBudget - iterationsUsed
        : Math.min(stallWindowIterations, iterationBudget - iterationsUsed);
      const nmSeed = baseNmSeed + restarts * 1300021;
      const roundStartIterations = iterationOffset + iterationsUsed;
      // Which function actually runs this round - both return the same
      // { point, loss, result, iterations, converged } shape (see `searchAlgorithm`'s own doc
      // above), so nothing below this call needs to know or care which one it got.
      const runSearch = searchAlgorithm === 'cmaes' ? cmaes : nelderMead;
      const nm = await runSearch({
        initialPoint: point,
        initialStepSize: stepSize,
        evaluate: makeEvaluate(nmSeed),
        maxIterations: roundIterations,
        seed: nmSeed, // ignored by nelderMead (no such param); seeds cmaes's own sampling
        // `attempted` (nelderMead's own doc) is folded into `result` rather than added as a 6th
        // positional argument here, so tuneFrequencies' own onProgress signature stays the
        // fixed `(phase, iteration, multiplier, result, best)` shape documented above for every
        // phase - a caller that doesn't know about `attempted` yet just never looks at it.
        // `stage` rides along on every 'shape' event so a caller can say WHICH search is running.
        // Without it a two-stage run reports "Step 9" identically whether that is the linked stage
        // or the per-reel refinement, and a developer watching the log cannot tell whether the
        // handover ever happened - only that the numbers changed.
        onProgress: onProgress
          ? (i, pt, result, roundBest, attempted) => onProgress('shape', roundStartIterations + i, null, { ...result, attempted, stage: stageTag }, roundBest)
          : null,
        onBusy: onProgress
          ? (info) => onProgress('busy', roundStartIterations + info.iteration, null, { ...info, sourcePhase: 'shape' }, null)
          : null,
        busyReportIntervalMs,
        yieldToEventLoop,
        signal,
      });
      iterationsUsed += nm.iterations;

      const prevBestError = best ? best.error : Infinity;
      const prevBestOrdering = bestOrderingPenalty;
      const prevBestLimit = bestLimitPenalty;
      const prevBestUniformity = bestUniformityPenalty;

      // Captured before mutating `best` so the 'restart' onProgress event below (fired only on
      // a stall) can tell a caller whether THIS round's own best actually became the new
      // cross-round incumbent, or was rejected because its improvement didn't clear the
      // combined-standard-error margin against the previous incumbent - otherwise indistinguishable
      // from the UI's perspective (both cases just move on to another round).
      const candidateAccepted = beatsIncumbent(nm.result, best, bestAcceptanceZ);
      if (candidateAccepted) best = nm.result;
      if (nm.result.orderingPenalty < bestOrderingPenalty) bestOrderingPenalty = nm.result.orderingPenalty;
      if (nm.result.limitPenalty < bestLimitPenalty) bestLimitPenalty = nm.result.limitPenalty;
      if (nm.result.uniformityPenalty < bestUniformityPenalty) bestUniformityPenalty = nm.result.uniformityPenalty;

      stillImproving = {
        rtp: improved(best.error, prevBestError),
        ordering: improved(bestOrderingPenalty, prevBestOrdering),
        limits: improved(bestLimitPenalty, prevBestLimit),
        uniformity: improved(bestUniformityPenalty, prevBestUniformity),
      };

      const fullyResolved = best.error <= earlyAcceptErrorPct && bestOrderingPenalty <= 0 && bestLimitPenalty <= 0 && reliable(best);
      if (fullyResolved) break;

      // Checked before the stall/restart branch below, not folded into it - a user-requested
      // stop isn't a stall (the search may well have still been actively improving), so it
      // shouldn't also widen the step or fire a "Round stalled" event for something that isn't
      // one. `best` (and every penalty tracker) already reflects this round's own work by this
      // point regardless of which branch is taken, so stopping here never discards anything.
      if (signal?.aborted) { userStopped = true; break; }

      if (stillImproving.rtp || stillImproving.ordering || stillImproving.limits || stillImproving.uniformity) {
        stallStreak = 0;
        // The anchor only moves to this round's endpoint if that endpoint actually became the
        // cross-round incumbent (`candidateAccepted`, the same statistically-gated test `best`
        // uses). Previously it advanced whenever ANY ONE of rtp/ordering/limits/uniformity
        // improved by >2%, which is a much weaker condition than "this candidate is better
        // overall" - so the search could keep walking its starting point in a direction that only
        // helped a single term (possibly just noise) while total loss got worse, round after
        // round. Compounded across restarts and across "continue from this result", that is a
        // slow drift away from the best point ever found. Falling back to `best.point` keeps the
        // search anchored to something it has actually verified.
        point = candidateAccepted ? nm.point : best.point;
      } else {
        stallStreak++;
        restarts++;
        point = best.point;
        stepSize *= stallWidenFactor;
        // A distinct progress event (not folded into the per-iteration 'shape' one above) so a
        // caller can announce the restart explicitly - otherwise a stall is invisible in a live
        // view: the per-iteration log line looks the same whether or not a restart just fired,
        // even though the search jumped back to `best.point` with a wider step underneath it.
        if (onProgress) {
          await onProgress('restart', iterationOffset + iterationsUsed, null,
            {
              stepSize, restarts, stallStreak, maxStallRestarts, willStopNow: stallStreak >= maxStallRestarts,
              // Whether the round that just stalled actually became the new incumbent `best`
              // (see `candidateAccepted` above) - `roundResult` is that round's own best candidate,
              // included so a caller can explain why it wasn't accepted even though nothing about
              // a stall inherently implies rejection (the two are independent: a round can stall
              // AND still have produced a new incumbent, or stall while its own best still loses
              // to a noisier-but-nominally-better previous incumbent).
              candidateAccepted, roundResult: nm.result,
            }, best);
        }
        if (stallStreak >= maxStallRestarts) {
          stalledOut = true;
          break;
        }
      }
    } while (iterationsUsed < iterationBudget);

    return {
      best, iterationsUsed, restarts, stalledOut, userStopped, stillImproving,
      bestOrderingPenalty, bestLimitPenalty, bestUniformityPenalty,
    };
    }

    // ---- Run the stage(s) ----
    // Every coupling mode except 'linked-then-refine' is a single stage, identical to the single
    // pass this loop always was. 'linked-then-refine' splits the budget: 70% to the linked stage,
    // where the real RTP movement happens on a fraction of the dimensions, and the remainder to a
    // per-reel refinement bounded to +/-maxReelDeviation around the linked answer. The split is
    // deliberate - giving 2b the full budget would hand back exactly the freedom 2a exists to
    // remove, just from a better starting point.
    let stage = null;
    let coupling = null;

    // ---- Loss budget preview ----
    // What the search is ACTUALLY optimizing, stated before it spends its budget rather than
    // reconstructed afterwards. 150 iterations is a long time to discover that the spacing term was
    // worth 75 and the RTP error 21 - i.e. that "tuning for RTP" was tuning for spacing all along.
    //
    // Costs one measurement, and on CMA-ES not even that: it needs a measurement of exactly this
    // point for its own baseline anchor, so the result is handed straight to the first stage
    // instead of being paid for twice.
    const previewBaseline = { point: initialPoint, ...(await makeEvaluate(baseNmSeed)(initialPoint)) };
    const usingNormalized = penaltyNormalization === 'normalized';
    const norm = usingNormalized;
    const lossTerms = [
      { key: 'rtpError', label: 'RTP error', weight: 1, value: previewBaseline.error, contribution: previewBaseline.error },
      { key: 'ordering', label: 'Payout ordering', weight: orderingPenaltyWeight,
        value: norm ? previewBaseline.orderingPenaltyNormalized : previewBaseline.orderingPenalty },
      { key: 'limits', label: 'Frequency limits', weight: limitPenaltyWeight,
        value: norm ? previewBaseline.limitPenaltyNormalized : previewBaseline.limitPenalty },
      { key: 'uniformity', label: 'Even spread', weight: uniformityPenaltyWeight,
        value: norm ? previewBaseline.uniformityPenaltyNormalized : previewBaseline.uniformityPenalty },
      { key: 'spacing', label: 'Reel spacing', weight: spacingPenaltyWeight,
        value: norm ? previewBaseline.spacingPenaltyNormalized : previewBaseline.spacingPenalty },
      { key: 'triggerRate', label: 'Trigger rate', weight: triggerRatePenaltyWeight, value: previewBaseline.triggerRatePenalty },
      { key: 'stdError', label: 'Measurement noise', weight: stdErrorPenaltyWeight, value: previewBaseline.trialRtpStdError ?? 0 },
    ].map(t => ({ ...t, contribution: t.contribution ?? t.weight * t.value }));
    const lossTotal = lossTerms.reduce((sum, t) => sum + t.contribution, 0);
    lossTerms.sort((a, b) => b.contribution - a.contribution);
    lossTerms.forEach(t => { t.contributionPct = lossTotal > 0 ? (t.contribution / lossTotal) * 100 : 0; });
    const dominant = lossTerms[0];
    lossPreview = {
      terms: lossTerms,
      total: lossTotal,
      penaltyNormalization,
      dominant: dominant?.key ?? null,
      // Flagged only when something OTHER than RTP error is running the search. That is the
      // finding: a penalty outweighing the objective is a legitimate choice, but it should be one
      // the developer made on purpose rather than one they discover 150 iterations later.
      rtpIsDominant: dominant?.key === 'rtpError',
    };
    if (onProgress) await onProgress('loss-preview', 0, null, lossPreview, null);

    // ---- Diagnosis-only exit ----
    // Everything above this line is DIAGNOSIS: what is wrong with the config, what an even
    // distribution pays, which structural knob actually moves RTP, what to set them to, and what
    // the loss is made of. None of it searches anything, and all of it is the sort of thing that
    // should change the inputs you hand the search - which is the wrong order if it only ever runs
    // as the opening act of a search you have already committed to. `diagnoseConfig` stops here.
    //
    // It sits INSIDE the Phase 2 setup rather than before it because the loss preview needs
    // `makeEvaluate` and `initialPoint`, which are built here. Nothing has been searched at this
    // point: Phase 1 is skipped for a diagnosis (see its own guard) and no stage has run.
    //
    // Implemented as an early return from this same function rather than as a separate routine, on
    // purpose: a second implementation would drift, and a diagnosis that disagreed with the tune it
    // precedes would be worse than no diagnosis at all.
    if (diagnoseOnly) {
      return {
        reelFrequencyTables: baseReelTables,
        rtp: null, triggerRatePct: null, scaledPaytable: null,
        diagnostics: { validation, structuralHeadroom, sensitivity, structuralRecommendation, lossPreview, reelFeasibility, diagnoseOnly: true },
      };
    }

    // Announces which search is about to run, what it can move, and why - fired before every
    // stage, single-stage runs included. A search that silently changes strategy partway through
    // is indistinguishable from one that never changed at all: the per-iteration numbers move
    // either way. `stage` identifies it, `strategy`/`why` explain it in a form a caller can show
    // verbatim rather than having to reconstruct from `coupling` after the fact.
    const announceStage = async (stage, extra) => {
      if (!onProgress) return;
      await onProgress('coupling-stage', 0, null, { stage, mode: reelCoupling, ...extra }, null);
    };

    if (reelCoupling === 'linked-then-refine' && dims.length > activeDims.length) {
      const linkedBudget = Math.max(1, Math.round(maxIterations * 0.7));
      await announceStage('linked', {
        event: 'start', dimensions: activeDims.length, comparedTo: dims.length, iterationBudget: linkedBudget,
        strategy: 'one shared weight per symbol, applied to every reel',
        why: 'reel index carries no meaning on a cluster grid, so per-reel spread is search noise rather than design - sharing one weight makes it unrepresentable instead of merely penalized',
      });
      const stageA = await runSearchStage({
        dims: activeDims, bounds: dimBounds, startPoint: initialPoint, iterationBudget: linkedBudget,
        stageTag: 'linked', precomputedBaseline: previewBaseline,
      });
      await announceStage('linked', { event: 'end', rtp: stageA.best.rtp, error: stageA.best.error, iterationsUsed: stageA.iterationsUsed, reason: stageA.stalledOut ? 'stalled' : stageA.userStopped ? 'stopped' : 'budget spent' });
      // Phase 2b starts from what 2a actually produced, read back off the projected tables rather
      // than off stage A's point vector - the two differ, because projectPoint renormalizes each
      // reel against its own budget, and it is the renormalized frequencies that were measured.
      const refineStart = dims.map(d => Math.log(stageA.best.trial[d.reelIndex].symbols[d.symbol].frequency));
      const refineBounds = refineStart.map(x => ({
        minX: x + Math.log(1 - maxReelDeviation),
        maxX: x + Math.log(1 + maxReelDeviation),
      }));
      const remaining = maxIterations - stageA.iterationsUsed;
      let stageB = null;
      if (remaining > 0 && !stageA.userStopped) {
        await announceStage('refine', {
          event: 'start', dimensions: dims.length, comparedTo: activeDims.length, iterationBudget: remaining,
          maxReelDeviation,
          strategy: `one weight per (symbol, reel), each held within +/-${(maxReelDeviation * 100).toFixed(0)}% of the shared value`,
          why: 'a deliberate per-reel tilt is a real design choice, so refinement can express one - the bound is what stops it re-inventing the spread the linked stage just removed',
        });
        stageB = await runSearchStage({
          dims, bounds: refineBounds, startPoint: refineStart,
          iterationBudget: remaining, iterationOffset: stageA.iterationsUsed,
          stageTag: 'refine',
        });
      } else {
        await announceStage('refine', {
          event: 'skipped',
          why: stageA.userStopped ? 'the run was stopped before refinement could start'
            : 'the linked stage used the whole iteration budget - raise Max Iterations to leave room for a refinement pass',
        });
      }
      // 2b only replaces 2a if it beat it on the same statistically-gated test `best` itself uses.
      // Without that check a noisier refinement could quietly undo a better linked answer - the
      // precise failure 7ba9259 fixed for restarts, which would otherwise reappear here.
      //
      // Both sides are RE-MEASURED under one common seed before being compared, rather than
      // compared on the losses each stage happens to carry. Those carried losses are not
      // commensurable: a stage's `best` was measured under whichever round seed was current when
      // it was found, and the round loop shifts that seed on every stall restart. Comparing them
      // directly compares two different Monte Carlo draws, and the gap that shows up is noise at
      // least as often as signal - observed here as stage B "winning" at maxReelDeviation 0, where
      // it is pinned to stage A's exact point and cannot possibly have improved on it. Two extra
      // measurements buy a comparison that means what it claims to, and the winner's reported RTP
      // is then the one it was actually judged on.
      let linkedFinal = null, refinedFinal = null, refineWon = false;
      if (stageB != null) {
        linkedFinal = { ...stageA.best, point: refineStart, ...(await makeEvaluate(baseNmSeed)(refineStart)) };
        refinedFinal = { ...stageB.best, ...(await makeEvaluate(baseNmSeed)(stageB.best.point)) };
        refineWon = beatsIncumbent(refinedFinal, linkedFinal, bestAcceptanceZ);
        await announceStage('refine', {
          event: 'end', accepted: refineWon,
          linkedRtp: linkedFinal.rtp, refinedRtp: refinedFinal.rtp,
          linkedLoss: linkedFinal.loss, refinedLoss: refinedFinal.loss,
          iterationsUsed: stageB.iterationsUsed,
          why: refineWon
            ? 'the per-reel refinement beat the shared answer by more than their combined measurement error, so it is kept'
            : 'the per-reel refinement did not beat the shared answer by more than their combined measurement error, so the shared answer is kept and the reels stay on one mix',
        });
      }
      stage = refineWon ? stageB : stageA;
      if (stageB) {
        stage = {
          ...stage,
          best: refineWon ? refinedFinal : linkedFinal,
          iterationsUsed: stageA.iterationsUsed + stageB.iterationsUsed,
          userStopped: stageA.userStopped || stageB.userStopped,
        };
      }
      coupling = {
        mode: reelCoupling,
        dimsLinked: activeDims.length,
        dimsRefined: dims.length,
        // Both under the common comparison seed when a refinement ran, so the two are directly
        // comparable to each other and to whichever one `rtp` ends up reporting.
        linkedRtp: linkedFinal ? linkedFinal.rtp : stageA.best.rtp,
        refinedRtp: refinedFinal ? refinedFinal.rtp : null,
        // Whether the per-reel refinement earned its budget, or the linked answer stood. A run
        // where this is repeatedly false is a run whose Phase 2b budget would be better spent on
        // Phase 2a - worth being able to see rather than infer.
        refinementAccepted: refineWon,
      };
    } else {
      // Single-stage runs announce themselves too. "Which strategy is this?" is a question worth
      // answering even when there is only one answer - silence reads as "nothing decided this",
      // and a developer who has just switched coupling modes needs to see that the switch took.
      await announceStage(linkedCoupling ? 'linked' : 'independent', {
        event: 'start', dimensions: activeDims.length, iterationBudget: maxIterations, onlyStage: true,
        strategy: linkedCoupling
          ? 'one shared weight per symbol, applied to every reel'
          : 'one weight per (symbol, reel), each free of the others',
        why: linkedCoupling
          ? 'reel index carries no meaning on a cluster grid, so per-reel spread is search noise rather than design'
          : 'reel position genuinely matters on a payline game, so each reel is tuned on its own',
      });
      stage = await runSearchStage({
        dims: activeDims, bounds: dimBounds, startPoint: initialPoint, iterationBudget: maxIterations,
        stageTag: linkedCoupling ? 'linked' : 'independent', precomputedBaseline: previewBaseline,
      });
      await announceStage(linkedCoupling ? 'linked' : 'independent', {
        event: 'end', rtp: stage.best.rtp, error: stage.best.error, iterationsUsed: stage.iterationsUsed,
        reason: stage.stalledOut ? 'stalled' : stage.userStopped ? 'stopped' : 'budget spent',
      });
      coupling = {
        mode: reelCoupling,
        dimsLinked: linkedCoupling ? activeDims.length : 0,
        dimsRefined: linkedCoupling ? 0 : dims.length,
        linkedRtp: linkedCoupling ? stage.best.rtp : null,
        refinedRtp: linkedCoupling ? null : stage.best.rtp,
        refinementAccepted: null,
      };
    }

    const {
      best, iterationsUsed, restarts, stalledOut, userStopped, stillImproving,
      bestOrderingPenalty, bestLimitPenalty, bestUniformityPenalty,
    } = stage;

    currentReelTables = best.trial;
    const reason = (() => {
      // Takes priority over every other classification, even one that would otherwise read as
      // 'converged' - the search was stopped by explicit request, not by its own criteria, and
      // that's the more honest thing to report regardless of how close the result happens to be.
      if (userStopped) return 'stopped';
      const rtpOk = best.error <= rtpTolerancePct && reliable(best);
      const violationsOk = bestOrderingPenalty <= 0 && bestLimitPenalty <= 0;
      if (rtpOk && violationsOk) return 'converged';
      if (rtpOk) return 'converged-with-violations';
      if (stalledOut) return 'stalled';
      return 'exhausted';
    })();

    rtpPhaseResult = {
      ...best,
      iterations: iterationsUsed,
      restarts,
      reason,
      // How Phase 2's reel axis was treated. `dimsLinked` vs `dimsRefined` is the concrete thing
      // to look at: identical-looking frequencies from a linked run and an independent run came
      // out of searches with very different degrees of freedom, and the diagnostics should say
      // which one produced this result rather than leaving it to be inferred from the tables.
      coupling,
      rtpRange: { min: rtpMin, max: rtpMax },
      orderingPenaltyRemaining: bestOrderingPenalty,
      limitPenaltyRemaining: bestLimitPenalty,
      uniformityPenaltyRemaining: bestUniformityPenalty,
      stillImproving,
      fixedSymbols,
    };
  }

  // A game with nothing tunable never enters the Phase 2 block above, so the diagnosis exit inside
  // it is never reached. Without this, such a config would fall through and be measured and
  // reported as though it had been tuned - a result, from a call that promised not to produce one.
  if (diagnoseOnly) {
    return {
      reelFrequencyTables: baseReelTables,
      rtp: null, triggerRatePct: null, scaledPaytable: null,
      diagnostics: { validation, structuralHeadroom, sensitivity, structuralRecommendation, lossPreview, reelFeasibility, diagnoseOnly: true },
    };
  }

  const finalReelTables = currentReelTables;
  const finalResult = rtpPhaseResult
    ? {
        rtp: rtpPhaseResult.rtp, triggerRate: rtpPhaseResult.triggerRate,
        trialRtpMin: rtpPhaseResult.trialRtpMin, trialRtpMax: rtpPhaseResult.trialRtpMax,
        trialRtpStdDev: rtpPhaseResult.trialRtpStdDev, trialRtpStdError: rtpPhaseResult.trialRtpStdError,
      }
    : await measure(finalReelTables);

  // ---- Payout-value solve ----
  // The one RTP lever that needs no search at all. RTP is EXACTLY proportional to a global scale
  // on every payout multiplier - verified on Candy Frenzy to 5 significant figures at both
  // uniform and heavily skewed frequencies (RTP/k constant at 9.791 and 21.754 respectively).
  // So the scale that lands exactly on target is closed-form: k = targetRtp / measuredRtp.
  //
  // This matters architecturally, not just as a shortcut. Frequencies are a poor RTP lever -
  // they are what the search must torture to hit a target, which is what drives symbols to the
  // over-abundance that breaks reel spacing and cluster behavior. Payout values ARE an exact RTP
  // lever. Solving RTP here frees the frequency search to serve what it is actually good at:
  // ordering, uniformity, spacing and trigger rate.
  //
  // Off by default: it rewrites the game's paytable, which is a design artifact a caller must opt
  // into changing. Returns a scaled COPY as `scaledPaytable` and never mutates the input.
  let payoutScale = null;
  if (solvePayoutScale && finalResult.rtp > 0) {
    const scale = targetRtp / finalResult.rtp;
    const scaledPaytable = scalePaytable(paytable, scale);
    // Verified rather than asserted: linearity held everywhere it was measured, but a mechanic
    // with any non-multiplicative payout component would break it, and silently shipping a
    // paytable that misses the target would be worse than reporting the discrepancy.
    const verified = await measure(finalReelTables, searchSeed + 990002, undefined, scaledPaytable);
    // The verification run is only meaningful if the win evaluator actually READS the paytable it
    // was handed - and when it misses, WHICH reason it missed for decides what the developer
    // should go and do about it. See describePayoutScaleVerification for why that is worked out
    // from the numbers rather than asserted.
    const { verified: verificationLandedOnTarget, note } = describePayoutScaleVerification({
      rtpBeforeScaling: finalResult.rtp,
      verifiedRtp: verified.rtp,
      targetRtp,
      stdError: verified.trialRtpStdError,
      tolerance: Math.max(rtpTolerancePct * 3, targetRtp * 0.1),
    });
    payoutScale = {
      scale,
      rtpBeforeScaling: finalResult.rtp,
      verifiedRtp: verified.rtp,
      verifiedStdError: verified.trialRtpStdError,
      verified: verificationLandedOnTarget,
      verificationNote: note,
      scaledPaytable,
    };
  }

  // Snapshot of the actually-*resolved* tuning knobs (defaults applied, not just whatever the
  // caller happened to pass explicitly) - lets anything serializing `diagnostics` as JSON (the
  // TUNE FREQUENCIES panel's own `console.log('Frequency tuner diagnostics:', ...)`, a test, a
  // future export feature) show exactly what parameters produced this specific result, without
  // the reader having to separately track what was typed into the panel at the time. Built and
  // emitted at the top of the run (see its declaration) so a mid-run export carries it too.

  return {
    reelFrequencyTables: finalReelTables,
    rtp: finalResult.rtp,
    triggerRatePct: finalResult.triggerRate,
    // A rescaled COPY of the caller's paytable that lands exactly on targetRtp, present only when
    // `solvePayoutScale` was requested. The input paytable is never mutated.
    scaledPaytable: payoutScale?.scaledPaytable ?? null,
    diagnostics: {
      inputParameters,
      // Static config checks (core/TuningValidation.js), reported whether or not they blocked -
      // a `skipValidation: true` run still carries its errors here, so a result derived from a
      // knowingly-broken config says so rather than looking like any other result.
      validation,
      // What an even, no-over-abundance symbol distribution actually pays. `shortfallFactor` is
      // how many times short of target that is - the amount of skew the frequency search is being
      // asked to invent. Well above 1 means the over-abundance a tune produces is the optimizer
      // correctly compensating for a structural setting, not a search defect.
      structuralHeadroom,
      // Which structural knob actually moves RTP, and by how much - the answer to "what do I
      // change?", produced without any search at all. `knobs` is sorted by leverage;
      // `routesToTarget` gives the single-knob values that reach targetRtp from here, with
      // payoutScale exact and everything else interpolated between measured points.
      sensitivity,
      // Phase 0d, when requested: one combination of structural settings to accept or reject,
      // searched jointly rather than one knob at a time. `appliedAutomatically` is always false -
      // the returned tables keep the structural defaults they came in with, because which values a
      // game ships is a design decision and not the tuner's to make.
      structuralRecommendation,
      // What the loss was actually made of at the starting point, sorted by contribution, in
      // whichever denomination `penaltyNormalization` selected. `rtpIsDominant: false` means some
      // penalty - not RTP error - is what the search is really optimizing.
      lossPreview,
      // Closed-form payout-value solve, when requested: the exact multiplier applied to every
      // payout to hit targetRtp, plus a verification measurement under the scaled paytable.
      payoutScale: payoutScale
        ? { scale: payoutScale.scale, rtpBeforeScaling: payoutScale.rtpBeforeScaling, verifiedRtp: payoutScale.verifiedRtp, verifiedStdError: payoutScale.verifiedStdError, verified: payoutScale.verified, verificationNote: payoutScale.verificationNote }
        : null,
      // Symbols whose own spacing constraints CANNOT be satisfied at this reel length, checked
      // against the untuned baseline before any search runs. Empty is the healthy case. A
      // non-empty entry means generateReel silently gave up spacing that symbol out (it enforces
      // minGap best-effort), so the shipped reels clump more than the config asks - which on a
      // cluster-pays mechanic directly inflates cluster wins and RTP. Not fixable by tuning: the
      // reel is too short, the gap too wide, or that symbol's frequency too high.
      reelFeasibility,
      scatterPhase: scatterPhase ? {
        multiplier: scatterPhase.mult,
        error: scatterPhase.error,
        converged: !!scatterPhase.converged,
        // Why this phase stopped - 'converged' | 'unreachable-low' | 'unreachable-high' |
        // 'lattice-gap' | 'exhausted' | 'stopped' (see bisect1D's own doc). The three
        // non-'exhausted' failure reasons all mean "no multiplier can satisfy this target",
        // which is a fundamentally different situation from "ran out of iterations" and wants a
        // different fix (longer reel strip / wider tolerance / different target, not more
        // search). Reported rather than collapsed into a bare converged:false.
        reason: scatterPhase.reason,
        // The final bracket the search closed on: the two multipliers either side of the
        // target and what each actually measured. When `reason` is 'lattice-gap' these are the
        // closest achievable trigger rates above and below the target - i.e. exactly what IS
        // reachable, which is the information needed to pick a feasible target.
        bracket: scatterPhase.bracket,
        // Present only when Phase 1b's per-reel refinement ran AND improved on the shared
        // multiplier: the exact number of trigger-symbol positions each reel ended up with.
        // Absent means every reel carries the same shared multiplier, unrefined - worth being
        // able to tell apart, since a deliberately uneven distribution is a real design choice
        // (it changes which reels near-misses cluster on), not an artifact.
        refinedPerReelCounts: scatterPhase.refinedPerReelCounts ?? null,
        ...scatterPhase.result,
      } : null,
      // How much the trigger rate MOVED between Phase 1 handing over and the final tuned result.
      // Phase 2 never tunes a trigger symbol's own frequency, so for a line-pay mechanic this is
      // ~0 by construction. For a cascade mechanic it is not: the other symbols' weights govern
      // cascade depth, and every cascade refills the grid with fresh chances to draw the scatter
      // (measured on Candy Frenzy: a 0.75%-2.04% swing from candy reweighting alone). Reported
      // unconditionally, including when `triggerRatePenaltyWeight` is 0 and the search was
      // therefore blind to it - a large drift here with a zero weight is exactly the situation
      // where a tune reports a healthy RTP alongside a trigger rate nowhere near its target, and
      // it should be visible rather than inferred.
      triggerRateDrift: scatterPhase ? {
        afterPhase1: scatterPhase.result?.triggerRate,
        final: finalResult.triggerRate,
        delta: finalResult.triggerRate - (scatterPhase.result?.triggerRate ?? finalResult.triggerRate),
        target: targetTriggerRatePct,
        tolerance: triggerRateTolerancePct,
        finalWithinTolerance: Math.abs(finalResult.triggerRate - targetTriggerRatePct) <= triggerRateTolerancePct,
        penaltyWeight: triggerRatePenaltyWeight,
      } : null,
      rtpPhase: rtpPhaseResult ? {
        // The actual scalar every accept/reject decision (beatsIncumbent, Nelder-Mead/CMA-ES's
        // own vertex comparisons) is made on - error + weighted ordering/limit/uniformity
        // penalties (see makeEvaluate's own doc) - exposed directly rather than leaving a caller
        // to re-derive it from error/orderingPenaltyRemaining/limitPenaltyRemaining/
        // uniformityPenaltyRemaining and inputParameters' own weights by hand. A candidate with
        // worse RTP `error` than another can still have LOWER `loss` (and correctly win) if it
        // resolved a violation the other one didn't - `loss`, not `error` alone, is what decided
        // this result.
        loss: rtpPhaseResult.loss,
        error: rtpPhaseResult.error,
        coupling: rtpPhaseResult.coupling,
        // Always false when `reason` is 'stopped' - the search was ended by explicit request,
        // not by meeting its own criteria, even if the error happened to be within tolerance
        // when the signal fired - consistent with `reason` itself taking the same priority.
        converged: rtpPhaseResult.reason !== 'stopped'
          && rtpPhaseResult.error <= rtpTolerancePct && (rtpPhaseResult.trialRtpStdError ?? 0) <= maxRtpStdError,
        reason: rtpPhaseResult.reason,
        rtp: rtpPhaseResult.rtp,
        triggerRate: rtpPhaseResult.triggerRate,
        // The final/best candidate's own trialsPerPoint spread (NOT the same thing as
        // rtpRange below) - how much its individual repeat measurements disagreed with each
        // other. A wide spread here means the reported `rtp` above may just be a lucky sample
        // for a high-variance mechanic, not a trustworthy estimate - see trialsPerPoint's own
        // doc and measure()'s own comment for why this matters. Collapses to a single value
        // (trialRtpMin === trialRtpMax, trialRtpStdDev/trialRtpStdError both 0) when
        // trialsPerPoint is 1 - no repeat was ever taken, so no variance information exists to
        // report. `trialRtpStdError` (not the raw `trialRtpStdDev`) is what `maxRtpStdError`
        // gates `converged` above on - see that option's own doc for why.
        trialRtpMin: rtpPhaseResult.trialRtpMin,
        trialRtpMax: rtpPhaseResult.trialRtpMax,
        trialRtpStdDev: rtpPhaseResult.trialRtpStdDev,
        trialRtpStdError: rtpPhaseResult.trialRtpStdError,
        // The winning candidate's own payout SHAPE - hit rate, percentiles, biggest round, how
        // concentrated the payout is, volatility. Measured as part of evaluating it, so describing
        // what the tuned game feels like costs no extra simulation. See roundStats in simulateSpins.
        roundStats: rtpPhaseResult.roundStats ?? null,
        // Achieved volatility beside the target that was asked for, and the band it classifies
        // into - so "did I get the shape I wanted" is answerable without the caller re-deriving
        // the classification and possibly disagreeing with the search about it.
        volatility: rtpPhaseResult.roundStats
          ? {
              achieved: rtpPhaseResult.roundStats.volatilityIndex,
              achievedBand: sigmaToVolatilityBand(rtpPhaseResult.roundStats.volatilityIndex),
              target: targetVolatility,
              targetSigma: volatilityBand ? { min: volatilityBand.min, max: volatilityBand.max } : null,
              penaltyRemaining: rtpPhaseResult.volatilityPenalty ?? 0,
              withinTarget: !volatilityBand || (rtpPhaseResult.volatilityPenalty ?? 0) === 0,
            }
          : null,
        iterationsRun: rtpPhaseResult.iterations,
        iterationsBudget: maxIterations,
        restarts: rtpPhaseResult.restarts,
        // The spread of averaged-per-candidate RTP across every DIFFERENT candidate the search
        // explored - shows how much ground the search covered, not measurement noise for any
        // one candidate (that's trialRtpMin/trialRtpMax above).
        rtpRange: rtpPhaseResult.rtpRange,
        orderingViolations: rtpPhaseResult.orderingViolations,
        orderingPenaltyRemaining: rtpPhaseResult.orderingPenaltyRemaining,
        limitViolations: rtpPhaseResult.limitViolations,
        limitPenaltyRemaining: rtpPhaseResult.limitPenaltyRemaining,
        uniformityPenaltyRemaining: rtpPhaseResult.uniformityPenaltyRemaining,
        // The same four penalties in their scale-free denomination, reported in BOTH modes
        // (see `penaltyNormalization`). Always present, whichever one the loss was built from,
        // so a weight tuned in one mode can be translated into the other rather than guessed at.
        // These come from the winning candidate rather than the run-wide minimum above, because a
        // ratio of two different candidates' bests is not a quantity that describes anything.
        orderingPenaltyNormalized: rtpPhaseResult.orderingPenaltyNormalized ?? 0,
        limitPenaltyNormalized: rtpPhaseResult.limitPenaltyNormalized ?? 0,
        uniformityPenaltyNormalized: rtpPhaseResult.uniformityPenaltyNormalized ?? 0,
        spacingPenaltyNormalized: rtpPhaseResult.spacingPenaltyNormalized ?? 0,
        penaltyNormalization,
        // Reel-SPACING constraints the winning candidate's generated strip still fails to honor
        // (minGap between runs of a symbol, maxStack run length) - measured on the real strip,
        // since generateReel enforces both best-effort and silently gives up on a strip too dense
        // to satisfy them. Non-zero here means the shipped reels will clump more than the game's
        // own config asks for, which on a cluster-pays mechanic directly inflates cluster wins.
        // Always 0 when spacingPenaltyWeight is 0 (the penalty isn't computed at all then).
        spacingPenaltyRemaining: rtpPhaseResult.spacingPenalty ?? 0,
        spacingViolations: rtpPhaseResult.spacingViolations ?? [],
        stillImproving: rtpPhaseResult.stillImproving,
        fixedSymbols: rtpPhaseResult.fixedSymbols,
      } : null,
    }
  };
}
