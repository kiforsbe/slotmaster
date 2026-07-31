/**
 * What a tuned game actually feels like to play.
 *
 * "96% RTP" and "the biggest win in 40,000 spins was 29x" are two facts about the same game, and
 * only the first has ever been visible anywhere in this tuner. That gap is the whole reason this
 * module exists: a developer can hit every numeric target and still ship something nobody enjoys,
 * and nothing in a converged tune would say so.
 *
 * Pure and simulation-free. It reads the round-shape figures `simulateSpins` already produced (see
 * `roundStats` in core/SpinSimulator.js) and turns them into sentences. Session outcomes are
 * BOOTSTRAP RESAMPLED from the round histogram rather than simulated again - the rounds have
 * already been paid for once.
 *
 * On rules of thumb: the volatility bands and the "commercial games typically run..." comparison
 * are remembered industry ranges, not something measured here. They are labelled as such in the
 * rendered text, because a rule of thumb quoted in the same voice as a measured figure is how it
 * gets repeated back later as a finding.
 */

import { sigmaToVolatilityBand, VOLATILITY_BANDS, pctToSpinsPerTrigger } from './Units.js';

// Deterministic PRNG for the bootstrap. A report whose numbers changed between two identical
// calls would be untrustworthy for the sake of nothing - there is no reason for this to vary.
function seededRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * Draws `sessionSpins` rounds from the measured histogram and returns the session's net result,
 * in units of the bet. Net, not gross: what a player leaves with is winnings minus the stake.
 */
function sampleSession(histogram, totalCount, sessionSpins, rng) {
  let net = 0;
  for (let i = 0; i < sessionSpins; i++) {
    let r = rng() * totalCount;
    for (const bucket of histogram) {
      r -= bucket.count;
      if (r <= 0) { net += bucket.value; break; }
    }
    net -= 1; // the stake for this round
  }
  return net;
}

const SESSION_SAMPLES = 2000;

/**
 * @param {Object|null} roundStats - from `simulateSpins`; null when nothing has been measured.
 * @param {Object} opts
 * @param {number} opts.bet - total bet per round, used only to express money figures.
 * @param {number} opts.rtp - achieved RTP as a percentage.
 * @param {number} opts.triggerRate - achieved free-spin trigger rate as a percentage.
 * @param {number} [opts.sessionSpins=500] - how long a "session" is, for the outcome spread.
 * @returns {{lines: string[], volatilityClass: string|null, sessionOutcomes: Object|null}}
 */
export function describePlayerExperience(roundStats, { bet = 1, rtp, triggerRate, sessionSpins = 500 } = {}) {
  if (!roundStats || !(roundStats.rounds > 0)) {
    return { lines: [], volatilityClass: null, sessionOutcomes: null };
  }

  const { hitRate, medianWin, p90, p99, p999, maxWin, top1PctShare, volatilityIndex, histogram, rounds } = roundStats;
  const volatilityClass = sigmaToVolatilityBand(volatilityIndex);
  const band = VOLATILITY_BANDS[volatilityClass];

  // ---- Session outcomes, by bootstrap ----
  const totalCount = histogram.reduce((sum, b) => sum + b.count, 0);
  const rng = seededRng(20260727);
  const nets = [];
  for (let i = 0; i < SESSION_SAMPLES; i++) {
    nets.push(sampleSession(histogram, totalCount, sessionSpins, rng));
  }
  nets.sort((a, b) => a - b);
  const at = (p) => nets[Math.min(nets.length - 1, Math.max(0, Math.floor(p * nets.length)))];
  const sessionOutcomes = {
    spins: sessionSpins,
    p10: at(0.10),
    median: at(0.50),
    p90: at(0.90),
    // How often a session ends up ahead at all. The number that makes an RTP concrete: a 96% game
    // is not "you lose 4%", it is "most sessions end down and a few end well up".
    fractionAhead: nets.filter(n => n > 0).length / nets.length,
  };

  // Magnitude only. Every call site already supplies the direction in words ("ends down", "end
  // up"), so a sign here reads as "down -65" - which is either a double negative or a typo,
  // depending on how carefully the reader is looking.
  const money = (multiple) => Math.abs(multiple * bet).toFixed(bet >= 1 ? 0 : 2);
  const lines = [];

  lines.push(`Something pays on ${(hitRate * 100).toFixed(0)}% of spins${
    medianWin > 0
      ? `, and a typical winning spin returns about ${medianWin.toFixed(2)}x the bet.`
      : ' - but more than half of all spins pay nothing at all.'}`);

  lines.push(`One spin in ten pays ${p90.toFixed(1)}x or better; one in a hundred pays ${p99.toFixed(1)}x; `
    + `one in a thousand pays ${p999.toFixed(0)}x. The biggest win in ${rounds.toLocaleString()} spins was ${maxWin.toFixed(0)}x.`);

  lines.push(`The luckiest 1% of spins carry ${(top1PctShare * 100).toFixed(0)}% of everything this game pays out.`
    + (top1PctShare > 0.5
      ? ' Most of the money is in rare wins, so ordinary play will feel thin between them.'
      : top1PctShare < 0.15
      ? ' The payout is spread thin and evenly - steady, but nothing to chase.'
      : ''));

  // The rule-of-thumb comparison, explicitly flagged. See the module doc.
  lines.push(`Volatility ${band.label.toUpperCase()} (${volatilityIndex.toFixed(1)}x) - ${band.hint}. `
    + `As a rough guide rather than anything measured here, commercial slots typically run 3-6x for a mid-volatility game `
    + `and above 6x for a high one.`);

  if (triggerRate != null) {
    const spins = pctToSpinsPerTrigger(triggerRate);
    lines.push(spins == null
      ? 'Free spins never trigger in this configuration.'
      : `Free spins land about 1 in ${Math.round(spins)} spins - roughly ${
        (sessionSpins / spins) < 1
          ? `once every ${Math.round(spins / sessionSpins)} sessions of ${sessionSpins}`
          : `${(sessionSpins / spins).toFixed(1)} times in a ${sessionSpins}-spin session`}.`);
  }

  lines.push(`Over ${sessionSpins} spins the middle player ends ${sessionOutcomes.median >= 0 ? 'up' : 'down'} `
    + `${money(sessionOutcomes.median)}; the unlucky tenth end down ${money(sessionOutcomes.p10)} and the lucky tenth `
    + `end up ${money(sessionOutcomes.p90)}. ${(sessionOutcomes.fractionAhead * 100).toFixed(0)}% of sessions finish ahead`
    + (rtp != null ? ` - which is what a ${rtp.toFixed(1)}% RTP means once you stop averaging.` : '.'));

  return { lines, volatilityClass, sessionOutcomes };
}
