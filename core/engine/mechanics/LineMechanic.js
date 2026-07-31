// Line-pay gameplay mechanic: the pluggable component pair - "get the symbols for the
// playfield" (getTargetGrid) and "calculate wins" (evaluateWin/evaluateExpandingWin) - shared
// by core/SlotEngine.js (live, animated play) and core/SpinSimulator.js (batch simulation/
// tuning) alike, via config.mechanic. This is the default mechanic, so every existing
// line-pay game keeps working unchanged without ever passing it explicitly. See
// core/CascadeSpinMechanic.js for the cluster-pays sibling.
import { generateTargetGrid, checkExpandingWins, checkWins, createSeededRng } from '../../math/SlotMath.js';
import { createSpinLogEntry, applyExpandingWinToSpinLogEntry } from '../../logging/SpinLog.js';

export const LineMechanic = {
  name: 'line',

  // "Get the symbols for the playfield": one fresh grid, read forward off each reel's strip
  // from a random start position. Called once per spin by both SlotEngine.spin() (which then
  // animates reels catching up to it) and SpinSimulator's resolveSpin below (no animation,
  // used immediately).
  getTargetGrid(reelStrips, rowsCount, rng) {
    return generateTargetGrid(reelStrips, rowsCount, rng);
  },

  // "Calculate wins": config.winEvaluator (defaults to checkWins) evaluated against a grid.
  // `config` is either a live engine's own `this.config` or the simulator's `simConfig` - both
  // carry paytable/paylines/wildSymbol/scatterSymbol under the same names.
  evaluateWin(grid, config, linesCount) {
    const winEvaluator = config.winEvaluator || checkWins;
    return winEvaluator(grid, config.paytable, config.paylines, linesCount, config.wildSymbol ?? null, config.scatterSymbol ?? null);
  },

  // The Book-of-Dead-style expanding-wild bonus check (free spins only, opt-in per game -
  // see hasExpandingWild's own doc on SpinSimulator's simulateSpins).
  evaluateExpandingWin(grid, expandingSymbol, config, linesCount) {
    return checkExpandingWins(grid, expandingSymbol, config.paytable, config.paylines, linesCount);
  },

  // Live-play entry point (core/engine/CoreSlotEngine.js) - the normalized step-sequence
  // counterpart to resolveSpin's batch-simulation entry point below. Always a single-step
  // sequence: a line-pay spin has no cascade steps. Derives its own rng from `seed` internally so
  // the caller never needs to know whether a mechanic wants a seed or an rng function.
  // `forcedGrid` (non-empty array) skips getTargetGrid entirely and evaluates that grid instead -
  // CoreSlotEngine.forceWinResult()'s debug/cheat path.
  //
  // step.payout is an already-monetized dollar amount, not a bare multiplier - a line-pay spin
  // has two different bet bases (line wins scale by betPerLine, scatter wins scale by the full
  // totalBet, per resolveSpin's own batch-simulation math below), so only this mechanic can
  // correctly convert its own multiplier(s) into money. CoreSlotEngine just sums step.payout
  // across every step, mechanic-agnostic.
  resolveLiveSpin({ reelStrips, rowsCount, seed, config, linesCount, forcedGrid }) {
    const rng = createSeededRng(seed);
    const grid = (forcedGrid && forcedGrid.length > 0) ? forcedGrid : this.getTargetGrid(reelStrips, rowsCount, rng);
    const winData = this.evaluateWin(grid, config, linesCount);
    const totalBet = config.betPerLine * linesCount;
    const payout = (winData.totalLinePayoutMultiplier || 0) * config.betPerLine
      + (winData.scatterWin ? winData.scatterWin.payout * totalBet : 0);
    return {
      steps: [{ grid, lineWins: winData.lineWins || [], scatterWin: winData.scatterWin || null, payout }],
      scatterWin: winData.scatterWin || null,
    };
  },

  // Picks this free-spins round's expanding symbol once, at the round's start - never
  // re-randomized by a retrigger extending the same round (mirrors CascadeSpinMechanic's free-
  // spins state, which is likewise created once per round, not once per spin).
  createFreeSpinsState(simConfig, rng) {
    if (!simConfig.hasExpandingWild) return null;
    const eligibleSymbols = Object.keys(simConfig.paytable || {})
      .filter(s => simConfig.paytable[s].type !== 'scatter');
    return {
      expandingSymbol: eligibleSymbols.length > 0
        ? eligibleSymbols[Math.floor(rng() * eligibleSymbols.length)]
        : null,
    };
  },

  // Batch-simulation entry point (core/SpinSimulator.js) - composed entirely from the same
  // getTargetGrid/evaluateWin/evaluateExpandingWin components above, just called synchronously
  // with no animation in between.
  resolveSpin({ simConfig, betPerLine, linesCount, rng, isFreeSpin, freeSpinsState, spinIndex, chargedBet, logSpins }) {
    const targetGrid = this.getTargetGrid(simConfig.reelStrips, simConfig.rowsCount, rng);
    const winData = this.evaluateWin(targetGrid, simConfig, linesCount);

    let spinWin = 0;
    const detailedWins = [];

    if (winData.scatterWin) {
      const scatterWinAmount = winData.scatterWin.payout * simConfig.totalBet;
      spinWin += scatterWinAmount;
      detailedWins.push({
        type: 'scatter', symbol: simConfig.scatterSymbol, count: winData.scatterWin.count,
        isFreeSpin: false, winAmount: scatterWinAmount,
      });
    }

    spinWin += (winData.totalLinePayoutMultiplier || 0) * betPerLine;
    (winData.lineWins || []).forEach(lw => {
      detailedWins.push({
        type: lw.alone ? 'alone' : 'line', symbol: lw.symbol, count: lw.count,
        wildUsed: !!lw.wildUsed, isFreeSpin, winAmount: lw.payout * betPerLine,
      });
    });

    let expandingResults = null;
    if (isFreeSpin && simConfig.hasExpandingWild && freeSpinsState?.expandingSymbol) {
      expandingResults = this.evaluateExpandingWin(targetGrid, freeSpinsState.expandingSymbol, simConfig, linesCount);
    }
    if (expandingResults) {
      const expandingWinAmount = expandingResults.totalPayoutMultiplier * betPerLine;
      spinWin += expandingWinAmount;
      detailedWins.push({
        type: 'expanding', symbol: freeSpinsState.expandingSymbol, count: expandingResults.expandingReels.length,
        isFreeSpin: true, winAmount: expandingWinAmount,
      });
    }

    let logEntry = null;
    if (logSpins) {
      logEntry = createSpinLogEntry({
        spinIndex, phase: isFreeSpin ? 'free' : 'base', betPerLine: simConfig.betPerLine, linesCount,
        chargedBet, scatterBetBase: simConfig.totalBet, winData, scatterSymbol: simConfig.scatterSymbol,
      });
      if (expandingResults) {
        applyExpandingWinToSpinLogEntry(logEntry, {
          expandingSymbol: freeSpinsState.expandingSymbol,
          expandingReels: expandingResults.expandingReels.length,
          expandingWin: expandingResults.totalPayoutMultiplier * betPerLine,
        });
      }
    }

    return { spinWin, scatterWin: winData.scatterWin, detailedWins, logEntry };
  },

  // Ranks value symbols by their highest-tier line payout (last element of the fixed-length
  // payout array - N-of-a-kind payouts are ascending by convention).
  defaultPayoutOf(paytable, symbol) {
    const arr = paytable[symbol] && paytable[symbol].payout;
    return arr && arr.length ? arr[arr.length - 1] : 0;
  },

  statsLabels: { primaryHeader: 'Normal Wins', hitLabel: 'Hits' },
};
