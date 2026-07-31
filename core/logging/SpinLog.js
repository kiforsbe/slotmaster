import { downloadTextFile } from '../io/FileIO.js';

// Shared per-spin log entry construction, used by both core/simulation/SpinSimulator.js (a batch of
// synchronous simulated spins) and core/engine/SpinLogRecorder.js (real, animated interactive
// play, called from CoreSlotEngine). The two build entries at different times relative to an
// expanding win resolving - a simulated spin
// already knows its expanding win by the time it logs anything, while live play only finds out
// once the expansion animation finishes playing out - but the entry SHAPE, and how a line/scatter
// win turns into a currency amount, is identical either way. Keeping that one definition here
// means the two callers can't drift apart on field names or on the payout math itself.

/**
 * Builds one spin-log entry from a win evaluator's result (the same `{ lineWins, scatterWin,
 * totalLinePayoutMultiplier }` shape checkWins/checkWildLineWins both return). Expanding-win
 * fields start zeroed/null - call applyExpandingWinToSpinLogEntry once that's known, whether
 * that's immediately (a batch simulation already has it) or later (live play, after its
 * animation completes).
 * @param {Object} args
 * @param {number} args.spinIndex - 1-based position in the log.
 * @param {'base'|'free'} args.phase
 * @param {number} args.betPerLine
 * @param {number} args.linesCount
 * @param {number} args.chargedBet - What this specific spin actually cost (0 during free spins).
 * @param {number} args.scatterBetBase - betPerLine*linesCount, used to scale a scatter payout -
 *   always the full bet regardless of chargedBet, matching how scatter pays are scaled
 *   everywhere else in this engine (free spins still pay scatter hits at the real bet size).
 * @param {Object} args.winData - A win evaluator's result.
 * @param {string|null} [args.scatterSymbol] - This game's configured scatter symbol name.
 * @param {number|null} [args.seed=null] - This spin's own seed, when one exists (live play always
 *   has one; a batch simulation shares one continuous rng stream across the whole run instead,
 *   so it's left null there - see SpinSimulator.js's own doc on config.logSpins).
 * @param {number|null} [args.timestamp=null] - Wall-clock ms when this spin resolved, when
 *   meaningful (live play only - a synchronous batch loop has no per-spin wall-clock signal).
 * @returns {Object} The spin-log entry.
 */
export function createSpinLogEntry({
  spinIndex, phase, betPerLine, linesCount, chargedBet, scatterBetBase,
  winData, scatterSymbol = null, seed = null, timestamp = null
}) {
  const scatterWinAmount = winData.scatterWin ? winData.scatterWin.payout * scatterBetBase : 0;
  const linePayoutAmount = (winData.totalLinePayoutMultiplier || 0) * betPerLine;

  return {
    spinIndex,
    timestamp,
    seed,
    phase,
    betPerLine,
    linesCount,
    totalBet: chargedBet,
    totalWin: scatterWinAmount + linePayoutAmount,
    scatterSymbol: winData.scatterWin ? scatterSymbol : null,
    scatterCount: winData.scatterWin ? winData.scatterWin.count : 0,
    scatterWin: scatterWinAmount,
    lineWins: (winData.lineWins || []).map(lw => ({
      lineIndex: lw.lineIndex,
      symbol: lw.symbol,
      count: lw.count,
      wildUsed: !!lw.wildUsed,
      alone: !!lw.alone,
      payout: lw.payout * betPerLine
    })),
    expandingSymbol: null,
    expandingReels: 0,
    expandingWin: 0
  };
}

/**
 * Builds one spin-log entry for a cascading cluster-pays spin (Candy Frenzy) - same
 * top-level shape as createSpinLogEntry (spinIndex/timestamp/seed/phase/totalBet/totalWin/
 * scatter fields) so ui/dev/SpinLogPanel.js's existing table/CSV export work unchanged, plus a
 * clusterWins breakdown across every cascade step instead of lineWins.
 * @param {Object} args
 * @param {number} args.spinIndex
 * @param {'base'|'free'} args.phase
 * @param {number} args.betAmount - this game's single flat bet (no bet-per-line/lines concept).
 * @param {number} args.chargedBet - what this spin actually cost (0 during free spins).
 * @param {number} [args.freeSpinsMultiplier=1] - left at the default unless a caller has NOT
 *   already baked its free-spins mode's bonus into cascadeSteps[i].clusterWins[j].payout
 *   itself (CascadeEngine's own free-spins modes - see core/FreeSpinsModes.js - always do,
 *   so it never passes anything other than the default here).
 * @param {Array<{clusterWins: Array<{symbol,count,payout}>}>} args.cascadeSteps - from
 *   resolveCascadeSequence's own result shape (core/CascadeMath.js); a step's `payout` field
 *   there is a currency-scaled sum and isn't re-derived here, only its per-cluster multiplier
 *   entries are.
 * @param {string|null} [args.scatterSymbol=null]
 * @param {{count:number}|null} [args.scatterWin=null] - bonus has no direct cash payout in v1.
 * @param {number|null} [args.seed=null]
 * @param {number|null} [args.timestamp=null]
 */
export function createCascadeSpinLogEntry({
  spinIndex, phase, betAmount, chargedBet, freeSpinsMultiplier = 1,
  cascadeSteps, scatterSymbol = null, scatterWin = null, seed = null, timestamp = null
}) {
  const clusterWins = [];
  cascadeSteps.forEach((step, stepIndex) => {
    step.clusterWins.forEach(cw => {
      clusterWins.push({
        cascadeStep: stepIndex,
        symbol: cw.symbol,
        count: cw.count,
        payout: cw.payout * betAmount * freeSpinsMultiplier,
      });
    });
  });
  const cascadeWinTotal = clusterWins.reduce((sum, cw) => sum + cw.payout, 0);
  const scatterCount = scatterWin ? scatterWin.count : 0;

  return {
    spinIndex,
    timestamp,
    seed,
    phase,
    betPerLine: betAmount,
    linesCount: 1,
    totalBet: chargedBet,
    totalWin: cascadeWinTotal,
    scatterSymbol: scatterCount > 0 ? scatterSymbol : null,
    scatterCount,
    scatterWin: 0,
    lineWins: [],
    clusterWins,
    cascadeStepCount: cascadeSteps.length,
    expandingSymbol: null,
    expandingReels: 0,
    expandingWin: 0,
  };
}

/** Mutates `entry` in place once its expanding win (if any) is known, folding it into totalWin. */
export function applyExpandingWinToSpinLogEntry(entry, { expandingSymbol, expandingReels, expandingWin }) {
  entry.expandingSymbol = expandingSymbol;
  entry.expandingReels = expandingReels;
  entry.expandingWin = expandingWin;
  entry.totalWin += expandingWin;
  return entry;
}

// --- CSV serialization ---
// A spin-log entry (see createSpinLogEntry above) is plain data, so turning it into CSV lives
// here too rather than in a DOM-facing panel module - ui/dev/SpinLogPanel.js only renders it.

// A CSV field is quoted (with internal quotes doubled) only when it actually needs it - comma,
// quote, or newline - so the common case (plain numbers and symbol names) stays readable
// unquoted, matching how Excel/Sheets round-trip CSVs written this way.
function csvField(value) {
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const round2 = (n) => Math.round(n * 100) / 100;

// Formats one spin-log entry's line/scatter/expanding/cluster wins into a single compact,
// regex-friendly cell instead of separate variable-width columns per win (a spin can have
// anywhere from zero to several line wins, so a fixed column layout would either truncate or
// need a ragged header). Each win is `TYPE:symbol:count:amount[:flags]`, wins joined by `|`,
// with no other delimiters (no spaces, no parens) so a parser never needs more than
// split-on-delimiter or one regex pass:
//   TYPE   - 'S' (scatter), 'X' (expanding), 'L<lineIndex>' (a line win, e.g. 'L4'), or
//            'K<cascadeStep>' (a cluster win from a cascading spin, e.g. 'K1')
//   count  - scatter/line/cluster hit count, or expanding's reel count
//   amount - this win's payout, rounded to 2dp (avoids float noise like 2.8000000000000003)
//   flags  - line wins only: 'W' (wild-completed), 'A' (alone bonus), 'WA' (both), omitted if
//            neither applies
// e.g. "S:book:3:2|L4:ace:3:5:W|X:tut:2:30|K1:mint:7:0.8" - parse per-win with
// /(S|X|L\d+|K\d+):([^:|]+):(\d+):(-?[\d.]+)(?::([WA]+))?/g
export function summarizeSpinWins(entry) {
  const parts = [];
  if (entry.scatterCount > 0) parts.push(`S:${entry.scatterSymbol}:${entry.scatterCount}:${round2(entry.scatterWin)}`);
  entry.lineWins.forEach(lw => {
    const flags = (lw.wildUsed ? 'W' : '') + (lw.alone ? 'A' : '');
    parts.push(`L${lw.lineIndex}:${lw.symbol}:${lw.count}:${round2(lw.payout)}${flags ? `:${flags}` : ''}`);
  });
  if (entry.expandingReels > 0) parts.push(`X:${entry.expandingSymbol}:${entry.expandingReels}:${round2(entry.expandingWin)}`);
  (entry.clusterWins || []).forEach(cw => {
    parts.push(`K${cw.cascadeStep}:${cw.symbol}:${cw.count}:${round2(cw.payout)}`);
  });
  return parts.join('|');
}

// Builds the per-spin CSV export. One function serves both spin-log sources:
//  - engine.spinLog (live, interactive play): every entry already carries its own seed/timestamp
//    (each real spin genuinely draws a fresh one - see SlotEngine._pushSpinLogEntry), used as-is.
//  - simulateSpins()'s results.spinLog (a batch run): entries have neither, since one continuous
//    rng stream drives the whole synchronous run rather than a seed per spin, and a tight loop
//    has no per-spin wall-clock signal worth recording - `seed`/`startedAt` fill in there instead,
//    constant across every row, documenting the run's provenance rather than one spin's.
function spinLogToCsv(spinLog, { seed = null, startedAt = null } = {}) {
  const header = ['Spin #', 'Timestamp', 'Seed', 'Phase', 'Bet/Line', 'Lines', 'Total Bet', 'Total Win', 'Wins'];
  const rows = spinLog.map(entry => [
    entry.spinIndex,
    entry.timestamp != null ? new Date(entry.timestamp).toISOString() : (startedAt ?? ''),
    entry.seed ?? seed ?? 'unseeded',
    entry.phase,
    entry.betPerLine,
    entry.linesCount,
    entry.totalBet,
    entry.totalWin,
    summarizeSpinWins(entry)
  ]);
  return [header, ...rows].map(row => row.map(csvField).join(',')).join('\r\n');
}

/**
 * Builds and downloads a spin log as CSV - the one entry point both the batch RUN SIMULATION
 * export button and the live spin log viewer's export button call.
 * @param {Object[]} spinLog - see createSpinLogEntry above.
 * @param {Object} [meta]
 * @param {number|null} [meta.seed] - Run-level seed fallback (batch runs only - see spinLogToCsv).
 * @param {string|null} [meta.startedAt] - Run-level timestamp fallback (batch runs only).
 * @param {string} [meta.filenamePrefix='spinlog']
 */
export function exportSpinLogCsv(spinLog, { seed = null, startedAt = null, filenamePrefix = 'spinlog' } = {}) {
  const csv = spinLogToCsv(spinLog, { seed, startedAt });
  const namePart = (startedAt ?? new Date().toISOString()).replace(/[:.]/g, '-');
  const seedPart = seed != null ? `_seed${seed}` : '';
  downloadTextFile(`${filenamePrefix}_${namePart}${seedPart}.csv`, csv);
}
