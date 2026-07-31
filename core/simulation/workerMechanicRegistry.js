// Resolves the name-based "recipes" a config crosses a postMessage boundary with (mechanic/
// winEvaluator/freeSpinsMode - see core/simulation/SpinSimulator.js's own doc on why these can't cross
// postMessage directly, being objects with function hooks or plain functions/closures) back
// into the real objects/functions simulateSpins() needs. Shared by every Worker that runs a
// simulateSpins() trial on its own thread (see core/simulation/trialWorker.js, spun up in a pool
// by core/simulation/SimulationWorkerPool.js) so this table has exactly one home instead of being
// duplicated per Worker script.
import { checkWins, checkWildLineWins } from '../math/SlotMath.js';
import { checkClusterWins } from '../math/ClusterMath.js';
import { LineMechanic } from '../engine/mechanics/LineMechanic.js';
import { CascadeSpinMechanic } from '../engine/mechanics/CascadeSpinMechanic.js';
import { createFlatMultiplierMode, createMultiplierTilesMode } from '../engine/FreeSpinsModes.js';

const WIN_EVALUATORS = { checkWins, checkWildLineWins };

// A cascade game's winEvaluator is a single-argument closure baking in its own paytable/
// minClusterSize/scatterSymbol (see CascadeMath.js's own doc) rather than a reusable bare
// function like checkWins/checkWildLineWins - it can't be named/looked-up the same way. Its
// "recipe" (evaluator name + the extra primitives it closes over) crosses postMessage instead,
// and this rebuilds an equivalent closure here.
const CLUSTER_WIN_EVALUATOR_BUILDERS = {
  checkClusterWins: (paytable, scatterSymbol, minClusterSize, scatterTriggerCount) =>
    (grid) => checkClusterWins(grid, paytable, minClusterSize, scatterSymbol, scatterTriggerCount),
  checkLineCascadeWins: (paytable, scatterSymbol, minClusterSize, scatterTriggerCount, paylines, wildSymbol) =>
    (grid) => {
      const results = checkWins(grid, paytable, paylines, paylines.length, wildSymbol, scatterSymbol, scatterTriggerCount);
      const clusterWins = [];
      results.lineWins.forEach(lw => {
        clusterWins.push({
          symbol: lw.symbol,
          count: lw.count,
          payout: lw.payout / paylines.length,
          winningPositions: lw.winningPositions,
          // Unused by the simulator, which only ever sums payouts - carried so this rebuild stays
          // field-for-field identical to the game's own evaluator rather than a payout-equivalent
          // approximation of it.
          lineIndex: lw.lineIndex
        });
      });
      if (results.scatterWin) {
        clusterWins.push({
          symbol: results.scatterWin.symbol,
          count: results.scatterWin.count,
          payout: results.scatterWin.payout,
          winningPositions: results.scatterWin.winningPositions
        });
      }
      return {
        clusterWins,
        totalPayoutMultiplier: (results.totalLinePayoutMultiplier / paylines.length) + (results.scatterWin ? results.scatterWin.payout : 0),
        scatterWin: results.scatterWin
      };
    }
};

const MECHANICS = { line: LineMechanic, cascade: CascadeSpinMechanic };

// Visual-only options (badgeStyle/renderOrder) never affect wrapWinEvaluator/onClusterCleared -
// see FreeSpinsModes.js's own doc - so reconstructing with defaults here is exact, not lossy.
const FREE_SPINS_MODE_BUILDERS = { flatMultiplier: () => createFlatMultiplierMode(), multiplierTiles: () => createMultiplierTilesMode() };

// What each builder cannot be reconstructed without. A missing one is a config that forgot to
// carry something across postMessage, and the failure it produces without this check is a
// TypeError thrown deep inside a Worker on the first trial ("Cannot read properties of undefined
// (reading 'length')"), surfacing with a stack that points at the pool's own settle function and
// names neither the game, the evaluator, nor the field. Mayan Tumble shipped without `paylines`
// in its tuneConfig and that is all the tuner would say.
const REQUIRED_BY_BUILDER = {
  checkLineCascadeWins: ['paylines'],
};

export function resolveWinEvaluator(winEvaluatorName, paytable, scatterSymbol, minClusterSize, scatterTriggerCount, paylines, wildSymbol) {
  if (!winEvaluatorName) return undefined;
  if (CLUSTER_WIN_EVALUATOR_BUILDERS[winEvaluatorName]) {
    const available = { paytable, scatterSymbol, minClusterSize, scatterTriggerCount, paylines, wildSymbol };
    const missing = (REQUIRED_BY_BUILDER[winEvaluatorName] ?? []).filter(k => available[k] == null);
    if (missing.length > 0) {
      throw new Error(
        `winEvaluator '${winEvaluatorName}' cannot be rebuilt without ${missing.join(', ')}. `
        + `Add ${missing.map(k => `\`${k}\``).join(' and ')} to the config this trial was dispatched with `
        + `(a game's tuneConfig, or the simulation config) - a win evaluator is rebuilt from names and `
        + `primitives on the worker side, so anything it closes over has to travel with it.`);
    }
    return CLUSTER_WIN_EVALUATOR_BUILDERS[winEvaluatorName](paytable, scatterSymbol, minClusterSize, scatterTriggerCount, paylines, wildSymbol);
  }
  return WIN_EVALUATORS[winEvaluatorName];
}

export function resolveMechanic(mechanicName) {
  return mechanicName ? MECHANICS[mechanicName] : undefined;
}

export function resolveFreeSpinsMode(freeSpinsModeName) {
  return freeSpinsModeName ? FREE_SPINS_MODE_BUILDERS[freeSpinsModeName]?.() : undefined;
}
