// Runs exactly one simulateSpins() trial per message, on its own OS thread. Spawned in a pool
// by core/simulation/SimulationWorkerPool.js so tuneFrequencies() can measure several candidates' trials
// concurrently across every available CPU core instead of one at a time on a single thread -
// see SpinSimulator.js's `options.runTrial` doc for how this plugs into the search itself.
//
// Only ever receives ONE trial's worth of work per message (a single `simulateSpins` call) and
// returns just the three numbers `measure()` actually needs (rtpRaw/freeSpinsTriggered/
// baseSpins) - the full result (winDistribution/detailedWins/spinLog) is discarded by measure()
// anyway, so shipping it back across postMessage would only add overhead for nothing.
//
// config.mechanic/config.winEvaluator/config.freeSpinsMode (SpinSimulator.js's pluggable
// components) are functions/objects-with-function-hooks, so they can't cross postMessage
// directly - the caller sends their *names* instead (mechanicName/winEvaluatorName/
// freeSpinsModeName, resolved back to the real thing via core/simulation/workerMechanicRegistry.js).
import { simulateSpins } from './SpinSimulator.js';
import { createSeededRng } from '../math/SlotMath.js';
import { resolveWinEvaluator, resolveMechanic, resolveFreeSpinsMode } from './workerMechanicRegistry.js';

self.onmessage = (event) => {
  const { taskId, config, numSpins, betPerLine, linesCount, rngSeed } = event.data;
  try {
    const { winEvaluatorName, mechanicName, freeSpinsModeName, minClusterSize, scatterTriggerCount, ...simConfig } = config;
    const winEvaluator = resolveWinEvaluator(
      winEvaluatorName,
      simConfig.paytable,
      simConfig.scatterSymbol,
      minClusterSize,
      scatterTriggerCount,
      simConfig.paylines,
      simConfig.wildSymbol
    );
    const mechanic = resolveMechanic(mechanicName);
    const freeSpinsMode = resolveFreeSpinsMode(freeSpinsModeName);
    const rng = rngSeed != null ? createSeededRng(rngSeed) : Math.random;
    const results = simulateSpins({ ...simConfig, winEvaluator, mechanic, freeSpinsMode }, numSpins, betPerLine, linesCount, rng);
    self.postMessage({
      taskId,
      // roundStats joins the three numbers measure() has always needed. It is a handful of scalars
      // plus at most 61 histogram buckets, so it crosses postMessage for far less than the full
      // result would (winDistribution/detailedWins/spinLog stay discarded here, as before).
      result: {
        rtpRaw: results.rtpRaw,
        freeSpinsTriggered: results.freeSpinsTriggered,
        baseSpins: results.baseSpins,
        roundStats: results.roundStats,
      },
    });
  } catch (error) {
    self.postMessage({ taskId, error: error.message });
  }
};
