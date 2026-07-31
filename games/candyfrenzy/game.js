// Game coordinator for Candy Frenzy - a 7x7 cluster-pays cascading slot.
import { CoreSlotEngine } from '../../core/engine/CoreSlotEngine.js';
import { CascadeDropAnimator } from '../../core/engine/animators/CascadeDropAnimator.js';
import { SlotRenderer } from '../../core/rendering/SlotRenderer.js';
import { ParticleSystem } from '../../core/rendering/ParticleSystem.js';
import { SpinLogRecorder } from '../../core/engine/SpinLogRecorder.js';
import { AudioController } from '../../core/engine/AudioController.js';
import { generateReel } from '../../core/math/SlotMath.js';
import { checkClusterWins } from '../../core/math/ClusterMath.js';
import { openSpinLogPanel } from '../../core/SpinLogPanel.js';
import { bindCommonSlotControls, observeSlotViewport, updateSlotStateUI } from '../../core/ui/SlotGameUI.js';
import { renderClusterPaytable } from '../../core/ui/PaytableRenderer.js';
import { createMultiplierTilesMode } from '../../core/engine/FreeSpinsModes.js';
import { CascadeSpinMechanic } from '../../core/engine/mechanics/CascadeSpinMechanic.js';
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

// 11 breakpoints since a cluster can run all the way up to 49 cells on this 7x7 grid - not a
// small fixed count like a payline game's payout[i] array. The top tier is "15+": every cluster
// from 15 cells to the full 49 pays the same, so the ladder does not need a tier per size.
//
// Every symbol carries its OWN ladder rather than sharing one of two group ladders. That makes
// the seven symbols strictly ranked by payout (cottoncandy 300x down to chocolate 40x) where
// they used to be two tied groups of three and four, and symbol ranking is exactly what the
// tuner's ordering preference reads - see checkPayoutLadders in core/TuningValidation.js, which
// ranks on the LAST tier only.
const COTTONCANDY_PAYOUT = [
  { min:  5, multiplier:   2.00 },
  { min:  6, multiplier:   3.00 },
  { min:  7, multiplier:   3.00 },
  { min:  8, multiplier:   3.50 },
  { min:  9, multiplier:   4.00 },
  { min: 10, multiplier:  10.00 },
  { min: 11, multiplier:  15.00 },
  { min: 12, multiplier:  30.00 },
  { min: 13, multiplier:  70.00 },
  { min: 14, multiplier: 140.00 },
  { min: 15, multiplier: 300.00 },
];
const GUM_PAYOUT = [
  { min:  5, multiplier:   1.50 },
  { min:  6, multiplier:   2.00 },
  { min:  7, multiplier:   2.00 },
  { min:  8, multiplier:   2.50 },
  { min:  9, multiplier:   4.00 },
  { min: 10, multiplier:   8.00 },
  { min: 11, multiplier:  12.00 },
  { min: 12, multiplier:  25.00 },
  { min: 13, multiplier:  60.00 },
  { min: 14, multiplier: 120.00 },
  { min: 15, multiplier: 200.00 },
];
const CAKE_PAYOUT = [
  { min:  5, multiplier:   1.00 },
  { min:  6, multiplier:   1.50 },
  { min:  7, multiplier:   1.50 },
  { min:  8, multiplier:   2.00 },
  { min:  9, multiplier:   2.50 },
  { min: 10, multiplier:   6.00 },
  { min: 11, multiplier:   9.00 },
  { min: 12, multiplier:  20.00 },
  { min: 13, multiplier:  40.00 },
  { min: 14, multiplier:  80.00 },
  { min: 15, multiplier: 120.00 },
];
const MINT_PAYOUT = [
  { min:  5, multiplier:   0.80 },
  { min:  6, multiplier:   1.00 },
  { min:  7, multiplier:   1.50 },
  { min:  8, multiplier:   2.00 },
  { min:  9, multiplier:   2.50 },
  { min: 10, multiplier:   4.00 },
  { min: 11, multiplier:   6.00 },
  { min: 12, multiplier:  10.00 },
  { min: 13, multiplier:  20.00 },
  { min: 14, multiplier:  40.00 },
  { min: 15, multiplier:  80.00 },
];
const GUMMY_PAYOUT = [
  { min:  5, multiplier:   0.60 },
  { min:  6, multiplier:   0.60 },
  { min:  7, multiplier:   0.80 },
  { min:  8, multiplier:   1.50 },
  { min:  9, multiplier:   2.00 },
  { min: 10, multiplier:   3.00 },
  { min: 11, multiplier:   5.00 },
  { min: 12, multiplier:   8.00 },
  { min: 13, multiplier:  16.00 },
  { min: 14, multiplier:  30.00 },
  { min: 15, multiplier:  60.00 },
];
const BEAN_PAYOUT = [
  { min:  5, multiplier:   0.50 },
  { min:  6, multiplier:   0.60 },
  { min:  7, multiplier:   0.80 },
  { min:  8, multiplier:   1.00 },
  { min:  9, multiplier:   1.50 },
  { min: 10, multiplier:   2.50 },
  { min: 11, multiplier:   4.00 },
  { min: 12, multiplier:   6.00 },
  { min: 13, multiplier:  12.00 },
  { min: 14, multiplier:  24.00 },
  { min: 15, multiplier:  50.00 },
];
const CHOCOLATE_PAYOUT = [
  { min:  5, multiplier:   0.40 },
  { min:  6, multiplier:   0.50 },
  { min:  7, multiplier:   0.60 },
  { min:  8, multiplier:   0.80 },
  { min:  9, multiplier:   1.00 },
  { min: 10, multiplier:   2.00 },
  { min: 11, multiplier:   3.00 },
  { min: 12, multiplier:   5.00 },
  { min: 13, multiplier:  10.00 },
  { min: 14, multiplier:  20.00 },
  { min: 15, multiplier:  40.00 },
];

// chest, clover, and wild exist in the art but are unused in v1 - excluded here entirely,
// so they never appear on a reel or in the paytable.
export const PAYTABLE = {
  cottoncandy: { type: 'premium', clusterPayout: COTTONCANDY_PAYOUT, friendlyName: 'Cotton Candy' },
  gum:         { type: 'premium', clusterPayout: GUM_PAYOUT,         friendlyName: 'Bubble Gum' },
  cake:        { type: 'premium', clusterPayout: CAKE_PAYOUT,        friendlyName: 'Cake' },
  mint:        { type: 'regular', clusterPayout: MINT_PAYOUT,        friendlyName: 'Mint' },
  gummy:       { type: 'regular', clusterPayout: GUMMY_PAYOUT,       friendlyName: 'Gummy' },
  bean:        { type: 'regular', clusterPayout: BEAN_PAYOUT,        friendlyName: 'Jelly Bean' },
  chocolate:   { type: 'regular', clusterPayout: CHOCOLATE_PAYOUT,   friendlyName: 'Chocolate' },
  bonus:       { type: 'scatter', paymode: 'any', triggerFreeSpins: true, friendlyName: 'Bonus' },
};

// ---- Tuned 2026-07-27 ----
// Achieved: RTP 96.17%  |  free-spin trigger 0.439%
//
// To reproduce this exact run, the tuner needs all of the following - same searchSeed AND
// same reel geometry, since strips are generated from them:
//   searchSeed 12345   reelSeeds [101, 202, 303, 404, 505, 606, 707]
//   reelLength 500   reels 7 x 7 rows
//   target RTP 96% +/-1.5   target trigger 0.5% +/-0.15
//   250,000 spins x 2 trials   cmaes, max 50 iterations
//   initial weights: uniform   max RTP std error 1
//   reelCoupling linked   maxReelDeviation 0.25
//   loss weights (normalized): ordering 1, limit 1, uniformity 1, stdError 0, triggerRate 1, spacing 1
//   ordering bias by reel: [0, 0, 0, 0, 0, 0, 0]
//
// REEL_LENGTH is part of the result, not a separate setting - these frequencies were tuned
// against this length and do not reproduce the RTP above at any other.
export const REEL_LENGTH = 500;

export const FREQUENCY_REEL1 = {
  defaults: { minGap: 2, maxStack: 3, minStack: 2, stackChance: 0.15, minFrequency: 0.005, maxFrequency: 0.5 },
  symbols: {
    cottoncandy: { frequency: 0.0573 },
    gum:         { frequency: 0.0542 },
    cake:        { frequency: 0.1067 },
    mint:        { frequency: 0.0684 },
    gummy:       { frequency: 0.08297 },
    bean:        { frequency: 0.08209 },
    chocolate:   { frequency: 0.06583 },
    bonus:       { frequency: 0.003908, minGap: 8, maxStack: 1, minStack: 1, maxFrequency: 0.025 },
  },
};

export const FREQUENCY_REEL2 = {
  defaults: { minGap: 2, maxStack: 3, minStack: 2, stackChance: 0.15, minFrequency: 0.005, maxFrequency: 0.5 },
  symbols: {
    cottoncandy: { frequency: 0.05731 },
    gum:         { frequency: 0.0542 },
    cake:        { frequency: 0.1067 },
    mint:        { frequency: 0.06841 },
    gummy:       { frequency: 0.08298 },
    bean:        { frequency: 0.0821 },
    chocolate:   { frequency: 0.06583 },
    bonus:       { frequency: 0.002926, minGap: 8, maxStack: 1, minStack: 1, maxFrequency: 0.025 },
  },
};

export const FREQUENCY_REEL3 = {
  defaults: { minGap: 2, maxStack: 3, minStack: 2, stackChance: 0.15, minFrequency: 0.005, maxFrequency: 0.5 },
  symbols: {
    cottoncandy: { frequency: 0.03184 },
    gum:         { frequency: 0.03011 },
    cake:        { frequency: 0.05929 },
    mint:        { frequency: 0.03801 },
    gummy:       { frequency: 0.0461 },
    bean:        { frequency: 0.04561 },
    chocolate:   { frequency: 0.03658 },
    bonus:       { frequency: 0.003271, minGap: 8, maxStack: 1, minStack: 1, maxFrequency: 0.025 },
  },
};

export const FREQUENCY_REEL4 = {
  defaults: { minGap: 2, maxStack: 3, minStack: 2, stackChance: 0.15, minFrequency: 0.005, maxFrequency: 0.5 },
  symbols: {
    cottoncandy: { frequency: 0.05729 },
    gum:         { frequency: 0.05418 },
    cake:        { frequency: 0.1067 },
    mint:        { frequency: 0.06839 },
    gummy:       { frequency: 0.08295 },
    bean:        { frequency: 0.08208 },
    chocolate:   { frequency: 0.06581 },
    bonus:       { frequency: 0.002925, minGap: 8, maxStack: 1, minStack: 1, maxFrequency: 0.025 },
  },
};

export const FREQUENCY_REEL5 = {
  defaults: { minGap: 2, maxStack: 3, minStack: 2, stackChance: 0.15, minFrequency: 0.005, maxFrequency: 0.5 },
  symbols: {
    cottoncandy: { frequency: 0.0573 },
    gum:         { frequency: 0.05419 },
    cake:        { frequency: 0.1067 },
    mint:        { frequency: 0.0684 },
    gummy:       { frequency: 0.08296 },
    bean:        { frequency: 0.08209 },
    chocolate:   { frequency: 0.06582 },
    bonus:       { frequency: 0.002925, minGap: 8, maxStack: 1, minStack: 1, maxFrequency: 0.025 },
  },
};

export const FREQUENCY_REEL6 = {
  defaults: { minGap: 2, maxStack: 3, minStack: 2, stackChance: 0.15, minFrequency: 0.005, maxFrequency: 0.5 },
  symbols: {
    cottoncandy: { frequency: 0.05731 },
    gum:         { frequency: 0.0542 },
    cake:        { frequency: 0.1067 },
    mint:        { frequency: 0.06841 },
    gummy:       { frequency: 0.08298 },
    bean:        { frequency: 0.0821 },
    chocolate:   { frequency: 0.06583 },
    bonus:       { frequency: 0.002926, minGap: 8, maxStack: 1, minStack: 1, maxFrequency: 0.025 },
  },
};

export const FREQUENCY_REEL7 = {
  defaults: { minGap: 2, maxStack: 3, minStack: 2, stackChance: 0.15, minFrequency: 0.005, maxFrequency: 0.5 },
  symbols: {
    cottoncandy: { frequency: 0.05731 },
    gum:         { frequency: 0.0542 },
    cake:        { frequency: 0.1067 },
    mint:        { frequency: 0.06841 },
    gummy:       { frequency: 0.08298 },
    bean:        { frequency: 0.0821 },
    chocolate:   { frequency: 0.06583 },
    bonus:       { frequency: 0.002926, minGap: 8, maxStack: 1, minStack: 1, maxFrequency: 0.025 },
  },
};
const FREQUENCY_REELS = [FREQUENCY_REEL1, FREQUENCY_REEL2, FREQUENCY_REEL3, FREQUENCY_REEL4, FREQUENCY_REEL5, FREQUENCY_REEL6, FREQUENCY_REEL7];

export const REEL_STRIPS = FREQUENCY_REELS.map((freqTable, i) => generateReel(freqTable, REEL_LENGTH, REEL_SEEDS[i], [], 3, PAYTABLE));

const winEvaluator = (grid) => checkClusterWins(grid, PAYTABLE, MIN_CLUSTER_SIZE, 'bonus', SCATTER_TRIGGER_COUNT);

// This game's own playfield look - CascadeEngine.js's DEFAULT_PLAYFIELD_THEME (pink-on-purple)
// used to be the shared engine's own default, since it was Candy Frenzy's own colors baked in as
// "no theme = this game's theme". core/rendering/SlotRenderer.js's default theme now matches
// SlotEngine.js's gold look instead (see its own DEFAULT_THEME doc), so this game passes its
// look explicitly rather than relying on an implicit default that changed underneath it.
const PLAYFIELD = {
  backdropInner: '#3a1440',
  backdropOuter: '#140518',
  //outline: '#f53c8b',
  outlineWidth: 2,
  outlineGlow: 10,
  outlineGlowIntensity: 3,
  frame: '#2d1030',
  gridLines: 'rgba(255, 110, 199, 0.25)',
  background: { type: "color", color: "#401d46bb" },
  loadingBackground: '#2a0e2e',
  loadingColor: '#ff6ec7',
  loadingText: 'LOADING CANDY...',
};

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
const GAME_ASSET_MANIFEST = {
  symbols: { url: './assets/candies_1/candies_1.tiles.json', type: 'tilemap' },
  music: { url: './assets/music/candyfrenzy_theme.mp3', type: 'music' },
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
          // Rebuilds an equivalent evaluator around whatever paytable is being measured. Without
          // it, anything that measures under a RESCALED paytable silently measures the original
          // payouts instead, because `winEvaluator` above closes over PAYTABLE: the payout-scale
          // solve cannot verify itself, and the sensitivity sweep's payoutScale ladder comes back
          // perfectly flat (measured: 0.8 and 1.25 both at 105%), which is arithmetically
          // impossible for a lever RTP is strictly proportional to.
          winEvaluatorFactory: (pt) => (grid) => checkClusterWins(grid, pt, MIN_CLUSTER_SIZE, 'bonus', SCATTER_TRIGGER_COUNT),
          minClusterSize: MIN_CLUSTER_SIZE,
          scatterTriggerCount: SCATTER_TRIGGER_COUNT,
          freeSpinsCount: FREE_SPINS_AWARD,
          // This IS a cascade game, so unlike a line-pay game its trigger rate is genuinely coupled
          // to the NON-trigger symbols: candy weights govern how readily clusters form, which
          // governs cascade depth, and every cascade refills the grid with fresh chances to draw
          // `bonus`. Under deliberately extreme reweighting (bonus held byte-identical, every
          // reel's candy budget preserved) that coupling spans a 0.75%-2.04% trigger range. At
          // weight 0 the search cannot see any of that happening, which is exactly how a cascade
          // tune ends up with a good RTP and a trigger rate nowhere near target - and Phase 2
          // silently undoing Phase 1's work is what `diagnostics.triggerRateDrift` exists to catch.
          //
          // This was 0 for a long time, for a reason that has since stopped being true. The old
          // blocker was reachability: at REEL_LENGTH 500 `bonus` landed only 2-6 times per strip,
          // so one whole symbol was a huge relative step and the achievable rates near target went
          // 0.207% -> 0.343% -> 0.368% -> 0.893%, straight over the 0.45%-0.75% band with nothing
          // inside it. A non-zero weight then just traded RTP away for progress that could never
          // arrive (measured at weight 2: RTP 94.88% -> 103.83% while the rate moved 0.353% ->
          // 0.400%).
          //
          // Re-measured against the frequencies shipped today, the lattice is far finer: `bonus`
          // now lands 27 times across the seven strips (3-7 per reel), with distinct reachable
          // count vectors every ~4% of multiplier around 1.0 rather than every ~40%. Two tunes have
          // since landed at 0.568% and 0.532%, both comfortably inside the band. The target is
          // reachable, so the reason for holding this at 0 is gone.
          //
          // 'Prefer' (1) rather than higher: the coupling is real but indirect, and a heavier
          // weight buys trigger-rate accuracy with RTP on a game where RTP is the harder target.
          triggerRatePenaltyWeight: 1,
          // Cluster-pays games are where reel spacing actually costs money. generateReel enforces
          // minGap/maxStack BEST-EFFORT and silently gives up on a strip too dense to satisfy them,
          // so without a weight here the search sees no cost in pushing a symbol past what the
          // strip can represent - and the resulting clumping is precisely what inflates cluster
          // wins and RTP. Left at 0 previously because a RAW spacing weight is a violation COUNT
          // and therefore incommensurable with everything else in the loss: measured on these
          // tables, a raw 0.25 contributes 43.75 against an RTP error term of 1.76, so the search
          // spends 96% of its effort on spacing while appearing to tune RTP. Under the panel's
          // normalized denomination the same constraint at 'Prefer' costs a few percent of the
          // loss, which is what it should have cost all along.
          spacingPenaltyWeight: 1,
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

  const renderer = new SlotRenderer();
  const particleSystem = new ParticleSystem();
  engine = new CoreSlotEngine(canvas, {
    mechanic: CascadeSpinMechanic,
    animator: new CascadeDropAnimator(renderer, particleSystem, {
      popup: {
        detail: { show: false },
        position: { animation: false }, // explicitly falsy - disables the inherited default rise animation (merge is shallow, so just omitting `animation` would NOT disable it)
        scale: { 
          default: 1,
          animation: { 
            to: 1.5,
            duration: 700,
            easing: 'easeInOut'
          }
        },
      },
    }),
    renderer,
    particleSystem,
    spinLogRecorder: new SpinLogRecorder({ betAmount: BET_AMOUNT, scatterSymbol: 'bonus' }),
    audioController: new AudioController(),
    reelsCount: REELS_COUNT,
    rowsCount: ROWS_COUNT,
    paytable: PAYTABLE,
    reelStrips: REEL_STRIPS,
    winEvaluator,
    scatterSymbol: 'bonus',
    freeSpinsMode: createMultiplierTilesMode({ badgeStyle: 'background', renderOrder: 'behind' }),
    playfield: PLAYFIELD,
    assetManifest: GAME_ASSET_MANIFEST,
    viewportBackground: { type: "image", image: "./assets/backgrounds/candyfrenzy_background_2.png" },
    betAmount: BET_AMOUNT,
    onStateChange: (state) => updateSlotStateUI({ engine, state, refs: { spin: btnSpin, ticker: gameTicker }, onUpdate: updateUI, messages: {
      stopping: 'STOPPING...', dropping_in: 'DROPPING IN...', falling: 'CASCADING...', clearing: 'SWEET WIN!',
      showing_wins: game => `WIN: $${game.lastWin.toFixed(2)}!`, free_spins_intro: 'BONUS TRIGGER!',
      game_over: 'FREE SPINS COMPLETE!', idle: 'IDLE',
    }, onGameOver: handleFreeSpinsComplete }),
    onScatterTrigger: (scatterCount, isInFreeSpins) => handleScatterTrigger(scatterCount, isInFreeSpins),
  });
  await engine.init();

  updateUI();
  bindCommonSlotControls({ getEngine: () => engine, onUpdate: updateUI, betStep: BET_STEP, betMax: BET_MAX, linesMax: 1 });
  observeSlotViewport();
  setupUIHandlers();
  buildPaytableContent(engine.assets);
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

// One tile out of the spritesheet, positioned by CSS rather than drawn: the paytable opens before
// the engine has necessarily finished loading its own copy, and a <canvas> here would need that.
// Returns '' when the theme has no tile for the symbol, so a missing sprite costs a name, not a row.
function symbolIconHtml(symbol, gameAssets, size = 36) {
  const symbolAsset = gameAssets?.symbols?.tiles?.[symbol];
  const tile = symbolAsset?.frameAt?.() || symbolAsset?.frames?.[0]?.tile || symbolAsset?.frames?.[0] || symbolAsset;
  if (!tile || !gameAssets.symbols.sheetUrl) return '';
  const scale = size / tile.w;
  return `<span class="paytable-icon" style="width: ${size}px; height: ${Math.round(tile.h * scale)}px;">`
    + `<img src="${gameAssets.symbols.sheetUrl}" alt="" style="transform: scale(${scale}) translate(${-tile.x}px, ${-tile.y}px);">`
    + `</span>`;
}

// Two decimals on every cell, including whole numbers. Trimming them ("300x" beside "0.4x") makes
// a column of numbers that are meant to be compared against each other line up on nothing.
function formatMultiplier(multiplier) {
  return `${multiplier.toFixed(2)}x`;
}

// A matrix, not a list of cards: cluster size down the side, symbol across the top. Every symbol
// carries its own ladder, so "what does a cluster of 12 pay?" is a row here where it used to be
// seven separate lookups. Both axes are derived from PAYTABLE rather than hardcoded - a symbol
// added or a breakpoint moved changes this table without anyone remembering to edit it.
function buildPaytableContent(gameAssets) {
  renderClusterPaytable({ container: document.getElementById('paytable-grid-content'), paytable: PAYTABLE, scatterTriggerCount: SCATTER_TRIGGER_COUNT, freeSpinsAward: FREE_SPINS_AWARD, renderSymbol: (symbol) => symbolIconHtml(symbol, gameAssets) });
}

if (typeof window !== 'undefined') {
  window.addEventListener('load', initGame);
}
