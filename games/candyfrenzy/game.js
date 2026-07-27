// Game coordinator for Candy Frenzy - a 7x7 cluster-pays cascading slot.
import { CascadeEngine } from '../../core/CascadeEngine.js';
import { generateReel } from '../../core/SlotMath.js';
import { checkClusterWins } from '../../core/ClusterMath.js';
import { openSpinLogPanel } from '../../core/SpinLogPanel.js';
import { createMultiplierTilesMode } from '../../core/FreeSpinsModes.js';
import { CascadeSpinMechanic } from '../../core/CascadeSpinMechanic.js';
import { runSimulationAndRender, openTuneFrequenciesPanel } from '../../core/SimulationPanel.js';

export const REELS_COUNT = 7;
export const ROWS_COUNT = 7;
export const REEL_SEEDS = [101, 202, 303, 404, 505, 606, 707];
export const BET_AMOUNT = 1.00;
export const BET_STEP = 0.50;
export const BET_MAX = 50;
export const MIN_CLUSTER_SIZE = 5;
export const SCATTER_TRIGGER_COUNT = 3;
export const FREE_SPINS_AWARD = 10;

// 5 breakpoints since a cluster can run all the way up to 49 cells on this 7x7 grid - not a
// small fixed count like a payline game's payout[i] array.
const REGULAR_PAYOUT = [
  { min:  5, multiplier: 0.75 },
  { min:  7, multiplier: 1.25 },
  { min: 10, multiplier: 1.50 },
  { min: 15, multiplier: 3.00 },
  { min: 25, multiplier: 6.00 },
];
const PREMIUM_PAYOUT = [
  { min:  5, multiplier:  0.75 },
  { min:  7, multiplier:  1.75 },
  { min: 10, multiplier:  3.00 },
  { min: 15, multiplier:  6.50 },
  { min: 25, multiplier: 12.50 },
];

// chest, clover, and wild exist in the art but are unused in v1 - excluded here entirely,
// so they never appear on a reel or in the paytable.
export const PAYTABLE = {
  cottoncandy: { type: 'premium', clusterPayout: PREMIUM_PAYOUT, friendlyName: 'Cotton Candy' },
  gum:         { type: 'premium', clusterPayout: PREMIUM_PAYOUT, friendlyName: 'Bubble Gum' },
  crystal:     { type: 'premium', clusterPayout: PREMIUM_PAYOUT, friendlyName: 'Sugar Crystal' },
  rocket:      { type: 'premium', clusterPayout: PREMIUM_PAYOUT, friendlyName: 'Candy Rocket' },
  crown:       { type: 'premium', clusterPayout: PREMIUM_PAYOUT, friendlyName: 'Candy Crown' },
  cake:        { type: 'premium', clusterPayout: PREMIUM_PAYOUT, friendlyName: 'Cake Slice' },
  mint:        { type: 'regular', clusterPayout: REGULAR_PAYOUT, friendlyName: 'Mint' },
  gummy:       { type: 'regular', clusterPayout: REGULAR_PAYOUT, friendlyName: 'Gummy Bear' },
  bean:        { type: 'regular', clusterPayout: REGULAR_PAYOUT, friendlyName: 'Jelly Bean' },
  chocolate:   { type: 'regular', clusterPayout: REGULAR_PAYOUT, friendlyName: 'Chocolate' },
  chewy:       { type: 'regular', clusterPayout: REGULAR_PAYOUT, friendlyName: 'Chewy Candy' },
  cherry:      { type: 'regular', clusterPayout: REGULAR_PAYOUT, friendlyName: 'Cherry Candy' },
  bonus:       { type: 'scatter', paymode: 'any', triggerFreeSpins: true, friendlyName: 'Bonus' },
};

// ---- Tuned 2026-07-26 ----
// Achieved: RTP 92.75%  |  free-spin trigger 0.518%
//
// To reproduce this exact run, the tuner needs all of the following - same searchSeed AND
// same reel geometry, since strips are generated from them:
//   searchSeed 12345   reelSeeds [101, 202, 303, 404, 505, 606, 707]
//   reelLength 500   reels 7 x 7 rows
//   target RTP 96% +/-1.5   target trigger 0.6% +/-0.15
//   30,000 spins x 3 trials   cmaes, max 150 iterations
//   initial weights: uniform   max RTP std error 1
//   loss weights: ordering 0.5, limit 2, uniformity 3, stdError 0.5, triggerRate 0, spacing 0
//   ordering bias by reel: [0, 0, 0, 0, 0, 0, 0]
//
// REEL_LENGTH is part of the result, not a separate setting - these frequencies were tuned
// against this length and do not reproduce the RTP above at any other.
export const REEL_LENGTH = 500;

export const FREQUENCY_REEL1 = {
  defaults: { minGap: 4, maxStack: 4, minStack: 2, stackChance: 0.3, minFrequency: 0.005, maxFrequency: 0.5 },
  symbols: {
    cottoncandy: { frequency: 0.045 },
    gum:         { frequency: 0.03806 },
    crystal:     { frequency: 0.1132 },
    rocket:      { frequency: 0.06637 },
    crown:       { frequency: 0.04367 },
    cake:        { frequency: 0.08252 },
    mint:        { frequency: 0.05885 },
    gummy:       { frequency: 0.103 },
    bean:        { frequency: 0.07012 },
    chocolate:   { frequency: 0.1023 },
    chewy:       { frequency: 0.03041 },
    cherry:      { frequency: 0.1465 },
    bonus:       { frequency: 0.007258, minGap: 8, maxStack: 1, minStack: 1, maxFrequency: 0.025 },
  },
};

export const FREQUENCY_REEL2 = {
  defaults: { minGap: 4, maxStack: 4, minStack: 2, stackChance: 0.3, minFrequency: 0.005, maxFrequency: 0.5 },
  symbols: {
    cottoncandy: { frequency: 0.1558 },
    gum:         { frequency: 0.1001 },
    crystal:     { frequency: 0.008095 },
    rocket:      { frequency: 0.07036 },
    crown:       { frequency: 0.067 },
    cake:        { frequency: 0.01025 },
    mint:        { frequency: 0.01959 },
    gummy:       { frequency: 0.05598 },
    bean:        { frequency: 0.1651 },
    chocolate:   { frequency: 0.06354 },
    chewy:       { frequency: 0.1287 },
    cherry:      { frequency: 0.05564 },
    bonus:       { frequency: 0.005434, minGap: 8, maxStack: 1, minStack: 1, maxFrequency: 0.025 },
  },
};

export const FREQUENCY_REEL3 = {
  defaults: { minGap: 4, maxStack: 4, minStack: 2, stackChance: 0.3, minFrequency: 0.005, maxFrequency: 0.5 },
  symbols: {
    cottoncandy: { frequency: 0.01465 },
    gum:         { frequency: 0.03903 },
    crystal:     { frequency: 0.09772 },
    rocket:      { frequency: 0.0285 },
    crown:       { frequency: 0.0417 },
    cake:        { frequency: 0.04431 },
    mint:        { frequency: 0.1411 },
    gummy:       { frequency: 0.03123 },
    bean:        { frequency: 0.006208 },
    chocolate:   { frequency: 0.04117 },
    chewy:       { frequency: 0.01276 },
    cherry:      { frequency: 0.001704 },
    bonus:       { frequency: 0.006074, minGap: 8, maxStack: 1, minStack: 1, maxFrequency: 0.025 },
  },
};

export const FREQUENCY_REEL4 = {
  defaults: { minGap: 4, maxStack: 4, minStack: 2, stackChance: 0.3, minFrequency: 0.005, maxFrequency: 0.5 },
  symbols: {
    cottoncandy: { frequency: 0.06033 },
    gum:         { frequency: 0.01783 },
    crystal:     { frequency: 0.001093 },
    rocket:      { frequency: 0.03975 },
    crown:       { frequency: 0.05339 },
    cake:        { frequency: 0.07667 },
    mint:        { frequency: 0.00768 },
    gummy:       { frequency: 0.3076 },
    bean:        { frequency: 0.07033 },
    chocolate:   { frequency: 0.107 },
    chewy:       { frequency: 0.08659 },
    cherry:      { frequency: 0.07157 },
    bonus:       { frequency: 0.005432, minGap: 8, maxStack: 1, minStack: 1, maxFrequency: 0.025 },
  },
};

export const FREQUENCY_REEL5 = {
  defaults: { minGap: 4, maxStack: 4, minStack: 2, stackChance: 0.3, minFrequency: 0.005, maxFrequency: 0.5 },
  symbols: {
    cottoncandy: { frequency: 0.06622 },
    gum:         { frequency: 0.1364 },
    crystal:     { frequency: 0.08726 },
    rocket:      { frequency: 0.1411 },
    crown:       { frequency: 0.1225 },
    cake:        { frequency: 0.0133 },
    mint:        { frequency: 0.01601 },
    gummy:       { frequency: 0.03014 },
    bean:        { frequency: 0.0697 },
    chocolate:   { frequency: 0.0653 },
    chewy:       { frequency: 0.09253 },
    cherry:      { frequency: 0.05944 },
    bonus:       { frequency: 0.005432, minGap: 8, maxStack: 1, minStack: 1, maxFrequency: 0.025 },
  },
};

export const FREQUENCY_REEL6 = {
  defaults: { minGap: 4, maxStack: 4, minStack: 2, stackChance: 0.3, minFrequency: 0.005, maxFrequency: 0.5 },
  symbols: {
    cottoncandy: { frequency: 0.008941 },
    gum:         { frequency: 0.05354 },
    crystal:     { frequency: 0.06543 },
    rocket:      { frequency: 0.004154 },
    crown:       { frequency: 0.05742 },
    cake:        { frequency: 0.1292 },
    mint:        { frequency: 0.01313 },
    gummy:       { frequency: 0.1353 },
    bean:        { frequency: 0.09517 },
    chocolate:   { frequency: 0.05745 },
    chewy:       { frequency: 0.1117 },
    cherry:      { frequency: 0.1687 },
    bonus:       { frequency: 0.005433, minGap: 8, maxStack: 1, minStack: 1, maxFrequency: 0.025 },
  },
};

export const FREQUENCY_REEL7 = {
  defaults: { minGap: 4, maxStack: 4, minStack: 2, stackChance: 0.3, minFrequency: 0.005, maxFrequency: 0.5 },
  symbols: {
    cottoncandy: { frequency: 0.06334 },
    gum:         { frequency: 0.06801 },
    crystal:     { frequency: 0.06962 },
    rocket:      { frequency: 0.09204 },
    crown:       { frequency: 0.1237 },
    cake:        { frequency: 0.1209 },
    mint:        { frequency: 0.04499 },
    gummy:       { frequency: 0.04525 },
    bean:        { frequency: 0.05486 },
    chocolate:   { frequency: 0.09246 },
    chewy:       { frequency: 0.05745 },
    cherry:      { frequency: 0.06744 },
    bonus:       { frequency: 0.005433, minGap: 8, maxStack: 1, minStack: 1, maxFrequency: 0.025 },
  },
};
const FREQUENCY_REELS = [FREQUENCY_REEL1, FREQUENCY_REEL2, FREQUENCY_REEL3, FREQUENCY_REEL4, FREQUENCY_REEL5, FREQUENCY_REEL6, FREQUENCY_REEL7];

export const REEL_STRIPS = FREQUENCY_REELS.map((freqTable, i) => generateReel(freqTable, REEL_LENGTH, REEL_SEEDS[i], [], 3, PAYTABLE));

const winEvaluator = (grid) => checkClusterWins(grid, PAYTABLE, MIN_CLUSTER_SIZE, 'bonus', SCATTER_TRIGGER_COUNT);

let canvas, btnSpin, btnAuto, btnTurbo, btnMute, btnPaytable, btnPaytableOk;
let displayBalance, betValue, betMinus, betPlus, gameTicker;
let btnSpinLog, btnSim, btnTune, simModal, simStats;
let simRtpDisplay, simTotalSpinsDisplay, simMaxWinDisplay, simFreeSpinsDisplay;
let modalPaytable, modalFsTrigger, modalFsSummary, btnStartFs, btnCloseFsSummary, fsAwardAmount;
let fsPanel, fsCounter, fsTotalWin;
let cheatScatter;

const DEBUG_MODE = true;

let engine = null;
let pendingFreeSpinsAward = 0;
const THEME_NAME = 'candies_1';

async function loadThemeAssets(themeName) {
  try {
    const response = await fetch(`./assets/${themeName}/${themeName}.tiles.json`);
    const data = await response.json();
    const symbolsConfig = {};
    data.tiles.forEach(tile => {
      symbolsConfig[tile.name] = { x: tile.x, y: tile.y, w: tile.w, h: tile.h };
    });
    const spritesheetUrl = `./assets/${themeName}/${data.sheet}`;
    return { spritesheetUrl, symbolsConfig };
  } catch (error) {
    console.error(`Failed to fetch tile config for theme: ${themeName}`, error);
    return null;
  }
}

async function initGame() {
  canvas = document.getElementById('game-canvas');
  btnSpin = document.getElementById('btn-spin');
  btnAuto = document.getElementById('btn-auto');
  btnTurbo = document.getElementById('btn-turbo');
  btnMute = document.getElementById('btn-mute');
  btnPaytable = document.getElementById('btn-paytable');
  btnPaytableOk = document.getElementById('btn-paytable-ok');
  displayBalance = document.getElementById('display-balance');
  betValue = document.getElementById('bet-value');
  betMinus = document.getElementById('bet-minus');
  betPlus = document.getElementById('bet-plus');
  gameTicker = document.getElementById('game-ticker');

  btnSpinLog = document.getElementById('btn-spinlog');
  btnSim = document.getElementById('btn-sim');
  btnTune = document.getElementById('btn-tune');
  simModal = document.getElementById('sim-modal');
  simStats = document.getElementById('sim-stats');
  simRtpDisplay = document.getElementById('sim-rtp');
  simTotalSpinsDisplay = document.getElementById('sim-total-spins');
  simMaxWinDisplay = document.getElementById('sim-max-win');
  simFreeSpinsDisplay = document.getElementById('sim-free-spins');

  modalPaytable = document.getElementById('modal-paytable');
  modalFsTrigger = document.getElementById('modal-fs-trigger');
  modalFsSummary = document.getElementById('modal-fs-summary');
  btnStartFs = document.getElementById('btn-start-fs');
  btnCloseFsSummary = document.getElementById('btn-close-fs-summary');
  fsAwardAmount = document.getElementById('fs-award-amount');

  fsPanel = document.getElementById('fs-panel');
  fsCounter = document.getElementById('fs-counter');
  fsTotalWin = document.getElementById('fs-total-win');

  cheatScatter = document.getElementById('cheat-scatter');

  const debugShortcuts = document.querySelector('.debug-shortcuts');
  if (debugShortcuts && DEBUG_MODE) debugShortcuts.classList.add('debug-enabled');

  if (btnSpinLog) {
    btnSpinLog.addEventListener('click', () => {
      openSpinLogPanel({ engine, domRefs: { simModal, simStats } });
    });
  }
  if (btnSim) {
    btnSim.addEventListener('click', () => {
      runSimulationAndRender({
        engine,
        paytable: PAYTABLE,
        betPerLine: BET_AMOUNT,
        linesCount: 1,
        numSpins: 1000000,
        labels: CascadeSpinMechanic.statsLabels,
        domRefs: { btnSim, simModal, simStats, simRtpDisplay, simTotalSpinsDisplay, simMaxWinDisplay, simFreeSpinsDisplay },
      });
    });
  }
  if (btnTune) {
    btnTune.addEventListener('click', () => {
      openTuneFrequenciesPanel({
        paytable: PAYTABLE,
        reelFrequencyTables: FREQUENCY_REELS,
        tuneConfig: {
          reelsCount: REELS_COUNT,
          rowsCount: ROWS_COUNT,
          scatterSymbol: 'bonus',
          reelSeeds: REEL_SEEDS,
          betPerLine: BET_AMOUNT,
          linesCount: 1,
          reelLength: REEL_LENGTH,
          mechanic: CascadeSpinMechanic,
          // Reuses this exact live instance (not a fresh one) so a tuned candidate's measured
          // RTP reflects the real free-spins economics (persistent multiplier tiles) engine
          // actually plays with, not a second, potentially-diverging copy.
          freeSpinsMode: engine.config.freeSpinsMode,
          // checkClusterWins is called through a per-game closure (winEvaluator, above) rather
          // than a reusable bare function, so it can't be identified by its own `.name` the
          // way a line-pay game's winEvaluator can - this names it explicitly instead, with
          // the primitives (minClusterSize/scatterTriggerCount) a pool Worker (core/
          // simulationTrialWorker.js) needs to rebuild an equivalent closure on its side of
          // postMessage.
          winEvaluatorName: 'checkClusterWins',
          minClusterSize: MIN_CLUSTER_SIZE,
          scatterTriggerCount: SCATTER_TRIGGER_COUNT,
          freeSpinsCount: FREE_SPINS_AWARD,
          // Deliberately 0 for now, with a caveat worth reading before raising it.
          //
          // This IS a cascade game, so unlike a line-pay game its trigger rate genuinely is
          // coupled to the non-trigger symbols: candy weights govern how readily clusters form,
          // which governs cascade depth, and every cascade refills the grid with fresh chances to
          // draw `bonus`. Under deliberately extreme reweighting (bonus held byte-identical,
          // every reel's candy budget preserved) that coupling spans a 0.75%-2.04% trigger range.
          // So a non-zero weight here is the right tool IN PRINCIPLE.
          //
          // What blocks it today is upstream: at REEL_LENGTH 500 the default 0.6% +/-0.15 target
          // is not reachable AT ALL. `bonus` lands only 2-6 times on a 500-position strip, so one
          // whole symbol is a huge relative step and the achievable trigger rates near the target
          // go 0.207% -> 0.343% -> 0.368% -> 0.893% - straight over the 0.45%-0.75% band with
          // nothing inside it. Phase 1 now reports that honestly as reason 'lattice-gap' rather
          // than burning its budget on it.
          //
          // With the target unreachable, a non-zero weight just trades RTP away for trigger-rate
          // progress that can never arrive: measured at weight 2, RTP went 94.88% -> 103.83%
          // while the trigger rate moved only 0.353% -> 0.400%. Fix the reachability first -
          // REEL_LENGTH ~3000 puts several multipliers inside the band (0.458%/0.460%/0.713%), or
          // widen the tolerance, or pick a target that exists - and only then raise this to stop
          // Phase 2 from undoing Phase 1's work.
          triggerRatePenaltyWeight: 0,
          // Candy Frenzy is cluster-pays on a 7x7 grid: a cluster forms from grid-adjacent cells,
          // so reel index carries no meaning and per-reel frequency spread is search noise rather
          // than design. Measured at 849bc8a (40k spins, seed 4242), independent per-reel tuning
          // produced `chewy` at 0.4105 on reel 2 against 0.0056 on reel 3, and those tables paid
          // 74.70% RTP - 27pp WORSE than giving every candy the same frequency (101.48%). Linking
          // makes that spread unrepresentable rather than merely penalized, and cuts the search
          // from 84 dimensions to 12; the refine stage still allows a deliberate per-reel tilt,
          // bounded to +/-maxReelDeviation around the shared answer.
          reelCoupling: 'linked-then-refine',
        },
        domRefs: { simModal, simStats },
      });
    });
  }

  const themeAssets = await loadThemeAssets(THEME_NAME);
  if (!themeAssets) {
    alert('Error loading assets!');
    return;
  }

  engine = new CascadeEngine(canvas, {
    reelsCount: REELS_COUNT,
    rowsCount: ROWS_COUNT,
    paytable: PAYTABLE,
    reelStrips: REEL_STRIPS,
    winEvaluator,
    scatterSymbol: 'bonus',
    freeSpinsMode: createMultiplierTilesMode({ badgeStyle: 'background', renderOrder: 'behind' }),
    symbolsConfig: themeAssets.symbolsConfig,
    spritesheetUrl: themeAssets.spritesheetUrl,
    betAmount: BET_AMOUNT,
    onStateChange: (state) => handleStateChange(state),
    onScatterTrigger: (scatterCount, isInFreeSpins) => handleScatterTrigger(scatterCount, isInFreeSpins),
    onWin: (winInfo) => handleWin(winInfo),
  });

  updateUI();
  setupUIHandlers();
  buildPaytableContent();
}

function updateUI() {
  if (!engine) return;
  displayBalance.textContent = `$${engine.balance.toFixed(2)}`;
  betValue.textContent = engine.betAmount.toFixed(2);

  if (engine.inFreeSpins) {
    fsPanel.classList.add('active');
    fsCounter.textContent = `FREE SPINS: ${engine.freeSpinsRemaining} / ${engine.freeSpinsTotal}`;
  } else {
    fsPanel.classList.remove('active');
  }
}

function handleStateChange(state) {
  updateUI();

  if (state === 'dropping_in' || state === 'falling') {
    btnSpin.textContent = 'STOP';
    btnSpin.className = 'btn-spin spinning';
    gameTicker.textContent = state === 'dropping_in' ? 'DROPPING IN...' : 'CASCADING...';
  } else if (state === 'clearing') {
    gameTicker.textContent = 'SWEET WIN!';
  } else {
    btnSpin.textContent = 'SPIN';
    btnSpin.className = 'btn-spin';

    if (state === 'showing_wins') {
      gameTicker.textContent = `WIN: $${engine.lastWin.toFixed(2)}!`;
    } else if (state === 'free_spins_intro') {
      gameTicker.textContent = 'BONUS TRIGGER!';
    } else if (state === 'game_over') {
      gameTicker.textContent = 'FREE SPINS COMPLETE!';
      handleFreeSpinsComplete();
    } else {
      gameTicker.textContent = 'IDLE';
    }
  }
}

function handleWin(winInfo) {
  updateUI();
}

function handleScatterTrigger(scatterCount, isInFreeSpins) {
  if (isInFreeSpins) {
    engine.retriggerFreeSpins(FREE_SPINS_AWARD);
    gameTicker.textContent = `+${FREE_SPINS_AWARD} EXTRA SPINS!`;
    engine.audio.playScatterTrigger();
    updateUI();
    return;
  }

  pendingFreeSpinsAward = FREE_SPINS_AWARD;
  engine.enterFreeSpinsIntro();
  fsAwardAmount.textContent = FREE_SPINS_AWARD;
  modalFsTrigger.classList.add('active');
  engine.audio.playScatterTrigger();
}

function startFreeSpins() {
  modalFsTrigger.classList.remove('active');
  engine.enterFreeSpins(pendingFreeSpinsAward);
}

function handleFreeSpinsComplete() {
  fsTotalWin.textContent = `$${engine.freeSpinsAccumulatedWin.toFixed(2)}`;
  modalFsSummary.classList.add('active');
  engine.audio.playScatterTrigger();
}

function closeFreeSpinsSummary() {
  modalFsSummary.classList.remove('active');
  engine.returnToIdle();
  updateUI();
  engine.handleAutoPlay();
}

function setupUIHandlers() {
  btnSpin.addEventListener('click', () => {
    engine.requestSpin();
  });

  betMinus.addEventListener('click', () => {
    if (engine.state !== 'idle' && engine.state !== 'showing_wins') return;
    if (engine.betAmount > BET_STEP + 1e-9) {
      engine.betAmount = Math.round((engine.betAmount - BET_STEP) * 100) / 100;
      updateUI();
    }
  });

  betPlus.addEventListener('click', () => {
    if (engine.state !== 'idle' && engine.state !== 'showing_wins') return;
    const newBet = Math.round((engine.betAmount + BET_STEP) * 100) / 100;
    if (newBet <= BET_MAX + 1e-9 && engine.balance >= newBet) {
      engine.betAmount = newBet;
      updateUI();
    }
  });

  btnAuto.addEventListener('click', () => {
    engine.autoPlay = !engine.autoPlay;
    btnAuto.classList.toggle('active', engine.autoPlay);
    if (engine.autoPlay && engine.state === 'idle') {
      engine.spin();
    }
  });

  btnTurbo.addEventListener('click', () => {
    engine.turboMode = !engine.turboMode;
    btnTurbo.classList.toggle('active', engine.turboMode);
  });

  btnMute.addEventListener('click', () => {
    const isMuted = engine.audio.toggleMute();
    btnMute.textContent = isMuted ? '🔇 Sound OFF' : '🔊 Sound ON';
    btnMute.classList.toggle('active', isMuted);
  });

  btnPaytable.addEventListener('click', () => {
    modalPaytable.classList.add('active');
  });

  const closePaytable = () => modalPaytable.classList.remove('active');
  btnPaytableOk.addEventListener('click', closePaytable);
  // Every modal's "x" close button - works for .modal-overlay-style modals (paytable, free
  // spins trigger/summary) and the shared #sim-modal (SPIN LOG), which toggles via inline
  // display instead of the .active class.
  document.querySelectorAll('.btn-modal-close').forEach(btn => {
    btn.addEventListener('click', () => {
      const overlay = btn.closest('.modal-overlay');
      if (overlay) { overlay.classList.remove('active'); return; }
      const simModalEl = btn.closest('.sim-modal');
      if (simModalEl) simModalEl.style.display = 'none';
    });
  });

  if (btnStartFs) btnStartFs.addEventListener('click', startFreeSpins);
  if (btnCloseFsSummary) btnCloseFsSummary.addEventListener('click', closeFreeSpinsSummary);

  if (DEBUG_MODE && cheatScatter) {
    cheatScatter.addEventListener('click', () => engine.forceScatterResult());
  }
}

function buildPaytableContent() {
  const container = document.getElementById('paytable-grid-content');
  container.innerHTML = '';

  for (const symbol of Object.keys(PAYTABLE)) {
    const meta = PAYTABLE[symbol];
    const item = document.createElement('div');
    item.className = 'paytable-item';

    const title = document.createElement('span');
    title.className = 'paytable-symbol-name';
    title.textContent = meta.friendlyName || symbol;
    item.appendChild(title);

    const payLines = document.createElement('div');
    payLines.className = 'paytable-payouts';

    let content = '';
    if (meta.clusterPayout) {
      meta.clusterPayout.forEach(tier => {
        const label = tier.min >= 25 ? `${tier.min}+` : (() => {
          const next = meta.clusterPayout.find(t => t.min > tier.min);
          return next ? `${tier.min}-${next.min - 1}` : `${tier.min}+`;
        })();
        content += `<strong>${label}:</strong> ${tier.multiplier}x<br>`;
      });
    } else {
      content += `<em style="color:#ff6ec7; font-size:10px;">Pays anywhere. 3+ triggers ${FREE_SPINS_AWARD} Free Spins - winning tiles leave a growing multiplier</em>`;
    }

    payLines.innerHTML = content;
    item.appendChild(payLines);
    container.appendChild(item);
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('load', initGame);
}
