// No-refill straight-line cascade mechanic used by Lemon Pop. It shares the ordinary cascade
// step shape so rendering, logs, simulations, and engine bookkeeping stay mechanic-agnostic.
import { resolveNoRefillCascadeSequence } from '../../core/math/CascadeMath.js';
import { applyPopFeature, applyPopRushVariant, POP_FEATURES, POP_RUSH_VARIANTS } from './LemonPopFeatures.js';
import { createCascadeSpinLogEntry } from '../../core/logging/SpinLog.js';

export const LEMON_POP_MECHANIC_NAME = 'lemonPopCascade';

const popProgressSnapshot = (totalLines, linesPerPop, popsToRush) => ({
  totalLines,
  linesPerPop,
  popsToRush,
  completedPops: Math.min(popsToRush, Math.floor(totalLines / linesPerPop)),
  linesInCurrentPop: Math.min(linesPerPop, totalLines % linesPerPop),
});

function resolveSequence({ reelStrips, rowsCount, seed, config, winEvaluator, special = false, startingPopProgress = null }) {
  let popRushVariant = null;
  const linesPerPop = Math.max(1, config.linesPerPop ?? 5);
  const popsToRush = Math.max(1, config.popsToRush ?? 3);
  let totalLines = startingPopProgress?.totalLines ?? 0;
  const initialPopProgress = popProgressSnapshot(totalLines, linesPerPop, popsToRush);
  const sequence = resolveNoRefillCascadeSequence(reelStrips, rowsCount, seed, winEvaluator, {
    maxCascadeSteps: config.maxCascadeSteps ?? 25,
    initialStepData: { popProgress: initialPopProgress, popFeatures: [] },
    initialTransform: special ? ({ grid, wildMultipliers, rng }) => {
      popRushVariant = POP_RUSH_VARIANTS[Math.floor(rng() * POP_RUSH_VARIANTS.length)];
      return applyPopRushVariant({
        grid, wildMultipliers, paytable: config.paytable, wildSymbol: config.wildSymbol,
        variant: popRushVariant, rng,
      });
    } : null,
    afterWin: special ? null : ({ grid, wildMultipliers, result, rng }) => {
      const previouslyCompleted = Math.floor(totalLines / linesPerPop);
      totalLines += result.clusterWins.length;
      const nowCompleted = Math.min(popsToRush, Math.floor(totalLines / linesPerPop));
      let current = { grid, wildMultipliers };
      const popFeatures = [];
      for (let popIndex = previouslyCompleted; popIndex < nowCompleted; popIndex++) {
        const feature = POP_FEATURES[Math.floor(rng() * POP_FEATURES.length)];
        const applied = applyPopFeature({
          ...current,
          paytable: config.paytable,
          wildSymbol: config.wildSymbol,
          feature,
          rng,
        });
        current = { grid: applied.grid, wildMultipliers: applied.wildMultipliers };
        popFeatures.push({
          popIndex: popIndex + 1,
          feature: applied.feature,
          affectedPositions: applied.affectedPositions,
          transformedSymbol: applied.transformedSymbol,
          removedSymbols: applied.removedSymbols,
        });
      }
      return {
        ...current,
        stepData: {
          popProgress: popProgressSnapshot(totalLines, linesPerPop, popsToRush),
          popFeatures,
        },
      };
    },
  });
  sequence.cascadeSteps.forEach(step => {
    step.presentationPhase = special ? 'pop-rush' : 'base';
    step.popRushVariant = popRushVariant;
  });
  return { ...sequence, popRushVariant, popProgress: popProgressSnapshot(totalLines, linesPerPop, popsToRush) };
}

function resolveWholeSpin({ reelStrips, rowsCount, seed, config, winEvaluator }) {
  const base = resolveSequence({ reelStrips, rowsCount, seed, config, winEvaluator });
  if (base.popProgress.completedPops < base.popProgress.popsToRush) return { ...base, triggeredPopRush: false };

  // A separate derived seed keeps the base sequence deterministic and makes feature selection
  // reproducible without consuming a second, shared random stream.
  const specialSeed = (seed ^ 0x9e3779b9) >>> 0;
  const special = resolveSequence({
    reelStrips, rowsCount, seed: specialSeed, config, winEvaluator, special: true,
    startingPopProgress: base.popProgress,
  });
  return {
    cascadeSteps: [...base.cascadeSteps, ...special.cascadeSteps],
    totalPayoutMultiplier: base.totalPayoutMultiplier + special.totalPayoutMultiplier,
    finalGrid: special.finalGrid,
    wildMultipliers: special.wildMultipliers,
    scatterWin: null,
    triggeredPopRush: true,
    popRushVariant: special.popRushVariant,
    popProgress: base.popProgress,
  };
}

export const LemonPopSpinMechanic = {
  // Separate name lets simulation workers select this mechanic instead of generic refill cascades.
  name: LEMON_POP_MECHANIC_NAME,
  isCascade: true,

  resolveLiveSpin({ reelStrips, rowsCount, seed, config, winEvaluator }) {
    const sequence = resolveWholeSpin({ reelStrips, rowsCount, seed, config, winEvaluator });
    const betAmount = config.betAmount ?? 1;
    return {
      steps: sequence.cascadeSteps.map(step => ({ ...step, payout: step.payout * betAmount })),
      scatterWin: null,
      triggeredPopRush: sequence.triggeredPopRush,
      popRushVariant: sequence.popRushVariant,
      popProgress: sequence.popProgress,
    };
  },

  resolveSpin({ simConfig, rng, spinIndex, chargedBet, logSpins }) {
    const seed = Math.floor(rng() * 0xFFFFFFFF);
    const sequence = resolveWholeSpin({
      reelStrips: simConfig.reelStrips,
      rowsCount: simConfig.rowsCount,
      seed,
      config: simConfig,
      winEvaluator: simConfig.winEvaluator,
    });
    const spinWin = sequence.totalPayoutMultiplier * simConfig.totalBet;
    const detailedWins = sequence.cascadeSteps.flatMap((step, cascadeStep) => step.clusterWins.map(win => ({
      type: 'straight-line', symbol: win.symbol, count: win.count, winAmount: win.payout * simConfig.totalBet,
      cascadeStep, orientation: win.orientation, mixed: win.mixed, multiplier: win.multiplier,
      popRushVariant: step.popRushVariant || null,
    })));
    const logEntry = logSpins ? createCascadeSpinLogEntry({
      spinIndex, phase: 'base', betAmount: simConfig.totalBet, chargedBet,
      cascadeSteps: sequence.cascadeSteps, scatterSymbol: null, scatterWin: null, seed, timestamp: null,
    }) : null;
    return { spinWin, scatterWin: null, detailedWins, logEntry };
  },

  defaultPayoutOf(paytable, symbol) {
    const payouts = paytable[symbol]?.linePayout;
    return Array.isArray(payouts) ? payouts.at(-1) ?? 0 : 0;
  },

  statsLabels: { primaryHeader: 'Straight-line Wins', hitLabel: 'Line Length' },
};