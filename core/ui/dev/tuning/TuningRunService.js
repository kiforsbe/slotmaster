import { tuneFrequencies } from '../../../tuning/FrequencyTuner.js';
import { createSimulationWorkerPool } from '../../../simulation/SimulationWorkerPool.js';
export async function runTuneFrequenciesWithPool(paytable, reelFrequencyTables, options, onProgress) {
  // winEvaluatorName/minClusterSize/scatterTriggerCount are pool-dispatch metadata only -
  // tuneFrequencies itself never reads them (a cascade game's real winEvaluator, still a real
  // closure, is passed straight through in `tuneOptions` below for the (unused when runTrial is
  // set) in-process fallback path).
  const { winEvaluatorName: explicitWinEvaluatorName, minClusterSize, scatterTriggerCount, ...tuneOptions } = options;
  const usePool = !tuneOptions.mechanic || tuneOptions.mechanic.name === 'line' || tuneOptions.mechanic.name === 'cascade';
  if (!usePool) {
    return tuneFrequencies(paytable, reelFrequencyTables, {
      ...tuneOptions,
      minClusterSize, scatterTriggerCount,
      onProgress,
    });
  }

  const pool = createSimulationWorkerPool();
  try {
    return await tuneFrequencies(paytable, reelFrequencyTables, {
      ...tuneOptions,
      // Passed through as well as being used for pool dispatch below. These stopped being purely
      // dispatch metadata once Phase 0a validation started reading them: without them the
      // cluster-size-reachable and payout-ladder-floor checks silently never fire from the panel,
      // which is exactly the kind of "the feature is there but reaches nothing" gap this package
      // exists to close.
      minClusterSize, scatterTriggerCount,
      onProgress,
      runTrial: (config, numSpins, betPerLine, linesCount, rngSeed) => {
        const { mechanic, winEvaluator, freeSpinsMode, ...restConfig } = config;
        const cloneableConfig = {
          ...restConfig,
          mechanicName: mechanic ? mechanic.name : null,
          // A cascade game's winEvaluator is a per-game closure baking in its own paytable/
          // minClusterSize/scatterSymbol (see CascadeMath.js's own doc), so `.name` (just the
          // closure's own variable name, e.g. 'winEvaluator') can't identify it - the explicit
          // override from tuneConfig (e.g. 'checkClusterWins') wins over any derived name.
          winEvaluatorName: explicitWinEvaluatorName ?? (winEvaluator ? winEvaluator.name : null),
          freeSpinsModeName: freeSpinsMode ? freeSpinsMode.name : null,
          minClusterSize,
          scatterTriggerCount,
        };
        return pool.runTrial(cloneableConfig, numSpins, betPerLine, linesCount, rngSeed);
      },
    });
  } finally {
    pool.terminate();
  }
}

/**
 * Formats an array of per-reel frequency tables back out as paste-ready
 * `export const FREQUENCY_REELn = { ... }` literals, column-aligned - matching the exact
 * style already used in games/fruitmachine/game.js.
 */
// A fixed decimal-place count (the previous `.toFixed(1)`) is fine for frequencies in the
// tens (fruitmachine's bar: 25.3) but is catastrophically lossy for frequencies under 1
// (bookbookbook's book: 0.051 and explorer: 0.079 both rounded to "0.1" - two symbols with
// nearly 2x different rarity reading back as identical). Significant figures scale with
// magnitude instead, so both ranges keep enough precision to survive a copy/paste
// round-trip without silently corrupting the tuned result.
