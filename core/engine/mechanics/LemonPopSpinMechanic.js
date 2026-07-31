// No-refill straight-line cascade mechanic used by Lemon Pop. It shares the ordinary cascade
// step shape so rendering, logs, simulations, and engine bookkeeping stay mechanic-agnostic.
import { resolveNoRefillCascadeSequence } from '../../math/CascadeMath.js';
import { applyPopRushVariant, POP_RUSH_VARIANTS } from '../../math/LemonPopFeatures.js';
import { createCascadeSpinLogEntry } from '../../logging/SpinLog.js';

function resolveSequence({ reelStrips, rowsCount, seed, config, winEvaluator, special = false }) {
  let popRushVariant = null;
  const sequence = resolveNoRefillCascadeSequence(reelStrips, rowsCount, seed, winEvaluator, {
    maxCascadeSteps: config.maxCascadeSteps ?? 25,
    initialTransform: special ? ({ grid, wildMultipliers, rng }) => {
      popRushVariant = POP_RUSH_VARIANTS[Math.floor(rng() * POP_RUSH_VARIANTS.length)];
      return applyPopRushVariant({
        grid, wildMultipliers, paytable: config.paytable, wildSymbol: config.wildSymbol,
        variant: popRushVariant, rng,
      });
    } : null,
  });
  sequence.cascadeSteps.forEach(step => {
    step.presentationPhase = special ? 'pop-rush' : 'base';
    step.popRushVariant = popRushVariant;
  });
  return { ...sequence, popRushVariant };
}

function resolveWholeSpin({ reelStrips, rowsCount, seed, config, winEvaluator }) {
  const base = resolveSequence({ reelStrips, rowsCount, seed, config, winEvaluator });
  const winningCascades = base.cascadeSteps.filter(step => step.clusterWins.length > 0).length;
  if (winningCascades < (config.popRushCascadeCount ?? 4)) return { ...base, triggeredPopRush: false };

  // A separate derived seed keeps the base sequence deterministic and makes feature selection
  // reproducible without consuming a second, shared random stream.
  const specialSeed = (seed ^ 0x9e3779b9) >>> 0;
  const special = resolveSequence({ reelStrips, rowsCount, seed: specialSeed, config, winEvaluator, special: true });
  return {
    cascadeSteps: [...base.cascadeSteps, ...special.cascadeSteps],
    totalPayoutMultiplier: base.totalPayoutMultiplier + special.totalPayoutMultiplier,
    finalGrid: special.finalGrid,
    wildMultipliers: special.wildMultipliers,
    scatterWin: null,
    triggeredPopRush: true,
    popRushVariant: special.popRushVariant,
  };
}

export const LemonPopSpinMechanic = {
  // Separate name lets simulation workers select this mechanic instead of generic refill cascades.
  name: 'lemonPopCascade',
  isCascade: true,

  resolveLiveSpin({ reelStrips, rowsCount, seed, config, winEvaluator }) {
    const sequence = resolveWholeSpin({ reelStrips, rowsCount, seed, config, winEvaluator });
    const betAmount = config.betAmount ?? 1;
    return {
      steps: sequence.cascadeSteps.map(step => ({ ...step, payout: step.payout * betAmount })),
      scatterWin: null,
      triggeredPopRush: sequence.triggeredPopRush,
      popRushVariant: sequence.popRushVariant,
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
