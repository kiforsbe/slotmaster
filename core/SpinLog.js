import { downloadTextFile } from './FileIO.js';

// Shared per-spin log entry construction, used by both core/SpinSimulator.js (a batch of
// synchronous simulated spins) and core/SlotEngine.js (real, animated interactive play). The two
// build entries at different times relative to an expanding win resolving - a simulated spin
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
// here too rather than in a DOM-facing panel module - core/SpinLogPanel.js only renders it.

// A CSV field is quoted (with internal quotes doubled) only when it actually needs it - comma,
// quote, or newline - so the common case (plain numbers and symbol names) stays readable
// unquoted, matching how Excel/Sheets round-trip CSVs written this way.
function csvField(value) {
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const round2 = (n) => Math.round(n * 100) / 100;

// Formats one spin-log entry's line/scatter/expanding wins into a single compact, regex-friendly
// cell instead of separate variable-width columns per win (a spin can have anywhere from zero to
// several line wins, so a fixed column layout would either truncate or need a ragged header).
// Each win is `TYPE:symbol:count:amount[:flags]`, wins joined by `|`, with no other delimiters
// (no spaces, no parens) so a parser never needs more than split-on-delimiter or one regex pass:
//   TYPE   - 'S' (scatter), 'X' (expanding), or 'L<lineIndex>' (a line win, e.g. 'L4')
//   count  - scatter/line hit count, or expanding's reel count
//   amount - this win's payout, rounded to 2dp (avoids float noise like 2.8000000000000003)
//   flags  - line wins only: 'W' (wild-completed), 'A' (alone bonus), 'WA' (both), omitted if
//            neither applies
// e.g. "S:book:3:2|L4:ace:3:5:W|X:tut:2:30" - parse per-win with
// /(S|X|L\d+):([^:|]+):(\d+):(-?[\d.]+)(?::([WA]+))?/g
export function summarizeSpinWins(entry) {
  const parts = [];
  if (entry.scatterCount > 0) parts.push(`S:${entry.scatterSymbol}:${entry.scatterCount}:${round2(entry.scatterWin)}`);
  entry.lineWins.forEach(lw => {
    const flags = (lw.wildUsed ? 'W' : '') + (lw.alone ? 'A' : '');
    parts.push(`L${lw.lineIndex}:${lw.symbol}:${lw.count}:${round2(lw.payout)}${flags ? `:${flags}` : ''}`);
  });
  if (entry.expandingReels > 0) parts.push(`X:${entry.expandingSymbol}:${entry.expandingReels}:${round2(entry.expandingWin)}`);
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
