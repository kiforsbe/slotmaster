// Game Coordinator for Bar Fruits Slot Machine
import { CoreSlotEngine } from '../../core/engine/CoreSlotEngine.js';
import { LineMechanic } from '../../core/engine/mechanics/LineMechanic.js';
import { ReelScrollAnimator } from '../../core/engine/animators/ReelScrollAnimator.js';
import { SlotRenderer } from '../../core/rendering/SlotRenderer.js';
import { SpinLogRecorder } from '../../core/engine/SpinLogRecorder.js';
import { AudioController } from '../../core/engine/AudioController.js';
import { generateReel } from '../../core/math/SlotMath.js';
import { runSimulationAndRender } from '../../core/SimulationPanel.js';
import { openTuningPanel } from '../../core/TuningPanel.js';
import { openSpinLogPanel } from '../../core/SpinLogPanel.js';
import { bindCommonSlotControls, observeSlotViewport, updateSlotStateUI } from '../../core/ui/SlotGameUI.js';
import { ensureDeveloperPanels } from '../../core/ui/DeveloperPanels.js';
import { renderLinePaytable } from '../../core/ui/PaytableRenderer.js';

// Grid/reel parameters shared by the live game, the RUN SIMULATION button, and the
// frequency tuner - a single source of truth so all three actually model the same reels
// instead of the simulation/tuner silently drifting onto their own hardcoded defaults.
export const REELS_COUNT = 5;
export const ROWS_COUNT = 3;
export const REEL_SEEDS = [4231, 8765, 123, 9981, 5567];
export const BET_PER_LINE = 0.10;
export const BET_PER_LINE_STEP = 0.10;
export const BET_PER_LINE_MAX = 10;
export const LINES_COUNT = 10;

// Payline definitions - 5 reels x 3 rows, the standard 10-line template for this grid size
// (see docs/PAYLINES-TEMPLATES.md's "5x3 playfield" - same lines as bookbookbook's).
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
  [0, 1, 0, 1, 0], // Line 10: Zigzag
];

// Paytable. No wild - only a scatter (`star`, pays anywhere, triggers free spins) plus 10
// regular line-pay symbols split into premiums (the bar ladder, clover, bell) and normals
// (fruits). Frequencies are ordered so premiums are rarer than normals, then re-tuned via
// TUNE FREQUENCIES to hit target RTP, same workflow as fruitmachine/bookbookbook.
// payout[i] is the payout for (i+1) matching symbols, left-to-right from reel 1 (index 0/1
// unused here - nothing pays on 1 or 2 of a kind in this paytable).
export const PAYTABLE = {
  bar_triple: { payout: [0, 0, 30, 300, 1200], type: 'premium', friendlyName: 'Triple Bar' },
  bar_double: { payout: [0, 0, 20, 400,  800], type: 'premium', friendlyName: 'Double Bar' },
  bar:        { payout: [0, 0, 10, 200,  400], type: 'premium', friendlyName: 'Single Bar' },
  bell:       { payout: [0, 0, 20,  40,  200], type: 'premium', friendlyName: 'Golden Bell' },
  clover:     { payout: [0, 0, 15,  50,  150], type: 'premium', friendlyName: 'Lucky Clover' },
  strawberry: { payout: [0, 0, 10,  30,  100], type: 'regular', friendlyName: 'Strawberry' },
  plum:       { payout: [0, 0,  8,  25,   80], type: 'regular', friendlyName: 'Plum' },
  grapes:     { payout: [0, 0,  6,  20,   60], type: 'regular', friendlyName: 'Grapes' },
  orange:     { payout: [0, 0,  5,  15,   50], type: 'regular', friendlyName: 'Orange' },
  melon:      { payout: [0, 0,  4,  12,   40], type: 'regular', friendlyName: 'Watermelon' },
  star:       { payout: [0, 8, 20,  40,  800], type: 'scatter', paymode: 'any', wild: false, triggerFreeSpins: true, friendlyName: 'Star' },
};

// ---- Tuned 2026-07-27 ----
// Achieved: RTP 96.38%  |  free-spin trigger 0.56%
//
// To reproduce this exact run, the tuner needs all of the following - same searchSeed AND
// same reel geometry, since strips are generated from them:
//   searchSeed 12345   reelSeeds [4231, 8765, 123, 9981, 5567]
//   reelLength 500   reels 5 x 3 rows
//   target RTP 96% +/-1.5   target trigger 0.6% +/-0.15
//   300,000 spins x 2 trials   cmaes, max 150 iterations
//   initial weights: provided   max RTP std error 1
//   loss weights: ordering 0.5, limit 5, uniformity 5, stdError 5, triggerRate 0, spacing 0
//   ordering bias by reel: [0.25, 0.25, -0.5, 0, 0]
//
// REEL_LENGTH is part of the result, not a separate setting - these frequencies were tuned
// against this length and do not reproduce the RTP above at any other.
export const REEL_LENGTH = 500;

export const FREQUENCY_REEL1 = {
  defaults: { minFrequency: 0.1, maxFrequency: 1 },
  symbols: {
    bar_triple: { frequency: 0.9139 },
    bar_double: { frequency: 0.7212 },
    bar:        { frequency: 0.563 },
    bell:       { frequency: 0.6001 },
    clover:     { frequency: 0.6131 },
    strawberry: { frequency: 0.4322 },
    plum:       { frequency: 0.4125 },
    grapes:     { frequency: 0.2768 },
    orange:     { frequency: 0.06278 },
    melon:      { frequency: 0.4042 },
    star:       { frequency: 0.1422, minGap: 3, maxStack: 1 },
  },
};

export const FREQUENCY_REEL2 = {
  defaults: { minFrequency: 0.1, maxFrequency: 1 },
  symbols: {
    bar_triple: { frequency: 0.832 },
    bar_double: { frequency: 0.9866 },
    bar:        { frequency: 0.5828 },
    bell:       { frequency: 0.5056 },
    clover:     { frequency: 0.1259 },
    strawberry: { frequency: 0.4292 },
    plum:       { frequency: 0.4501 },
    grapes:     { frequency: 0.37 },
    orange:     { frequency: 0.3346 },
    melon:      { frequency: 0.3828 },
    star:       { frequency: 0.1422, minGap: 3, maxStack: 1 },
  },
};

export const FREQUENCY_REEL3 = {
  defaults: { minFrequency: 0.1, maxFrequency: 1 },
  symbols: {
    bar_triple: { frequency: 0.2879 },
    bar_double: { frequency: 0.4905 },
    bar:        { frequency: 0.3253 },
    bell:       { frequency: 0.3815 },
    clover:     { frequency: 0.6043 },
    strawberry: { frequency: 0.4987 },
    plum:       { frequency: 0.2632 },
    grapes:     { frequency: 0.6582 },
    orange:     { frequency: 0.6322 },
    melon:      { frequency: 0.8585 },
    star:       { frequency: 0.1422, minGap: 3, maxStack: 1 },
  },
};

export const FREQUENCY_REEL4 = {
  defaults: { minFrequency: 0.1, maxFrequency: 1 },
  symbols: {
    bar_triple: { frequency: 0.4984 },
    bar_double: { frequency: 0.5559 },
    bar:        { frequency: 0.8577 },
    bell:       { frequency: 0.7165 },
    clover:     { frequency: 0.5438 },
    strawberry: { frequency: 0.4777 },
    plum:       { frequency: 0.4677 },
    grapes:     { frequency: 0.1538 },
    orange:     { frequency: 0.01323 },
    melon:      { frequency: 0.7154 },
    star:       { frequency: 0.1422, minGap: 3, maxStack: 1 },
  },
};

export const FREQUENCY_REEL5 = {
  defaults: { minFrequency: 0.1, maxFrequency: 1 },
  symbols: {
    bar_triple: { frequency: 0.6301 },
    bar_double: { frequency: 0.4208 },
    bar:        { frequency: 0.5283 },
    bell:       { frequency: 4.874e-9 },
    clover:     { frequency: 0.7544 },
    strawberry: { frequency: 0.5453 },
    plum:       { frequency: 0.5708 },
    grapes:     { frequency: 0.4833 },
    orange:     { frequency: 0.4117 },
    melon:      { frequency: 0.6553 },
    star:       { frequency: 0.1422, minGap: 3, maxStack: 1 },
  },
};

const FREQUENCY_REELS = [FREQUENCY_REEL1, FREQUENCY_REEL2, FREQUENCY_REEL3, FREQUENCY_REEL4, FREQUENCY_REEL5];

// How many free spins a scatter trigger awards, by scatter count: 3 = 10 (the base award),
// 4 = +5 more (15 total), 5 = +10 more again (20 total). Used identically whether this is
// the initial trigger or a retrigger during free spins - there's no separate "plain old
// free spins" mechanic here, just this same count -> award lookup every time 3+ land.
const FREE_SPINS_AWARD = { 3: 10, 4: 15, 5: 20 };
function awardedFreeSpinsFor(scatterCount) {
  return FREE_SPINS_AWARD[scatterCount] || (scatterCount * 5);
}

// PAYTABLE is passed as the 6th arg so generateReel's default minGap fallback can read
// PAYTABLE.star.triggerFreeSpins (not used here since star's minGap is set explicitly above,
// but kept for consistency with fruitmachine/bookbookbook - see generateReel's own doc in
// core/SlotMath.js).
export const REEL_STRIPS = FREQUENCY_REELS.map((freqTable, i) => generateReel(freqTable, REEL_LENGTH, REEL_SEEDS[i], [], 3, PAYTABLE));

// UI Dom Selectors - initialized in load handler
let canvas, btnSpin, btnAuto, btnTurbo, btnMute, btnPaytable, btnPaytableOk;
let displayBalance, betValue, betMinus, betPlus, gameTicker;
let displayTotalBet, linesValue, linesMinus, linesPlus;
let btnSim, simModal, tuningPanel, spinLogPanel, btnTune, simStats, btnSpinLog;
let simRtpDisplay, simTotalSpinsDisplay, simMaxWinDisplay, simFreeSpinsDisplay;
let modalPaytable, modalFsTrigger, modalFsSummary, btnStartFs, btnCloseFsSummary, fsAwardAmount;
let fsPanel, fsCounter, fsTotalWin;
let cheatScatter, cheatBigWin;

// Debug mode - only enable cheat buttons in development
const DEBUG_MODE = true; // Set to false in production

let engine = null;
let pendingFreeSpinsAward = 0;
const GAME_ASSET_MANIFEST = {
  symbols: { url: './assets/fruitmachine_1/fruitmachine_1.tiles.json', type: 'tilemap' },
  music: { url: './assets/music/barfruits_theme.mp3', type: 'music' },
};

async function initGame() {
  // Initialize all DOM references
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
  displayTotalBet = document.getElementById('display-total-bet');
  linesValue = document.getElementById('lines-value');
  linesMinus = document.getElementById('lines-minus');
  linesPlus = document.getElementById('lines-plus');
  gameTicker = document.getElementById('game-ticker');

  btnSim = document.getElementById('btn-sim');
  btnTune = document.getElementById('btn-tune');
  btnSpinLog = document.getElementById('btn-spinlog');
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
  cheatBigWin = document.getElementById('cheat-bigwin');

  const debugShortcuts = document.querySelector('.debug-shortcuts');
  if (debugShortcuts && DEBUG_MODE) {
    debugShortcuts.classList.add('debug-enabled');
  }

  // Setup Simulation Handlers
  if (btnSim) {
    btnSim.addEventListener('click', () => {
      runSimulationAndRender({
        engine,
        paytable: PAYTABLE,
        betPerLine: BET_PER_LINE,
        linesCount: LINES_COUNT,
        numSpins: 1000000,
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
          paylines: PAYLINES,
          scatterSymbol: 'star',
          reelSeeds: REEL_SEEDS,
          betPerLine: BET_PER_LINE,
          linesCount: LINES_COUNT,
          reelLength: REEL_LENGTH,
          // Same award schedule real play uses for both the initial trigger and any
          // retrigger (see FREE_SPINS_AWARD above) - without this, tuned RTP estimates were
          // missing the entire retrigger mechanic and always assumed a flat 10-spin award
          // (undercounting 4/5-scatter triggers), which is why a tune's reported RTP could
          // land noticeably lower than what running the real award schedule actually pays out.
          freeSpinsAwardTable: FREE_SPINS_AWARD,
          retriggerFreeSpinsAwardTable: FREE_SPINS_AWARD,
        },
        panel: tuningPanel,
      });
    });
  }
  if (btnSpinLog) {
    btnSpinLog.addEventListener('click', () => {
      openSpinLogPanel({ engine, domRefs: { panel: spinLogPanel } });
    });
  }

  // Create slot engine instance
  const renderer = new SlotRenderer();
  engine = new CoreSlotEngine(canvas, {
    mechanic: LineMechanic,
    animator: new ReelScrollAnimator(renderer),
    renderer,
    spinLogRecorder: new SpinLogRecorder({ betPerLine: BET_PER_LINE, linesCount: LINES_COUNT, scatterSymbol: 'star' }),
    audioController: new AudioController(),

    reelsCount: REELS_COUNT,
    rowsCount: ROWS_COUNT,
    paytable: PAYTABLE,
    reelStrips: REEL_STRIPS,
    paylines: PAYLINES,
    wildSymbol: null,
    scatterSymbol: 'star',
    assetManifest: GAME_ASSET_MANIFEST,
    viewportBackground: { type: "image", image: "./assets/backgrounds/barfruits_background_1.png" },
    betPerLine: BET_PER_LINE,
    linesCount: LINES_COUNT,
    // Read by engine.runSimulation() (-> simulateSpins) so the RUN SIMULATION dev tool
    // matches this game's real award schedule (see FREE_SPINS_AWARD above) instead of the
    // simulator's generic flat-10-no-retrigger default.
    freeSpinsAwardTable: FREE_SPINS_AWARD,
    retriggerFreeSpinsAwardTable: FREE_SPINS_AWARD,

    onStateChange: (state) => updateSlotStateUI({ engine, state, refs: { spin: btnSpin, ticker: gameTicker }, onUpdate: updateUI, messages: {
      spinning: 'SPINNING...', stopping: 'STOPPING...', showing_wins: game => `WIN: $${game.lastWin.toFixed(2)}!`,
      free_spins_intro: 'SCATTER TRIGGER!', game_over: 'FREE SPINS COMPLETE!', idle: 'IDLE',
    }, onGameOver: handleFreeSpinsComplete }),
    onScatterTrigger: (scatterCount, isInFreeSpins) => handleScatterTrigger(scatterCount, isInFreeSpins),
  });
  await engine.init();

  updateUI();
  bindCommonSlotControls({ getEngine: () => engine, onUpdate: updateUI, betStep: BET_PER_LINE_STEP, betMax: BET_PER_LINE_MAX, linesMax: LINES_COUNT });
  observeSlotViewport();
  setupUIHandlers();
  buildPaytableContent();
}

function updateUI() {
  if (!engine) return;
  displayBalance.textContent = `$${engine.balance.toFixed(2)}`;
  betValue.textContent = engine.betPerLine.toFixed(2);
  linesValue.textContent = `${engine.linesCount} / ${LINES_COUNT}`;
  displayTotalBet.textContent = `$${engine.totalBet.toFixed(2)}`;

  if (engine.inFreeSpins) {
    fsPanel.classList.add('active');
    fsCounter.textContent = `FREE SPINS: ${engine.freeSpinsRemaining} / ${engine.freeSpinsTotal}`;
  } else {
    fsPanel.classList.remove('active');
  }
}

// Free spins orchestration - game code decides everything, SlotEngine only provides the
// mechanism (enterFreeSpins/retriggerFreeSpins/exitFreeSpins). Unlike bookbookbook, there's
// no expanding symbol here: enterFreeSpins is called with expandingSymbol = null, so free
// spins are "plain" - same win math as the base game, just no bet deducted per spin.
function handleScatterTrigger(scatterCount, isInFreeSpins) {
  const awarded = awardedFreeSpinsFor(scatterCount);

  if (isInFreeSpins) {
    engine.retriggerFreeSpins(awarded);
    gameTicker.textContent = `+${awarded} EXTRA SPINS!`;
    engine.audio.playScatterTrigger();
    updateUI();
    return;
  }

  pendingFreeSpinsAward = awarded;
  engine.enterFreeSpinsIntro();
  fsAwardAmount.textContent = awarded;
  modalFsTrigger.classList.add('active');
  engine.audio.playScatterTrigger();
}

function startFreeSpins() {
  modalFsTrigger.classList.remove('active');
  engine.enterFreeSpins(pendingFreeSpinsAward, null);
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
    if (engine.betPerLine > BET_PER_LINE_STEP + 1e-9) {
      engine.betPerLine = Math.round((engine.betPerLine - BET_PER_LINE_STEP) * 100) / 100;
      engine.updateBet();
      updateUI();
    }
  });

  betPlus.addEventListener('click', () => {
    if (engine.state !== 'idle' && engine.state !== 'showing_wins') return;
    const newBetPerLine = Math.round((engine.betPerLine + BET_PER_LINE_STEP) * 100) / 100;
    const newTotalBet = newBetPerLine * engine.linesCount;
    if (newBetPerLine <= BET_PER_LINE_MAX + 1e-9 && engine.balance >= newTotalBet) {
      engine.betPerLine = newBetPerLine;
      engine.updateBet();
      updateUI();
    }
  });

  linesMinus.addEventListener('click', () => {
    if (engine.state !== 'idle' && engine.state !== 'showing_wins') return;
    if (engine.linesCount > 1) {
      engine.linesCount--;
      engine.updateBet();
      updateUI();
    }
  });

  linesPlus.addEventListener('click', () => {
    if (engine.state !== 'idle' && engine.state !== 'showing_wins') return;
    const newLinesCount = engine.linesCount + 1;
    const newTotalBet = engine.betPerLine * newLinesCount;
    if (newLinesCount <= LINES_COUNT && engine.balance >= newTotalBet) {
      engine.linesCount = newLinesCount;
      engine.updateBet();
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
  // spins trigger/summary) and the shared #sim-modal (RUN SIMULATION/TUNE FREQUENCIES/SPIN
  // LOG), which toggles via inline display instead of the .active class.
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

  if (DEBUG_MODE) {
    if (cheatScatter) cheatScatter.addEventListener('click', () => engine.forceWinResult('scatter'));
    if (cheatBigWin) cheatBigWin.addEventListener('click', () => engine.forceWinResult('bigwin'));
  }
}

// Renders the modal paytable descriptions and payline previews dynamically
function buildPaytableContent() {
  renderLinePaytable({ container: document.getElementById('paytable-grid-content'), paytable: PAYTABLE, paylines: PAYLINES, reelsCount: REELS_COUNT, assets: engine?.assets, scatterTriggerCount: 3, freeSpinsAward: 10, paylinePreviewContainer: document.getElementById('paylines-preview') });
}

// Guarded so this module can be imported under Node (e.g. by tests) without a DOM.
if (typeof window !== 'undefined') {
  window.addEventListener('load', initGame);
}
