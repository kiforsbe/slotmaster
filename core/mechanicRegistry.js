// Resolves the name-based "recipes" a config crosses a postMessage boundary with (mechanic/
// winEvaluator/freeSpinsMode - see core/SpinSimulator.js's own doc on why these can't cross
// postMessage directly, being objects with function hooks or plain functions/closures) back
// into the real objects/functions simulateSpins() needs. Shared by every Worker that runs a
// simulateSpins() trial on its own thread (see core/simulationTrialWorker.js, spun up in a pool
// by core/SimulationWorkerPool.js) so this table has exactly one home instead of being
// duplicated per Worker script.
import { checkWins, checkWildLineWins } from './SlotMath.js';
import { checkClusterWins } from './ClusterMath.js';
import { LineMechanic } from './LineMechanic.js';
import { CascadeSpinMechanic } from './CascadeSpinMechanic.js';
import { createFlatMultiplierMode, createMultiplierTilesMode } from './FreeSpinsModes.js';

const WIN_EVALUATORS = { checkWins, checkWildLineWins };

// A cascade game's winEvaluator is a single-argument closure baking in its own paytable/
// minClusterSize/scatterSymbol (see CascadeMath.js's own doc) rather than a reusable bare
// function like checkWins/checkWildLineWins - it can't be named/looked-up the same way. Its
// "recipe" (evaluator name + the extra primitives it closes over) crosses postMessage instead,
// and this rebuilds an equivalent closure here.
const CLUSTER_WIN_EVALUATOR_BUILDERS = {
  checkClusterWins: (paytable, scatterSymbol, minClusterSize, scatterTriggerCount) =>
    (grid) => checkClusterWins(grid, paytable, minClusterSize, scatterSymbol, scatterTriggerCount),
};

const MECHANICS = { line: LineMechanic, cascade: CascadeSpinMechanic };

// Visual-only options (badgeStyle/renderOrder) never affect wrapWinEvaluator/onClusterCleared -
// see FreeSpinsModes.js's own doc - so reconstructing with defaults here is exact, not lossy.
const FREE_SPINS_MODE_BUILDERS = { flatMultiplier: () => createFlatMultiplierMode(), multiplierTiles: () => createMultiplierTilesMode() };

export function resolveWinEvaluator(winEvaluatorName, paytable, scatterSymbol, minClusterSize, scatterTriggerCount) {
  if (!winEvaluatorName) return undefined;
  if (CLUSTER_WIN_EVALUATOR_BUILDERS[winEvaluatorName]) {
    return CLUSTER_WIN_EVALUATOR_BUILDERS[winEvaluatorName](paytable, scatterSymbol, minClusterSize, scatterTriggerCount);
  }
  return WIN_EVALUATORS[winEvaluatorName];
}

export function resolveMechanic(mechanicName) {
  return mechanicName ? MECHANICS[mechanicName] : undefined;
}

export function resolveFreeSpinsMode(freeSpinsModeName) {
  return freeSpinsModeName ? FREE_SPINS_MODE_BUILDERS[freeSpinsModeName]?.() : undefined;
}
