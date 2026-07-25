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
import { tuneFrequencies } from './SpinSimulator.js';
import { checkWins, checkWildLineWins } from './SlotMath.js';

const WIN_EVALUATORS = { checkWins, checkWildLineWins };

self.onmessage = async (event) => {
  const { paytable, reelFrequencyTables, options } = event.data;
  const { winEvaluatorName, ...restOptions } = options;
  try {
    const result = await tuneFrequencies(paytable, reelFrequencyTables, {
      ...restOptions,
      winEvaluator: winEvaluatorName ? WIN_EVALUATORS[winEvaluatorName] : undefined,
      onProgress: (phase, i, mult, r, best) => {
        self.postMessage({ type: 'progress', phase, i, mult, result: r, best });
      },
    });
    self.postMessage({ type: 'done', result });
  } catch (error) {
    self.postMessage({ type: 'error', message: error.message });
  }
};
