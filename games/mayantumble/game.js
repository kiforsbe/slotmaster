// Game coordinator for Mayan Tumble - a 5x3 payline-based cascading slot.
import { CoreSlotEngine } from '../../core/engine/CoreSlotEngine.js';
import { CascadeDropAnimator } from '../../core/engine/animators/CascadeDropAnimator.js';
import { SlotRenderer } from '../../core/rendering/SlotRenderer.js';
import { ParticleSystem } from '../../core/rendering/ParticleSystem.js';
import { SpinLogRecorder } from '../../core/engine/SpinLogRecorder.js';
import { AudioController } from '../../core/engine/AudioController.js';
import { generateReel, checkWins } from '../../core/math/SlotMath.js';
import { openSpinLogPanel } from '../../core/ui/dev/SpinLogPanel.js';
import { bindCommonSlotControls, observeSlotViewport, updateSlotStateUI } from '../../core/ui/SlotGameUI.js';
import { ensureDeveloperPanels } from '../../core/ui/DeveloperPanels.js';
import { renderLinePaytable } from '../../core/ui/PaytableRenderer.js';
import { createMultiplierTilesMode } from '../../core/engine/FreeSpinsModes.js';
import { CascadeSpinMechanic } from '../../core/engine/mechanics/CascadeSpinMechanic.js';
import { runSimulationAndRender } from '../../core/ui/dev/SimulationPanel.js';
import { openTuningPanel } from '../../core/ui/dev/tuning/TuningPanelView.js';

export const REELS_COUNT = 5;
export const ROWS_COUNT = 3;
export const REEL_SEEDS = [8721, 1432, 998, 7653, 4421];
export const BET_AMOUNT = 1.00;
export const BET_STEP = 0.10;
export const BET_MAX = 50.00;
export const SCATTER_TRIGGER_COUNT = 3;
export const FREE_SPINS_AWARD = 10;

// Payline definitions - standard 10 paylines from barfruits/bookbookbook
export const PAYLINES = [
  [1, 1, 1, 1, 1], // Line 1: Horizontal Middle Row
  [0, 0, 0, 0, 0], // Line 2: Horizontal Top Row
  [2, 2, 2, 2, 2], // Line 3: Horizontal Bottom Row
  [0, 1, 2, 1, 0], // Line 4: V-Shape
  [2, 1, 0, 1, 2], // Line 5: Inverted V-Shape
  [0, 0, 1, 2, 2], // Line 6: Step Down-Up
  [2, 2, 1, 0, 0], // Line 7: Step Up-Down
  [1, 2, 2, 2, 1], // Line 8: U-Shape Bottom
  [1, 0, 0, 0, 1], // Line 9: U-Shape Top
  [0, 1, 0, 1, 0]  // Line 10: Zigzag
];

// Paytable based on bookbookbook:
// payout[i] is for i+1 matching symbols.
// note: maise matches the JSON asset key name but is shown as Maize.
export const PAYTABLE = {
  gold:     { payout: [0,  0,   2,   20,  200], type: 'scatter', paymode: 'any',  wild: false, triggerFreeSpins: true,  friendlyName: 'Gold Scatter' },
  llama:    { payout: [0, 10, 100, 1000, 5000], type: 'premium', paymode: 'line', wild: false, triggerFreeSpins: false, friendlyName: 'Llama' },
  face:     { payout: [0,  5,  40,  400, 2000], type: 'premium', paymode: 'line', wild: false, triggerFreeSpins: false, friendlyName: 'Mayan Face' },
  maise:    { payout: [0,  5,  30,  100,  750], type: 'premium', paymode: 'line', wild: false, triggerFreeSpins: false, friendlyName: 'Maize' },
  head:     { payout: [0,  5,  30,  100,  750], type: 'premium', paymode: 'line', wild: false, triggerFreeSpins: false, friendlyName: 'Mayan Head' },
  jaguar:   { payout: [0,  5,  20,   60,  500], type: 'premium', paymode: 'line', wild: false, triggerFreeSpins: false, friendlyName: 'Jaguar' },
  ace:      { payout: [0,  0,   5,   40,  150], type: 'regular', paymode: 'line', wild: false, triggerFreeSpins: false, friendlyName: 'Ace' },
  king:     { payout: [0,  0,   5,   40,  150], type: 'regular', paymode: 'line', wild: false, triggerFreeSpins: false, friendlyName: 'King' },
  queen:    { payout: [0,  0,   5,   30,  100], type: 'regular', paymode: 'line', wild: false, triggerFreeSpins: false, friendlyName: 'Queen' },
  jack:     { payout: [0,  0,   5,   30,  100], type: 'regular', paymode: 'line', wild: false, triggerFreeSpins: false, friendlyName: 'Jack' },
  ten:      { payout: [0,  0,   5,   30,  100], type: 'regular', paymode: 'line', wild: false, triggerFreeSpins: false, friendlyName: 'Ten' },
};

/**
 * Custom line-win evaluator for cascading paylines.
 * Maps standard payline wins to the CascadeEngine format.
 */
export function checkLineCascadeWins(grid, paytable, scatterSymbol, scatterTriggerCount, paylines, wildSymbol = null) {
  const results = checkWins(grid, paytable, paylines, paylines.length, wildSymbol, scatterSymbol, scatterTriggerCount);
  const clusterWins = [];
  
  results.lineWins.forEach(lw => {
    clusterWins.push({
      symbol: lw.symbol,
      count: lw.count,
      payout: lw.payout / paylines.length, // payout relative to total bet
      winningPositions: lw.winningPositions,
      // Carried through so the engine can draw WHICH line paid. A cluster game's win is its own
      // shape and needs no such thing; here the winning positions alone are three or four cells
      // that could sit on several paylines at once, and the player has no way to tell which one
      // they were paid for. CascadeEngine draws a path for any win that carries this.
      lineIndex: lw.lineIndex
    });
  });

  if (results.scatterWin) {
    clusterWins.push({
      symbol: results.scatterWin.symbol,
      count: results.scatterWin.count,
      payout: results.scatterWin.payout, // scatter payout is already relative to total bet
      winningPositions: results.scatterWin.winningPositions
      // No lineIndex - a scatter pays anywhere, so there is no line to draw.
    });
  }
  
  const totalPayoutMultiplier = (results.totalLinePayoutMultiplier / paylines.length) + (results.scatterWin ? results.scatterWin.payout : 0);
  
  return {
    clusterWins,
    totalPayoutMultiplier,
    scatterWin: results.scatterWin
  };
}

// ---- Tuned 2026-07-31 - accepted-best entry #7 (step 25, linked) ----
// Achieved: RTP 95.16%  |  free-spin trigger 0.556%  |  single trial, variance unknown
// TRAINING CANDIDATE ONLY - this is one historical search entry, not the final holdout-selected result.
// Candidate measurement: 750,000 spins x 1 trial (variance unknown).
// DO NOT ship from this value: validate these exact tables on fresh full-fidelity trials first.
// Verdict at the time: single exploration trial (variance unknown) (high volatility, top 1% carry 47%)
// Shape: volatility 14.8x (high), hit rate 28%, biggest round 4879x, top 1% carry 47%
//
// To reproduce this exact run, the tuner needs all of the following - same searchSeed AND
// same reel geometry, since strips are generated from them:
//   searchSeed 12345   reelSeeds [8721, 1432, 998, 7653, 4421]
//   reelLength 500   reels 5 x 3 rows
//   target RTP 96% +/-1.5   target trigger 0.5988% (1 in 167) +/-0.15
//   run's final-validation budget: 3,000,000 spins x 3 trials   cmaes, max 50 iterations
//   exploration: 750,000 spins x 1 trials   holdout: 3,000,000 spins x 3 trials across 4 finalists
//   initial weights: provided   max RTP std error 1
//   reelCoupling linked   maxReelDeviation 0.25
//   loss weights (raw): ordering 1, limit 1, uniformity 0, stdError 0, triggerRate 0.1, spacing 0
//   ordering bias by reel: [0, 0, 0, 0, 0]
//
// REEL_LENGTH is part of the result, not a separate setting - these frequencies were tuned
// against this length and do not reproduce the RTP above at any other.
export const REEL_LENGTH = 500;

export const FREQUENCY_REEL1 = {
  defaults: { minFrequency: 0.01, maxFrequency: 1 },
  symbols: {
    gold:   { frequency: 0.05, minGap: 3, maxStack: 1 },
    llama:  { frequency: 0.05591 },
    face:   { frequency: 0.03094 },
    maise:  { frequency: 0.05797 },
    head:   { frequency: 0.1258 },
    jaguar: { frequency: 0.05229 },
    ace:    { frequency: 0.388 },
    king:   { frequency: 0.2519 },
    queen:  { frequency: 0.4692 },
    jack:   { frequency: 0.2486 },
    ten:    { frequency: 0.1392 },
  },
};

export const FREQUENCY_REEL2 = {
  defaults: { minFrequency: 0.01, maxFrequency: 1 },
  symbols: {
    gold:   { frequency: 0.05, minGap: 3, maxStack: 1 },
    llama:  { frequency: 0.05591 },
    face:   { frequency: 0.03094 },
    maise:  { frequency: 0.05797 },
    head:   { frequency: 0.1258 },
    jaguar: { frequency: 0.05229 },
    ace:    { frequency: 0.388 },
    king:   { frequency: 0.2519 },
    queen:  { frequency: 0.4692 },
    jack:   { frequency: 0.2486 },
    ten:    { frequency: 0.1392 },
  },
};

export const FREQUENCY_REEL3 = {
  defaults: { minFrequency: 0.01, maxFrequency: 1 },
  symbols: {
    gold:   { frequency: 0.05, minGap: 3, maxStack: 1 },
    llama:  { frequency: 0.05591 },
    face:   { frequency: 0.03094 },
    maise:  { frequency: 0.05798 },
    head:   { frequency: 0.1258 },
    jaguar: { frequency: 0.0523 },
    ace:    { frequency: 0.388 },
    king:   { frequency: 0.2519 },
    queen:  { frequency: 0.4693 },
    jack:   { frequency: 0.2486 },
    ten:    { frequency: 0.1392 },
  },
};

export const FREQUENCY_REEL4 = {
  defaults: { minFrequency: 0.01, maxFrequency: 1 },
  symbols: {
    gold:   { frequency: 0.05, minGap: 3, maxStack: 1 },
    llama:  { frequency: 0.05591 },
    face:   { frequency: 0.03094 },
    maise:  { frequency: 0.05798 },
    head:   { frequency: 0.1258 },
    jaguar: { frequency: 0.0523 },
    ace:    { frequency: 0.388 },
    king:   { frequency: 0.2519 },
    queen:  { frequency: 0.4693 },
    jack:   { frequency: 0.2486 },
    ten:    { frequency: 0.1392 },
  },
};

export const FREQUENCY_REEL5 = {
  defaults: { minFrequency: 0.01, maxFrequency: 1 },
  symbols: {
    gold:   { frequency: 0.05, minGap: 3, maxStack: 1 },
    llama:  { frequency: 0.05592 },
    face:   { frequency: 0.03094 },
    maise:  { frequency: 0.05798 },
    head:   { frequency: 0.1258 },
    jaguar: { frequency: 0.0523 },
    ace:    { frequency: 0.388 },
    king:   { frequency: 0.2519 },
    queen:  { frequency: 0.4693 },
    jack:   { frequency: 0.2486 },
    ten:    { frequency: 0.1392 },
  },
};
export const FREQUENCY_REELS = [FREQUENCY_REEL1, FREQUENCY_REEL2, FREQUENCY_REEL3, FREQUENCY_REEL4, FREQUENCY_REEL5];
export const REEL_STRIPS = FREQUENCY_REELS.map((freqTable, i) => generateReel(freqTable, REEL_LENGTH, REEL_SEEDS[i], [], 3, PAYTABLE));

const winEvaluator = (grid) => checkLineCascadeWins(grid, PAYTABLE, 'gold', SCATTER_TRIGGER_COUNT, PAYLINES, null);

let canvas, btnSpin, btnAuto, btnTurbo, btnMute, btnPaytable, btnPaytableOk;
let displayBalance, betValue, betMinus, betPlus, gameTicker;
let btnSpinLog, btnSim, btnTune, simModal, tuningPanel, spinLogPanel, simStats;
let simRtpDisplay, simTotalSpinsDisplay, simMaxWinDisplay, simFreeSpinsDisplay;
let modalPaytable, modalFsTrigger, modalFsSummary, btnStartFs, btnCloseFsSummary, fsAwardAmount;
let fsPanel, fsCounter, fsTotalWin;
let cheatScatter;

const DEBUG_MODE = true;

let engine = null;
let pendingFreeSpinsAward = 0;
const GAME_ASSET_MANIFEST = {
  symbols: { url: './assets/mayan/mayan.tiles.json', type: 'tilemap' },
  stoneExplode: { url: './assets/sprites/stone_explode.json', type: 'sprite' },
  music: { url: './assets/music/mayan_tumble_theme.mp3', type: 'music' },
};

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
  const developerPanels = ensureDeveloperPanels();
  simModal = developerPanels.simulation;
  tuningPanel = developerPanels.tuning;
  spinLogPanel = developerPanels.spinLog;
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
      openSpinLogPanel({ engine, domRefs: { panel: spinLogPanel } });
    });
  }
  if (btnSim) {
    btnSim.addEventListener('click', () => {
      runSimulationAndRender({
        engine,
        paytable: PAYTABLE,
        betPerLine: BET_AMOUNT / PAYLINES.length,
        linesCount: PAYLINES.length,
        numSpins: 1000000,
        labels: CascadeSpinMechanic.statsLabels,
        domRefs: { btnSim, simModal, simStats, simRtpDisplay, simTotalSpinsDisplay, simMaxWinDisplay, simFreeSpinsDisplay },
      });
    });
  }
  if (btnTune) {
    btnTune.addEventListener('click', () => {
      openTuningPanel({
        paytable: PAYTABLE,
        reelFrequencyTables: FREQUENCY_REELS,
        tuneConfig: {
          reelsCount: REELS_COUNT,
          rowsCount: ROWS_COUNT,
          scatterSymbol: 'gold',
          reelSeeds: REEL_SEEDS,
          betPerLine: BET_AMOUNT / PAYLINES.length,
          linesCount: PAYLINES.length,
          // Not optional here the way it is for a cluster game. Trials run in Worker threads, and
          // a closure cannot cross postMessage - the worker rebuilds this game's evaluator from
          // `winEvaluatorName` plus whatever primitives the config carries (see
          // core/simulation/workerMechanicRegistry.js). checkLineCascadeWins is a LINE evaluator, so without the
          // paylines themselves it has nothing to evaluate against.
          paylines: PAYLINES,
          wildSymbol: null,
          reelLength: REEL_LENGTH,
          mechanic: CascadeSpinMechanic,
          freeSpinsMode: engine.config.freeSpinsMode,
          winEvaluatorName: 'checkLineCascadeWins',
          winEvaluatorFactory: (pt) => (grid) => checkLineCascadeWins(grid, pt, 'gold', SCATTER_TRIGGER_COUNT, PAYLINES, null),
          minClusterSize: 3, // dummy required param
          scatterTriggerCount: SCATTER_TRIGGER_COUNT,
          freeSpinsCount: FREE_SPINS_AWARD,
          triggerRatePenaltyWeight: 0.1,
          reelCoupling: 'linked-then-refine',
        },
        panel: tuningPanel,
      });
    });
  }

  const renderer = new SlotRenderer();
  const particleSystem = new ParticleSystem();
  engine = new CoreSlotEngine(canvas, {
    mechanic: CascadeSpinMechanic,
    renderer,
    particleSystem,
    animator: new CascadeDropAnimator(renderer, particleSystem, {
      normalClearDurationMs: 1730,
      turboClearDurationMs: 900,
    }),
    spinLogRecorder: new SpinLogRecorder({ betAmount: BET_AMOUNT, scatterSymbol: 'gold' }),
    audioController: new AudioController(),

    reelsCount: REELS_COUNT,
    rowsCount: ROWS_COUNT,
    paytable: PAYTABLE,
    reelStrips: REEL_STRIPS,
    paylines: PAYLINES,
    // All paylines are evaluated against the same settled grid. Show their paths one at a time,
    // then explode the union of their winning cells together before the next tumble.
    cascadeWinClearMode: 'all-at-once',
    cascadeWinPreviewDurationMs: 500,
    clearEffect: {
      asset: 'stoneExplode',
      animation: 'stone_explode',
      shrinkFade: { fadePower: 1.6, minimumScale: 0.08 },
      startScale: 0.55,
      endScale: 1.3,
      progressMultiplier: 1.35,
      fadeInMultiplier: 10,
      fadeOutMultiplier: 0.3,
    },
    // Stone and jungle rather than the engine's default candy pink-on-purple, which is Candy
    // Frenzy's look and was showing through under this game's art. No ruled cells: this is a
    // payline game, so a win is a path across the grid rather than a shape made of cells, and the
    // lines only made the playfield look like a spreadsheet. The grain replaces them - it gives
    // the surface something to be without drawing anything the player has to read.
    playfield: {
      backdropInner: '#16281c',
      backdropOuter: '#050c07',
      outline: '#dfb239',
      outlineWidth: 1,
      outlineGlow: 1,
      outlineGlowIntensity: 1,
      frame: '#0b120d',
      gridLines: null,
      background: { type: "color", color: "#0303039a" },
      loadingBackground: '#0a1410',
      loadingColor: '#dfb239',
      loadingText: 'ENTERING THE TEMPLE...',
    },
    // Full-canvas backdrop (see SlotRenderer.drawViewportBackground) - top-level, not nested in
    // `playfield` above, since it's a whole-canvas concept rather than a reels-theme one (unlike
    // `playfield.background`, which SlotRenderer does read nested).
    viewportBackground: { type: "image", image: "./assets/backgrounds/mayan_tumble_background_alt.png" },
    winEvaluator,
    scatterSymbol: 'gold',
    freeSpinsMode: createMultiplierTilesMode({ badgeStyle: 'background', renderOrder: 'behind' }),
    clearCellHighlight: false,
    assetManifest: GAME_ASSET_MANIFEST,
    betAmount: BET_AMOUNT,
    onStateChange: (state) => updateSlotStateUI({ engine, state, refs: { spin: btnSpin, ticker: gameTicker }, onUpdate: updateUI, messages: {
      stopping: 'STOPPING...', dropping_in: 'TUMBLING IN...', falling: 'CASCADING...', clearing: 'MAYAN WIN!',
      showing_wins: game => `WIN: $${game.lastWin.toFixed(2)}!`, free_spins_intro: 'TEMPLE BONUS TRIGGER!',
      game_over: 'BONUS ROUND COMPLETE!', idle: 'TEMPLE OF GOLD',
    }, onGameOver: handleFreeSpinsComplete }),
    onScatterTrigger: (scatterCount, isInFreeSpins) => handleScatterTrigger(scatterCount, isInFreeSpins),
  });
  await engine.init();

  updateUI();
  bindCommonSlotControls({ getEngine: () => engine, onUpdate: updateUI, betStep: BET_STEP, betMax: BET_MAX, linesMax: PAYLINES.length });
  observeSlotViewport();
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

function handleScatterTrigger(scatterCount, isInFreeSpins) {
  if (isInFreeSpins) {
    engine.retriggerFreeSpins(FREE_SPINS_AWARD);
    gameTicker.textContent = `+${FREE_SPINS_AWARD} EXTRA FREE SPINS!`;
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
    if (engine.state !== 'idle' && engine.state !== 'showing_wins') engine.stopSpin();
    else engine.requestSpin();
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
  renderLinePaytable({ container: document.getElementById('paytable-grid-content'), paytable: PAYTABLE, paylines: PAYLINES, reelsCount: REELS_COUNT, assets: engine?.assets, scatterTriggerCount: SCATTER_TRIGGER_COUNT, freeSpinsAward: FREE_SPINS_AWARD });
}

if (typeof window !== 'undefined') {
  window.addEventListener('load', initGame);
}
