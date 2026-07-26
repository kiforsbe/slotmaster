// Cascading cluster-pays gameplay mechanic: the pluggable component pair - "get the symbols
// for the playfield" (resolveSequence, which for a cascade interleaves grid refills with win
// checks by nature) and the free-spins-mode wrapping that makes those wins "calculate"
// correctly during a bonus round - shared by core/CascadeEngine.js (live, animated play) and
// core/SpinSimulator.js (batch simulation/tuning) alike, via config.mechanic. Never imports
// core/ClusterMath.js directly - config.winEvaluator is a closure the caller supplies (see
// CascadeMath.js's own doc), so a future line-win-based cascade game reuses this same mechanic
// unmodified, just with its own evaluator/payoutOf. See core/LineMechanic.js for the line-pay
// sibling (the default mechanic).
import { resolveCascadeSequence } from './CascadeMath.js';
import { createCascadeSpinLogEntry } from './SpinLog.js';
import { createFlatMultiplierMode } from './FreeSpinsModes.js';

export const CascadeSpinMechanic = {
  name: 'cascade',

  // "Get the symbols for the playfield": resolves one entire spin's cascade sequence (initial
  // fill, then every cascade step until one produces no win) against `winEvaluator`. A cascade
  // mechanic can't cleanly separate "get symbols" from "calculate wins" the way a line-pay one
  // can - each cascade step's refill depends on which cells the PREVIOUS step's win check
  // cleared - so this one call is both components at once, by nature. Called directly by
  // CascadeEngine.spin() (which then animates playback of the result) and by resolveSpin below
  // (no animation, used immediately).
  resolveSequence(reelStrips, rowsCount, seed, winEvaluator, maxCascadeSteps) {
    return resolveCascadeSequence(reelStrips, rowsCount, seed, winEvaluator, maxCascadeSteps);
  },

  // Wraps a base winEvaluator with the active free-spins mode's bonus (core/FreeSpinsModes.js),
  // exactly as CascadeEngine._buildWinEvaluatorForSpin does for live play - so every cascade
  // step's payout already reflects the bonus by the time resolveSequence finishes.
  wrapWinEvaluatorForFreeSpins(baseEvaluator, freeSpinsState) {
    return freeSpinsState.freeSpinsMode.wrapWinEvaluator(baseEvaluator, freeSpinsState.modeState, freeSpinsState.fakeEngine);
  },

  // Built once per free-spins round (mirrors CascadeEngine.enterFreeSpins), never recreated by
  // a mid-round retrigger - a mode's persistent state (e.g. multiplier tiles) must survive a
  // retrigger exactly like it does in the live engine. `fakeEngine` is the minimal stand-in
  // FreeSpinsModes.js hooks actually read (only `.config.reelsCount`/`.rowsCount` - see its own
  // doc); never rendered, never touched otherwise. A live CascadeEngine passes itself instead
  // of this stand-in (see wireLiveFreeSpinsState below).
  createFreeSpinsState(simConfig) {
    const freeSpinsMode = simConfig.freeSpinsMode || createFlatMultiplierMode();
    const fakeEngine = { config: { reelsCount: simConfig.reelsCount, rowsCount: simConfig.rowsCount } };
    return { freeSpinsMode, fakeEngine, modeState: freeSpinsMode.createState(fakeEngine) };
  },

  // Batch-simulation entry point (core/SpinSimulator.js) - composed entirely from
  // resolveSequence/wrapWinEvaluatorForFreeSpins above, just called synchronously with no
  // animation in between.
  resolveSpin({ simConfig, isFreeSpin, freeSpinsState, rng, spinIndex, chargedBet, logSpins }) {
    // resolveCascadeSequence takes a single numeric seed (not an rng function) - drawn from the
    // outer rng stream so the whole run stays reproducible under a seeded rng, exactly like
    // CascadeEngine.spin()'s own seed derivation.
    const spinSeed = Math.floor(rng() * 0xFFFFFFFF);
    const evaluator = isFreeSpin
      ? this.wrapWinEvaluatorForFreeSpins(simConfig.winEvaluator, freeSpinsState)
      : simConfig.winEvaluator;

    const sequence = this.resolveSequence(simConfig.reelStrips, simConfig.rowsCount, spinSeed, evaluator);

    // Replays every cascade step's cluster wins through onClusterCleared, in order - the same
    // mutation wrapWinEvaluator's own scratch copy already applied internally (to compute this
    // spin's payouts) now lands on the REAL persistent state, so it carries correctly into the
    // next spin of this same free-spins round. This is exactly what CascadeEngine's animated
    // playback does per cluster, one clear at a time - just without the animation frames.
    if (isFreeSpin) {
      sequence.cascadeSteps.forEach(step => {
        step.clusterWins.forEach(cluster => {
          freeSpinsState.freeSpinsMode.onClusterCleared(cluster, freeSpinsState.modeState, freeSpinsState.fakeEngine);
        });
      });
    }

    // totalPayoutMultiplier already reflects the active free-spins mode's bonus (baked in by
    // wrapWinEvaluatorForFreeSpins above) - nothing further to apply, same as
    // CascadeEngine._finishSpin.
    const spinWin = sequence.totalPayoutMultiplier * simConfig.totalBet;

    const detailedWins = [];
    sequence.cascadeSteps.forEach((step, stepIndex) => {
      step.clusterWins.forEach(w => {
        detailedWins.push({
          type: 'cluster', symbol: w.symbol, count: w.count, isFreeSpin,
          winAmount: w.payout * simConfig.totalBet, cascadeStep: stepIndex,
        });
      });
    });
    if (sequence.scatterWin && sequence.scatterWin.count > 0) {
      detailedWins.push({
        type: 'scatter', symbol: sequence.scatterWin.symbol, count: sequence.scatterWin.count,
        isFreeSpin: false, winAmount: sequence.scatterWin.payout * simConfig.totalBet,
      });
    }

    const logEntry = logSpins ? createCascadeSpinLogEntry({
      spinIndex, phase: isFreeSpin ? 'free' : 'base', betAmount: simConfig.totalBet, chargedBet,
      cascadeSteps: sequence.cascadeSteps,
      scatterSymbol: (sequence.scatterWin ? sequence.scatterWin.symbol : simConfig.scatterSymbol) ?? null,
      scatterWin: sequence.scatterWin, seed: spinSeed, timestamp: null,
    }) : null;

    return { spinWin, scatterWin: sequence.scatterWin, detailedWins, logEntry };
  },

  // Ranks value symbols by their highest cluster-payout tier (tiers are ascending by min, per
  // ClusterMath.js's own convention - the last entry is the biggest cluster's multiplier).
  defaultPayoutOf(paytable, symbol) {
    const tiers = paytable[symbol] && paytable[symbol].clusterPayout;
    return tiers && tiers.length ? tiers[tiers.length - 1].multiplier : 0;
  },

  statsLabels: { primaryHeader: 'Cluster Wins', hitLabel: 'Cluster Size' },
};
