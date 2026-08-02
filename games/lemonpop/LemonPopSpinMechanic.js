// No-refill straight-line cascade mechanic used by Lemon Pop. It shares the ordinary cascade
// step shape so rendering, logs, simulations, and engine bookkeeping stay mechanic-agnostic.
import { resolveNoRefillCascadeSequence } from '../../core/math/CascadeMath.js';
import { createSeededRng } from '../../core/math/SlotMath.js';
import { applyPopFeature, applyPopRushVariant, POP_FEATURES, POP_RUSH_VARIANTS } from './LemonPopFeatures.js';
import { createCascadeSpinLogEntry } from '../../core/logging/SpinLog.js';

export const LEMON_POP_MECHANIC_NAME = 'lemonPopCascade';
const FULL_CLEAR_BONUS_MULTIPLIER = 25;

const popProgressSnapshot = (totalLines, bankedChargeLines, linesPerPop, popsToRush) => ({
  totalLines,
  bankedChargeLines,
  linesPerPop,
  popsToRush,
  availablePops: Math.min(popsToRush, Math.floor(bankedChargeLines / linesPerPop)),
  completedPops: Math.min(popsToRush, Math.floor(bankedChargeLines / linesPerPop)),
  linesInCurrentPop: Math.min(linesPerPop, bankedChargeLines % linesPerPop),
});

function isBoardClear(grid) {
  return grid.every(column => column.every(symbol => symbol == null));
}

function countSymbol(grid, symbol) {
  return grid.reduce((count, column) => count + column.filter(cell => cell === symbol).length, 0);
}

function awardFullClearBonus(sequence, bonusMultiplier = FULL_CLEAR_BONUS_MULTIPLIER) {
  if (!isBoardClear(sequence.finalGrid)) return sequence;
  const lastStep = sequence.cascadeSteps.at(-1);
  if (!lastStep) return sequence;
  lastStep.payout = (lastStep.payout || 0) + bonusMultiplier;
  if (lastStep.popSettleDebug) {
    lastStep.popSettleDebug.fullClearBonusMultiplier = bonusMultiplier;
  } else if (lastStep.popDebug) {
    lastStep.popDebug.fullClearBonusMultiplier = bonusMultiplier;
  } else {
    lastStep.popDebug = { action: 'full-clear-bonus-awarded', fullClearBonusMultiplier: bonusMultiplier };
  }
  sequence.totalPayoutMultiplier += bonusMultiplier;
  return sequence;
}

function cloneGrid(grid) {
  return grid.map(column => column.slice());
}

function cloneWildMultipliers(grid, wildMultipliers) {
  return wildMultipliers?.map(column => column.slice())
    || grid.map(column => new Array(column.length).fill(1));
}

function zeroOffsetsLike(grid) {
  return grid.map(column => new Array(column.length).fill(0));
}

function sparseWildSplashGrid() {
  const grid = Array.from({ length: 5 }, () => new Array(5).fill(null));
  grid[0][4] = 'lemonice';
  grid[1][3] = 'gumdrop';
  grid[2][4] = 'heart';
  grid[3][2] = 'pinkfizz';
  grid[4][4] = 'lemoncandy';
  return grid;
}

function resolveSequence({
  reelStrips,
  rowsCount,
  seed,
  config,
  winEvaluator,
  special = false,
  totalLines = 0,
  bankedChargeLines = 0,
  startingGrid = null,
  startingWildMultipliers = null,
  startingFallOffsets = null,
  popFeature = null,
  popDebug = null,
  forcedPopRushVariant = null,
}) {
  let popRushVariant = null;
  const linesPerPop = Math.max(1, config.linesPerPop ?? 5);
  const popsToRush = Math.max(1, config.popsToRush ?? 3);
  let runningTotalLines = totalLines;
  let runningBankedChargeLines = bankedChargeLines;
  const maxChargeLines = linesPerPop * popsToRush;
  const initialPopProgress = popProgressSnapshot(runningTotalLines, runningBankedChargeLines, linesPerPop, popsToRush);
  const rushVariants = config.popRushVariants ?? POP_RUSH_VARIANTS;
  const popRushApplier = config.applyPopRushVariant ?? applyPopRushVariant;
  const sequence = resolveNoRefillCascadeSequence(reelStrips, rowsCount, seed, winEvaluator, {
    maxCascadeSteps: config.maxCascadeSteps ?? 25,
    initialGrid: startingGrid,
    initialWildMultipliers: startingWildMultipliers,
    initialFallOffsets: startingFallOffsets,
    initialStepData: { popProgress: initialPopProgress, popFeatures: popFeature ? [popFeature] : [], popDebug },
    initialTransform: special ? ({ grid, wildMultipliers, rng }) => {
      popRushVariant = forcedPopRushVariant || rushVariants[Math.floor(rng() * rushVariants.length)];
      return popRushApplier({
        grid, wildMultipliers, paytable: config.paytable, wildSymbol: config.wildSymbol,
        variant: popRushVariant, rng,
      });
    } : null,
  });
  sequence.cascadeSteps.forEach(step => {
    step.popFeatures = Array.isArray(step.popFeatures) ? step.popFeatures : [];
    step.popProgress = popProgressSnapshot(runningTotalLines, runningBankedChargeLines, linesPerPop, popsToRush);
    step.presentationPhase = special ? 'pop-rush' : 'base';
    step.popRushVariant = popRushVariant;
    if (step.clusterWins.length) {
      runningTotalLines += step.clusterWins.length;
      runningBankedChargeLines = Math.min(maxChargeLines, runningBankedChargeLines + step.clusterWins.length);
    }
  });
  return {
    ...sequence,
    popRushVariant,
    totalLines: runningTotalLines,
    bankedChargeLines: runningBankedChargeLines,
    popProgress: popProgressSnapshot(runningTotalLines, runningBankedChargeLines, linesPerPop, popsToRush),
  };
}

function resolveCheatMiniFeature({ reelStrips, rowsCount, seed, config, winEvaluator, feature, sparseGrid = false }) {
  const linesPerPop = Math.max(1, config.linesPerPop ?? 5);
  const popsToRush = Math.max(1, config.popsToRush ?? 3);
  const base = sparseGrid ? null : resolveSequence({ reelStrips, rowsCount, seed, config, winEvaluator, totalLines: 0, bankedChargeLines: 0 });
  const settledStep = sparseGrid
    ? {
      grid: sparseWildSplashGrid(),
      wildMultipliers: Array.from({ length: 5 }, () => new Array(5).fill(1)),
      fallOffsets: Array.from({ length: 5 }, () => new Array(5).fill(0)),
    }
    : ([...base.cascadeSteps].reverse().find(step => !isBoardClear(step.grid)) || base.cascadeSteps[0]);
  const startGrid = cloneGrid(settledStep.grid);
  const startWildMultipliers = cloneWildMultipliers(startGrid, settledStep.wildMultipliers);
  const applied = (config.applyPopFeature ?? applyPopFeature)({
    grid: startGrid,
    wildMultipliers: startWildMultipliers,
    paytable: config.paytable,
    wildSymbol: config.wildSymbol,
    feature,
    rng: createSeededRng((seed ^ 0xa511e9b3) >>> 0),
    forcedAffectedPositions: sparseGrid && feature === 'wild-splash' ? [[1, 0]] : undefined,
  });

  const cheatStep = {
    grid: cloneGrid(settledStep.grid),
    wildMultipliers: cloneWildMultipliers(settledStep.grid, settledStep.wildMultipliers),
    fallOffsets: zeroOffsetsLike(settledStep.grid),
    clusterWins: [],
    payout: 0,
    popFeatures: [],
    popDebug: {
      action: 'mini-pop-cheat-armed',
      feature,
      availablePops: 1,
      boardClear: false,
      sparseGrid,
    },
    popProgress: popProgressSnapshot(0, linesPerPop, linesPerPop, popsToRush),
    presentationPhase: 'base',
    popRushVariant: null,
  };

  const followUp = resolveSequence({
    reelStrips,
    rowsCount,
    seed: (seed ^ 0x45d9f3b) >>> 0,
    config,
    winEvaluator,
    totalLines: 0,
    bankedChargeLines: 0,
    startingGrid: applied.grid,
    startingWildMultipliers: applied.wildMultipliers,
    startingFallOffsets: applied.fallOffsets,
    popFeature: {
      popIndex: 1,
      feature: applied.feature,
      affectedPositions: applied.affectedPositions,
      transformedSymbol: applied.transformedSymbol,
      removedSymbols: applied.removedSymbols,
      spawnSymbol: config.wildSymbol,
    },
    popDebug: {
      action: 'mini-pop-cheat-triggered',
      triggerNumber: 1,
      feature: applied.feature,
      sparseGrid,
      totalLines: 0,
      bankedChargeLinesBeforeSpend: linesPerPop,
      bankedChargeLinesAfterSpend: 0,
      availablePopsBeforeSpend: 1,
      availablePopsAfterSpend: 0,
      affectedPositions: applied.affectedPositions,
    },
  });

  return {
    cascadeSteps: [cheatStep, ...followUp.cascadeSteps],
    totalPayoutMultiplier: followUp.totalPayoutMultiplier,
    finalGrid: followUp.finalGrid,
    wildMultipliers: followUp.wildMultipliers,
    scatterWin: null,
    triggeredPopRush: false,
    popRushVariant: null,
    popProgress: followUp.popProgress,
  };
}

function resolveCheatPopRush({ reelStrips, rowsCount, seed, config, winEvaluator, variant }) {
  const linesPerPop = Math.max(1, config.linesPerPop ?? 5);
  const popsToRush = Math.max(1, config.popsToRush ?? 3);
  const chargedLines = linesPerPop * popsToRush;
  const special = awardFullClearBonus(resolveSequence({
    reelStrips,
    rowsCount,
    seed: (seed ^ 0x9e3779b9) >>> 0,
    config,
    winEvaluator,
    special: true,
    totalLines: chargedLines,
    bankedChargeLines: chargedLines,
    forcedPopRushVariant: variant,
  }));
  return {
    cascadeSteps: special.cascadeSteps,
    totalPayoutMultiplier: special.totalPayoutMultiplier,
    finalGrid: special.finalGrid,
    wildMultipliers: special.wildMultipliers,
    scatterWin: null,
    triggeredPopRush: true,
    popRushVariant: special.popRushVariant,
    popProgress: popProgressSnapshot(chargedLines, chargedLines, linesPerPop, popsToRush),
  };
}

function resolveWholeSpin({ reelStrips, rowsCount, seed, config, winEvaluator }) {
  const linesPerPop = Math.max(1, config.linesPerPop ?? 5);
  const popsToRush = Math.max(1, config.popsToRush ?? 3);
  const popFeaturePool = config.popFeatures ?? POP_FEATURES;
  const popFeatureApplier = config.applyPopFeature ?? applyPopFeature;
  const featureRng = createSeededRng((seed ^ 0xa511e9b3) >>> 0);
  const cascadeSteps = [];

  let totalPayoutMultiplier = 0;
  let totalLines = 0;
  let bankedChargeLines = 0;
  let currentGrid = null;
  let currentWildMultipliers = null;
  let triggeredMiniPops = 0;

  const availablePops = () => Math.min(popsToRush, Math.floor(bankedChargeLines / linesPerPop));
  const canTriggerPopRush = () => countSymbol(currentGrid, config.wildSymbol) <= 1;

  const annotateLastSettledStep = (action, extra = {}) => {
    const lastStep = cascadeSteps.at(-1);
    if (!lastStep) return;
    const debugPayload = {
      action,
      totalLines,
      bankedChargeLines,
      availablePops: availablePops(),
      boardClear: isBoardClear(currentGrid),
      wildsRemaining: countSymbol(currentGrid, config.wildSymbol),
      ...extra,
    };
    if ((lastStep.popFeatures?.length ?? 0) > 0) {
      lastStep.popSettleDebug = debugPayload;
      return;
    }
    lastStep.popDebug = debugPayload;
  };

  const appendSequence = sequence => {
    cascadeSteps.push(...sequence.cascadeSteps);
    totalPayoutMultiplier += sequence.totalPayoutMultiplier;
    totalLines = sequence.totalLines;
    bankedChargeLines = sequence.bankedChargeLines;
    currentGrid = sequence.finalGrid;
    currentWildMultipliers = sequence.wildMultipliers;
  };

  appendSequence(resolveSequence({ reelStrips, rowsCount, seed, config, winEvaluator, totalLines, bankedChargeLines }));

  while (!isBoardClear(currentGrid)) {
    annotateLastSettledStep('settled-before-mini-pop-check');
    if (canTriggerPopRush()) break;
    if (availablePops() <= 0) break;
    const feature = popFeaturePool[Math.floor(featureRng() * popFeaturePool.length)];
    const bankedChargeLinesBeforeSpend = bankedChargeLines;
    const availablePopsBeforeSpend = availablePops();
    bankedChargeLines = Math.max(0, bankedChargeLines - linesPerPop);
    const applied = popFeatureApplier({
      grid: currentGrid,
      wildMultipliers: currentWildMultipliers,
      paytable: config.paytable,
      wildSymbol: config.wildSymbol,
      feature,
      rng: featureRng,
    });
    triggeredMiniPops += 1;
    appendSequence(resolveSequence({
      reelStrips,
      rowsCount,
      seed: (seed ^ ((triggeredMiniPops + 1) * 0x45d9f3b)) >>> 0,
      config,
      winEvaluator,
      totalLines,
      bankedChargeLines,
      startingGrid: applied.grid,
      startingWildMultipliers: applied.wildMultipliers,
      startingFallOffsets: applied.fallOffsets,
      popFeature: {
        popIndex: triggeredMiniPops,
        feature: applied.feature,
        affectedPositions: applied.affectedPositions,
        transformedSymbol: applied.transformedSymbol,
        removedSymbols: applied.removedSymbols,
        spawnSymbol: config.wildSymbol,
      },
      popDebug: {
        action: 'mini-pop-triggered',
        triggerNumber: triggeredMiniPops,
        feature: applied.feature,
        totalLines,
        bankedChargeLinesBeforeSpend,
        bankedChargeLinesAfterSpend: bankedChargeLines,
        availablePopsBeforeSpend,
        availablePopsAfterSpend: Math.min(popsToRush, Math.floor(bankedChargeLines / linesPerPop)),
        affectedPositions: applied.affectedPositions,
      },
    }));
  }

  const boardCleared = isBoardClear(currentGrid);
  const rushReady = canTriggerPopRush();
  annotateLastSettledStep(boardCleared ? 'settled-board-clear' : rushReady ? 'settled-pop-rush-ready' : 'settled-no-mini-pops-remaining');
  if (boardCleared) {
    awardFullClearBonus({ cascadeSteps, totalPayoutMultiplier, finalGrid: currentGrid, wildMultipliers: currentWildMultipliers });
    totalPayoutMultiplier = cascadeSteps.reduce((sum, step) => sum + (step.payout || 0), 0);
  }

  if (!rushReady) {
    return {
      cascadeSteps,
      totalPayoutMultiplier,
      finalGrid: currentGrid,
      wildMultipliers: currentWildMultipliers,
      scatterWin: null,
      triggeredPopRush: false,
      popRushVariant: null,
      popProgress: popProgressSnapshot(totalLines, bankedChargeLines, linesPerPop, popsToRush),
    };
  }

  // A separate derived seed keeps the base sequence deterministic and makes feature selection
  // reproducible without consuming a second, shared random stream.
  const specialSeed = (seed ^ 0x9e3779b9) >>> 0;
  annotateLastSettledStep('pop-rush-triggered', boardCleared ? { fullClearBonusMultiplier: FULL_CLEAR_BONUS_MULTIPLIER } : {});
  const special = awardFullClearBonus(resolveSequence({
    reelStrips,
    rowsCount,
    seed: specialSeed,
    config,
    winEvaluator,
    special: true,
    totalLines,
    bankedChargeLines,
  }));
  appendSequence(special);
  totalPayoutMultiplier = cascadeSteps.reduce((sum, step) => sum + (step.payout || 0), 0);
  return {
    cascadeSteps,
    totalPayoutMultiplier,
    finalGrid: special.finalGrid,
    wildMultipliers: special.wildMultipliers,
    scatterWin: null,
    triggeredPopRush: true,
    popRushVariant: special.popRushVariant,
    popProgress: popProgressSnapshot(totalLines, bankedChargeLines, linesPerPop, popsToRush),
  };
}

export const LemonPopSpinMechanic = {
  // Separate name lets simulation workers select this mechanic instead of generic refill cascades.
  name: LEMON_POP_MECHANIC_NAME,
  isCascade: true,

  resolveLiveSpin({ reelStrips, rowsCount, seed, config, winEvaluator }) {
    const debugCheat = config.debugNextCheat;
    const sequence = debugCheat?.type === 'mini-pop'
      ? resolveCheatMiniFeature({ reelStrips, rowsCount, seed, config, winEvaluator, feature: debugCheat.feature, sparseGrid: debugCheat.sparseGrid === true })
      : debugCheat?.type === 'pop-rush'
        ? resolveCheatPopRush({ reelStrips, rowsCount, seed, config, winEvaluator, variant: debugCheat.variant })
        : resolveWholeSpin({ reelStrips, rowsCount, seed, config, winEvaluator });
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