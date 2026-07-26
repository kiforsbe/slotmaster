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
export const REEL_LENGTH = 500;
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
  { min: 5, multiplier: 0.10 },
  { min: 7, multiplier: 0.20 },
  { min: 10, multiplier: 0.40 },
  { min: 15, multiplier: 1.0 },
  { min: 25, multiplier: 3.0 },
];
const PREMIUM_PAYOUT = [
  { min: 5, multiplier: 0.25 },
  { min: 7, multiplier: 0.50 },
  { min: 10, multiplier: 1.0 },
  { min: 15, multiplier: 2.5 },
  { min: 25, multiplier: 7.5 },
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

// All 7 reels start identical (same starting-point convention as barfruits/bookbookbook) -
// each its own object so a future per-reel hand-edit can't silently affect the others.
// bonus's triggerFreeSpins gets generateReel's automatic minGap-3 spacing for free.
// const BASE_FREQUENCIES = {
//   cottoncandy: 0.05,
//   gum:         0.05,
//   crystal:     0.05,
//   rocket:      0.05,
//   crown:       0.05,
//   cake:        0.05,
//   mint:        0.10,
//   gummy:       0.10,
//   bean:        0.10,
//   chocolate:   0.10,
//   chewy:       0.10,
//   cherry:      0.10,
//   bonus:       0.01,
// };
// function buildFrequencyReel() {
//   const symbols = Object.fromEntries(Object.entries(BASE_FREQUENCIES).map(([sym, f]) => [sym, { frequency: f }]));
//   // bonus is the scatter - it stays spaced out (minGap already handles that via
//   // triggerFreeSpins) rather than ever clumping into a stack like the candy symbols do.
//   symbols.bonus.minStack = 1;
//   return {
//     // 10% chance a given candy occurrence starts a 2-4 stack instead of landing as a lone
//     // single - occasional clumps of the same candy, not a reel that's always/never stacked.
//     defaults: { minStack: 2, maxStack: 4, stackChance: 0.10, minFrequency: 0.01, maxFrequency: 1.00 },
//     symbols,
//   };
// }
// export const FREQUENCY_REEL1 = buildFrequencyReel();
// export const FREQUENCY_REEL2 = buildFrequencyReel();
// export const FREQUENCY_REEL3 = buildFrequencyReel();
// export const FREQUENCY_REEL4 = buildFrequencyReel();
// export const FREQUENCY_REEL5 = buildFrequencyReel();
// export const FREQUENCY_REEL6 = buildFrequencyReel();
// export const FREQUENCY_REEL7 = buildFrequencyReel();

export const FREQUENCY_REEL1 = {
  defaults: { maxStack: 4, minStack: 2, minFrequency: 0.005, maxFrequency: 0.25 },
  symbols: {
    cottoncandy: { frequency: 0.146 },
    gum:         { frequency: 0.1314 },
    crystal:     { frequency: 0.0627 },
    rocket:      { frequency: 0.07837 },
    crown:       { frequency: 0.03132 },
    cake:        { frequency: 0.04445 },
    mint:        { frequency: 0.02354 },
    gummy:       { frequency: 0.0854 },
    bean:        { frequency: 0.06306 },
    chocolate:   { frequency: 0.05786 },
    chewy:       { frequency: 0.06499 },
    cherry:      { frequency: 0.1109 },
    bonus:       { frequency: 0.008003, minGap: 8, maxStack: 1, minStack: 1, maxFrequency: 0.01 },
  },
};

export const FREQUENCY_REEL2 = {
  defaults: { maxStack: 4, minStack: 2, minFrequency: 0.005, maxFrequency: 0.25 },
  symbols: {
    cottoncandy: { frequency: 0.0863 },
    gum:         { frequency: 0.03665 },
    crystal:     { frequency: 0.00274 },
    rocket:      { frequency: 0.02202 },
    crown:       { frequency: 0.07073 },
    cake:        { frequency: 0.05548 },
    mint:        { frequency: 0.06362 },
    gummy:       { frequency: 0.1255 },
    bean:        { frequency: 0.163 },
    chocolate:   { frequency: 0.06944 },
    chewy:       { frequency: 0.1263 },
    cherry:      { frequency: 0.0784 },
    bonus:       { frequency: 0.008003, minGap: 8, maxStack: 1, minStack: 1, maxFrequency: 0.01 },
  },
};

export const FREQUENCY_REEL3 = {
  defaults: { maxStack: 4, minStack: 2, minFrequency: 0.005, maxFrequency: 0.25 },
  symbols: {
    cottoncandy: { frequency: 0.04252 },
    gum:         { frequency: 0.04417 },
    crystal:     { frequency: 0.02513 },
    rocket:      { frequency: 0.04414 },
    crown:       { frequency: 0.02859 },
    cake:        { frequency: 0.02044 },
    mint:        { frequency: 0.07327 },
    gummy:       { frequency: 0.0242 },
    bean:        { frequency: 0.08399 },
    chocolate:   { frequency: 0.06749 },
    chewy:       { frequency: 0.0208 },
    cherry:      { frequency: 0.02528 },
    bonus:       { frequency: 0.008003, minGap: 8, maxStack: 1, minStack: 1, maxFrequency: 0.01 },
  },
};

export const FREQUENCY_REEL4 = {
  defaults: { maxStack: 4, minStack: 2, minFrequency: 0.005, maxFrequency: 0.25 },
  symbols: {
    cottoncandy: { frequency: 0.1002 },
    gum:         { frequency: 0.01783 },
    crystal:     { frequency: 0.001806 },
    rocket:      { frequency: 0.03198 },
    crown:       { frequency: 0.07965 },
    cake:        { frequency: 0.07212 },
    mint:        { frequency: 0.00849 },
    gummy:       { frequency: 0.1153 },
    bean:        { frequency: 0.2006 },
    chocolate:   { frequency: 0.1239 },
    chewy:       { frequency: 0.07815 },
    cherry:      { frequency: 0.06982 },
    bonus:       { frequency: 0.008003, minGap: 8, maxStack: 1, minStack: 1, maxFrequency: 0.01 },
  },
};

export const FREQUENCY_REEL5 = {
  defaults: { maxStack: 4, minStack: 2, minFrequency: 0.005, maxFrequency: 0.25 },
  symbols: {
    cottoncandy: { frequency: 0.09981 },
    gum:         { frequency: 0.04317 },
    crystal:     { frequency: 0.06434 },
    rocket:      { frequency: 0.1144 },
    crown:       { frequency: 0.08984 },
    cake:        { frequency: 0.02201 },
    mint:        { frequency: 0.009628 },
    gummy:       { frequency: 0.1082 },
    bean:        { frequency: 0.09757 },
    chocolate:   { frequency: 0.1009 },
    chewy:       { frequency: 0.08036 },
    cherry:      { frequency: 0.06973 },
    bonus:       { frequency: 0.008003, minGap: 8, maxStack: 1, minStack: 1, maxFrequency: 0.01 },
  },
};

export const FREQUENCY_REEL6 = {
  defaults: { maxStack: 4, minStack: 2, minFrequency: 0.005, maxFrequency: 0.25 },
  symbols: {
    cottoncandy: { frequency: 0.06163 },
    gum:         { frequency: 0.08619 },
    crystal:     { frequency: 0.09488 },
    rocket:      { frequency: 0.002432 },
    crown:       { frequency: 0.1021 },
    cake:        { frequency: 0.0887 },
    mint:        { frequency: 0.03907 },
    gummy:       { frequency: 0.1051 },
    bean:        { frequency: 0.06764 },
    chocolate:   { frequency: 0.06796 },
    chewy:       { frequency: 0.04735 },
    cherry:      { frequency: 0.1369 },
    bonus:       { frequency: 0.008003, minGap: 8, maxStack: 1, minStack: 1, maxFrequency: 0.01 },
  },
};

export const FREQUENCY_REEL7 = {
  defaults: { maxStack: 4, minStack: 2, minFrequency: 0.005, maxFrequency: 0.25 },
  symbols: {
    cottoncandy: { frequency: 0.1044 },
    gum:         { frequency: 0.0571 },
    crystal:     { frequency: 0.09467 },
    rocket:      { frequency: 0.06537 },
    crown:       { frequency: 0.1115 },
    cake:        { frequency: 0.12 },
    mint:        { frequency: 0.06288 },
    gummy:       { frequency: 0.06577 },
    bean:        { frequency: 0.02655 },
    chocolate:   { frequency: 0.08764 },
    chewy:       { frequency: 0.04574 },
    cherry:      { frequency: 0.05848 },
    bonus:       { frequency: 0.008003, minGap: 8, maxStack: 1, minStack: 1, maxFrequency: 0.01 },
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
          // the primitives (minClusterSize/scatterTriggerCount) tuneFrequenciesWorker.js needs
          // to rebuild an equivalent closure on its side of postMessage.
          winEvaluatorName: 'checkClusterWins',
          minClusterSize: MIN_CLUSTER_SIZE,
          scatterTriggerCount: SCATTER_TRIGGER_COUNT,
          freeSpinsCount: FREE_SPINS_AWARD,
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
