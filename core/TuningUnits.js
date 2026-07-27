/**
 * Conversions between the units a developer thinks in and the units `tuneFrequencies` takes.
 *
 * The tuning panel used to present every setting in the library's own units: a trigger rate as
 * "0.6", a volatility as a raw standard deviation, a shaping preference as "0.5". Those are the
 * right units for the search and the wrong ones for the person configuring it - nobody reasons
 * about a bonus in percent-of-spins, and "uniformity penalty weight 5" carries no meaning at all
 * until you know what scale the underlying penalty is measured on.
 *
 * Everything here is a pure function with no DOM and no imports, so the panel can present the
 * friendly unit while `readTuneOptions` converts back at the boundary - the library API is
 * untouched. Each conversion round-trips exactly (see tests/tuningunits.test.mjs): a lossy one
 * would silently tune toward a different target than the one typed in, which is precisely the
 * failure mode the old `.toFixed(1)` frequency output had.
 */

// ---- Free-spin trigger rate: percent of spins <-> one in N spins ----

/**
 * @param {number|null} spinsPerTrigger - e.g. 167 for "one bonus every 167 spins".
 * @returns {number} the equivalent percentage of spins, e.g. 0.5988. Zero for a null/non-positive
 *   input, which is what "this game has no trigger symbol" looks like.
 */
export function spinsPerTriggerToPct(spinsPerTrigger) {
  if (!(spinsPerTrigger > 0)) return 0;
  return 100 / spinsPerTrigger;
}

/**
 * @param {number} pct - percentage of spins that trigger free spins, e.g. 0.6.
 * @returns {number|null} the equivalent "one in N spins", e.g. 166.67 - or `null` when there is no
 *   such form. Deliberately not Infinity: a 0% rate is a real, common state (a game with no
 *   trigger symbol at all, or one measured before Phase 1 runs), and rendering it as
 *   "1 in Infinity spins" produces an input box that cannot be typed back into.
 */
export function pctToSpinsPerTrigger(pct) {
  if (!(pct > 0)) return null;
  return 100 / pct;
}

// ---- Volatility: a named band <-> a standard deviation of round return, per unit bet ----

/**
 * Bands are RULES OF THUMB, not measurements. They come from where commercial slots of each
 * described feel tend to sit, and they exist so a developer can ask for "low volatility" without
 * first having to know what sigma a low-volatility game has. Treat the boundaries as approximate
 * and label them as such wherever they are shown.
 *
 * For reference, Candy Frenzy measured sigma = 1.9x bet at 849bc8a - comfortably 'low', and
 * arguably lower than a cluster-cascade game wants to be.
 */
export const VOLATILITY_BANDS = {
  low:    { min: 0, max: 3,        label: 'Low',    hint: 'frequent small wins, shallow swings' },
  medium: { min: 3, max: 6,        label: 'Medium', hint: 'a mix - most sessions stay in range' },
  high:   { min: 6, max: Infinity, label: 'High',   hint: 'long dry spells paid for by rare big wins' },
};

/** @returns {{min: number, max: number, label: string, hint: string}} - `max` is Infinity for the top band. */
export function volatilityBandToSigma(band) {
  return VOLATILITY_BANDS[band] ?? VOLATILITY_BANDS.medium;
}

/**
 * Classifies a measured sigma into a band. Boundaries belong to the band ABOVE them (sigma 3.0 is
 * 'medium', not 'low') so that every band's own midpoint classifies back to itself - without that,
 * selecting a band and then seeing the result labelled as its neighbour would read as a bug.
 */
export function sigmaToVolatilityBand(sigma) {
  if (!(sigma > 0)) return 'low';
  for (const [name, { min, max }] of Object.entries(VOLATILITY_BANDS)) {
    if (sigma >= min && sigma < max) return name;
  }
  return 'high';
}

// ---- Shaping preferences: a named intent <-> a normalized penalty weight ----

/**
 * Named strengths for the soft shaping penalties (ordering, uniformity, spacing, trigger rate,
 * std error). The numbers are only meaningful against NORMALIZED penalties - see
 * `penaltyNormalization` in core/SpinSimulator.js - where a weight of 1 means "this is worth one
 * percentage point of RTP to me". Against the raw penalties they are arbitrary, because the raw
 * terms are on incommensurable scales: on Candy Frenzy at 849bc8a the ordering penalty reads 5.45
 * (raw frequency units) while the spacing penalty reads 301 (a violation count), so the same
 * weight applied to each means two completely different things.
 */
export const INTENT_LEVELS = {
  off:     { weight: 0,  label: 'Off',     hint: 'ignore this entirely' },
  prefer:  { weight: 1,  label: 'Prefer',  hint: 'worth about 1pp of RTP' },
  insist:  { weight: 4,  label: 'Insist',  hint: 'worth about 4pp of RTP' },
  require: { weight: 12, label: 'Require', hint: 'give up a lot of RTP for this' },
};

/** @returns {number|null} the normalized weight for a named level, or null for an unknown name. */
export function intentToWeight(level) {
  return INTENT_LEVELS[level]?.weight ?? null;
}

/**
 * @returns {string} the level name for a weight, or `'custom'` when it matches none of them.
 *   Deliberately exact rather than nearest-match: snapping a hand-typed 2.5 to 'prefer' would make
 *   the dropdown report something the search is not doing, which is the exact failure these named
 *   levels exist to fix. The advanced numeric override stays authoritative.
 */
export function weightToIntent(weight) {
  for (const [name, { weight: w }] of Object.entries(INTENT_LEVELS)) {
    if (w === weight) return name;
  }
  return 'custom';
}
