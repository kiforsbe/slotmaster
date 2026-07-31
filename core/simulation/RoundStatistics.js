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

export function createRoundAccumulator() {
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

export function summarizeRoundStats(acc) {
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
  if (usable.length === 0) return summarizeRoundStats(createRoundAccumulator());
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
  return summarizeRoundStats(acc);
}


/** Adds one completed paid-spin round without retaining per-round objects. */
export function recordRound(acc, multiple) {
  acc.rounds++;
  if (multiple > 0) acc.hits++;
  acc.sum += multiple;
  acc.sumSq += multiple * multiple;
  if (multiple > acc.max) acc.max = multiple;
  acc.buckets[roundBucketIndex(multiple)]++;
}