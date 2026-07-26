// Runs tuneFrequencies() off the main thread. Every Nelder-Mead/gradient-descent iteration
// measures a candidate via a Monte Carlo simulateSpins() run (often hundreds of thousands of
// spins), which used to happen synchronously on the page's own thread with only a
// `setTimeout(0)` yield between iterations - each iteration froze the UI for its own duration,
// and being single-threaded, this work could never show up as more than one CPU core's worth
// of usage no matter how busy it was. Moving the whole call here fixes both: the main thread
// now just relays postMessage'd progress events (cheap), and the actual computation gets a
// dedicated OS thread that isn't subject to a hidden/background tab's timer throttling either.
//
// paytable/reelFrequencyTables/options must all be structured-cloneable (postMessage, not a
// function call) - a game's own winEvaluator (e.g. fruitmachine's checkWildLineWins) is a
// function, so it can't cross postMessage directly. SimulationPanel.js sends its *name*
// instead (options.winEvaluatorName) and this worker resolves it back to the real function
// via WIN_EVALUATORS below - any winEvaluator not in this table falls through to
// tuneFrequencies' own default (checkWins).
//
// A cascade game's winEvaluator is a single-argument closure baking in its own paytable/
// minClusterSize/scatterSymbol (see CascadeMath.js's own doc) rather than a reusable bare
// function like checkWins/checkWildLineWins - it can't be named/looked-up the same way. Its
// "recipe" (evaluator name + the extra primitives it closes over) crosses postMessage instead
// (options.minClusterSize/scatterTriggerCount, alongside the already-cloneable scatterSymbol/
// paytable), and CLUSTER_WIN_EVALUATOR_BUILDERS rebuilds an equivalent closure here.
//
// config.mechanic/config.freeSpinsMode (SpinSimulator.js's pluggable gameplay components) are
// likewise objects with function hooks, not cloneable - resolved here by name the same way.
import { tuneFrequencies } from './SpinSimulator.js';
import { checkWins, checkWildLineWins } from './SlotMath.js';
import { checkClusterWins } from './ClusterMath.js';
import { LineMechanic } from './LineMechanic.js';
import { CascadeSpinMechanic } from './CascadeSpinMechanic.js';
import { createFlatMultiplierMode, createMultiplierTilesMode } from './FreeSpinsModes.js';

const WIN_EVALUATORS = { checkWins, checkWildLineWins };
const CLUSTER_WIN_EVALUATOR_BUILDERS = {
  checkClusterWins: (paytable, { scatterSymbol, minClusterSize, scatterTriggerCount }) =>
    (grid) => checkClusterWins(grid, paytable, minClusterSize, scatterSymbol, scatterTriggerCount),
};
const MECHANICS = { line: LineMechanic, cascade: CascadeSpinMechanic };
// Visual-only options (badgeStyle/renderOrder) never affect wrapWinEvaluator/onClusterCleared -
// see FreeSpinsModes.js's own doc - so reconstructing with defaults here is exact, not lossy.
const FREE_SPINS_MODE_BUILDERS = { flatMultiplier: () => createFlatMultiplierMode(), multiplierTiles: () => createMultiplierTilesMode() };

self.onmessage = async (event) => {
  const { paytable, reelFrequencyTables, options } = event.data;
  const { winEvaluatorName, mechanicName, freeSpinsModeName, minClusterSize, scatterTriggerCount, ...restOptions } = options;

  let winEvaluator;
  if (winEvaluatorName && CLUSTER_WIN_EVALUATOR_BUILDERS[winEvaluatorName]) {
    winEvaluator = CLUSTER_WIN_EVALUATOR_BUILDERS[winEvaluatorName](paytable, { scatterSymbol: restOptions.scatterSymbol, minClusterSize, scatterTriggerCount });
  } else if (winEvaluatorName) {
    winEvaluator = WIN_EVALUATORS[winEvaluatorName];
  }

  try {
    const result = await tuneFrequencies(paytable, reelFrequencyTables, {
      ...restOptions,
      winEvaluator,
      mechanic: mechanicName ? MECHANICS[mechanicName] : undefined,
      freeSpinsMode: freeSpinsModeName ? FREE_SPINS_MODE_BUILDERS[freeSpinsModeName]() : undefined,
      onProgress: (phase, i, mult, r, best) => {
        self.postMessage({ type: 'progress', phase, i, mult, result: r, best });
      },
    });
    self.postMessage({ type: 'done', result });
  } catch (error) {
    self.postMessage({ type: 'error', message: error.message });
  }
};
