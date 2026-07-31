// Lemon Pop — 5x5 no-refill straight-line cascades with persistent wild cans.
import { CoreSlotEngine } from '../../core/engine/CoreSlotEngine.js';
import { CascadeDropAnimator } from '../../core/engine/animators/CascadeDropAnimator.js';
import { LemonPopSpinMechanic } from '../../core/engine/mechanics/LemonPopSpinMechanic.js';
import { SlotRenderer } from '../../core/rendering/SlotRenderer.js';
import { ParticleSystem } from '../../core/rendering/ParticleSystem.js';
import { SpinLogRecorder } from '../../core/engine/SpinLogRecorder.js';
import { AudioController } from '../../core/engine/AudioController.js';
import { generateReel } from '../../core/math/SlotMath.js';
import { checkStraightLineWins } from '../../core/math/StraightLineMath.js';
import { POP_RUSH_VARIANTS } from '../../core/math/LemonPopFeatures.js';
import { bindCommonSlotControls, observeSlotViewport, updateSlotStateUI } from '../../core/ui/SlotGameUI.js';
import { ensureDeveloperPanels } from '../../core/ui/DeveloperPanels.js';
import { openSpinLogPanel } from '../../core/ui/dev/SpinLogPanel.js';
import { runSimulationAndRender } from '../../core/ui/dev/SimulationPanel.js';
import { openTuningPanel } from '../../core/ui/dev/tuning/TuningPanelView.js';
import { renderStraightLinePaytable } from '../../core/ui/PaytableRenderer.js';

export const REELS_COUNT = 5;
export const ROWS_COUNT = 5;
export const REEL_LENGTH = 480;
export const REEL_SEEDS = [1801, 1807, 1811, 1813, 1819];
export const BET_AMOUNT = 1;
export const BET_STEP = 0.25;
export const BET_MAX = 50;
export const WILD_SYMBOL = 'lemonpop';
export const POP_RUSH_CASCADE_COUNT = 4;
// Calibrated over the complete no-refill + Pop Rush sequence. An initial 200k calibration was
// corrected against independent 250k×3 and 1m holdouts (all ladders scale together, preserving
// the symbol hierarchy and feature logic while targeting 96% RTP).
export const PAYOUT_SCALE = 1.2557;
const ladder = values => values.map(value => value * PAYOUT_SCALE);

// The five largest symbols are the premium family. They may combine with each other and wild
// cans, paying half of the strongest natural premium. The ten regular symbols pay only when
// their natural symbol matches; all fifteen supplied non-wild tiles are therefore in play.
export const PAYTABLE = {
  lemonice:    { type: 'premium', friendlyName: 'Lemon Ice',    linePayout: ladder([1.30, 4.25, 18.00]) },
  lemonwedge:  { type: 'premium', friendlyName: 'Lemon Wedge',  linePayout: ladder([1.10, 3.60, 14.00]) },
  flower:      { type: 'premium', friendlyName: 'Citrus Flower', linePayout: ladder([0.95, 3.00, 11.00]) },
  heart:       { type: 'premium', friendlyName: 'Lemon Heart', linePayout: ladder([0.80, 2.50, 8.50]) },
  pinkfizz:    { type: 'premium', friendlyName: 'Pink Fizz',   linePayout: ladder([0.70, 2.10, 6.80]) },
  lemoncandy:  { type: 'regular', friendlyName: 'Lemon Candy', linePayout: ladder([0.17, 0.42, 1.40]) },
  orangeclub:  { type: 'regular', friendlyName: 'Orange Club', linePayout: ladder([0.16, 0.39, 1.25]) },
  orangecandy: { type: 'regular', friendlyName: 'Orange Candy', linePayout: ladder([0.15, 0.36, 1.12]) },
  lemon:       { type: 'regular', friendlyName: 'Lemon',       linePayout: ladder([0.14, 0.33, 1.00]) },
  gumdrop:     { type: 'regular', friendlyName: 'Gumdrop',     linePayout: ladder([0.13, 0.30, 0.90]) },
  pinkpop:     { type: 'regular', friendlyName: 'Pink Pop',   linePayout: ladder([0.12, 0.28, 0.82]) },
  orange:      { type: 'regular', friendlyName: 'Orange',     linePayout: ladder([0.11, 0.25, 0.74]) },
  mint:        { type: 'regular', friendlyName: 'Mint',       linePayout: ladder([0.10, 0.23, 0.67]) },
  limewedge:   { type: 'regular', friendlyName: 'Lime Wedge', linePayout: ladder([0.09, 0.21, 0.60]) },
  limecandy:   { type: 'regular', friendlyName: 'Lime Candy', linePayout: ladder([0.08, 0.19, 0.54]) },
  lemonpop:    { type: 'wild', friendlyName: 'Wild Can', wild: true, linePayout: ladder([0.45, 1.50, 6.00]) },
};

const FREQUENCIES = {
  defaults: { minGap: 1, maxStack: 2, minStack: 1, minFrequency: 0.01, maxFrequency: 0.30 },
  symbols: {
    lemonice: { frequency: 0.036 }, lemonwedge: { frequency: 0.036 }, flower: { frequency: 0.036 },
    heart: { frequency: 0.036 }, pinkfizz: { frequency: 0.036 },
    lemoncandy: { frequency: 0.260 }, orangeclub: { frequency: 0.240 }, orangecandy: { frequency: 0.120 },
    lemon: { frequency: 0.100 }, gumdrop: { frequency: 0.060 }, pinkpop: { frequency: 0.040 },
    orange: { frequency: 0.020 }, mint: { frequency: 0.015 }, limewedge: { frequency: 0.010 }, limecandy: { frequency: 0.010 },
  },
};
export const FREQUENCY_REELS = REEL_SEEDS.map(() => structuredClone(FREQUENCIES));
export const REEL_STRIPS = FREQUENCY_REELS.map((table, index) => generateReel(table, REEL_LENGTH, REEL_SEEDS[index], [WILD_SYMBOL], 3, PAYTABLE));

export const winEvaluator = (grid, wildMultipliers) => checkStraightLineWins(grid, PAYTABLE, {
  wildSymbol: WILD_SYMBOL,
  wildMultipliers,
});

const GAME_ASSET_MANIFEST = {
  symbols: { url: './assets/symbols/lemonpop_1.tiles.json', type: 'tilemap' },
  music: { url: './assets/music/lemonpop_theme.mp3', type: 'music' },
};

const PLAYFIELD = {
  backdropInner: '#57214e', backdropOuter: '#160817', outline: '#dfff3a', outlineWidth: 3,
  outlineGlow: 16, outlineGlowIntensity: 1.8, frame: '#441441', gridLines: 'rgba(255,255,255,.16)',
  background: { type: 'color', color: 'rgba(55, 18, 59, .58)' }, loadingBackground: '#220b25',
  loadingColor: '#dfff3a', loadingText: 'POPPING LEMONS…',
};

let engine;
let refs = {};

function symbolIconHtml(symbol, assets, size = 34) {
  const sprite = assets?.symbols?.tiles?.[symbol];
  const tile = sprite?.frameAt?.() || sprite?.frames?.[0]?.tile || sprite?.frames?.[0] || sprite;
  if (!tile || !assets?.symbols?.sheetUrl) return '';
  const scale = size / tile.w;
  return `<span class="paytable-icon" style="width:${size}px;height:${Math.round(tile.h * scale)}px"><img src="${assets.symbols.sheetUrl}" alt="" style="transform:scale(${scale}) translate(${-tile.x}px,${-tile.y}px)"></span>`;
}

function updatePopRushMeter() {
  const completed = engine?.spinSequence
    ?.slice(0, (engine.stepIndex ?? -1) + 1)
    .filter(step => step.presentationPhase === 'base' && step.clusterWins?.length).length || 0;
  refs.meterDots?.forEach((dot, index) => dot.classList.toggle('filled', index < Math.min(POP_RUSH_CASCADE_COUNT, completed)));
}

function updateUI() {
  if (!engine) return;
  refs.balance.textContent = `$${engine.balance.toFixed(2)}`;
  refs.bet.textContent = engine.betAmount.toFixed(2);
  updatePopRushMeter();
}

function setPresentationPhase(phase, step) {
  document.body.classList.toggle('pop-rush-active', phase === 'pop-rush');
  if (phase === 'pop-rush' && step?.popRushVariant) {
    refs.rushLabel.textContent = `${prettyVariant(step.popRushVariant)} — FREE POP RUSH`;
    refs.rushPanel.classList.add('active');
  } else {
    refs.rushPanel.classList.remove('active');
  }
  updatePopRushMeter();
}

function prettyVariant(variant) {
  return ({ 'pop-rush': 'POP RUSH', 'citrus-cross': 'CITRUS CROSS', 'flavor-remix': 'FLAVOR REMIX', 'soda-storm': 'SODA STORM' })[variant] || variant;
}

function openPaytable() { refs.paytableModal.classList.add('active'); }
function closePaytable() { refs.paytableModal.classList.remove('active'); }

async function initGame() {
  refs = {
    canvas: document.getElementById('game-canvas'), spin: document.getElementById('btn-spin'),
    auto: document.getElementById('btn-auto'), turbo: document.getElementById('btn-turbo'),
    mute: document.getElementById('btn-mute'), paytable: document.getElementById('btn-paytable'),
    balance: document.getElementById('display-balance'), bet: document.getElementById('bet-value'),
    ticker: document.getElementById('game-ticker'), paytableModal: document.getElementById('modal-paytable'),
    paytableClose: document.getElementById('btn-paytable-ok'), rushPanel: document.getElementById('pop-rush-panel'),
    rushLabel: document.getElementById('pop-rush-label'), meterDots: [...document.querySelectorAll('.pop-rush-meter i')],
    tune: document.getElementById('btn-tune'), sim: document.getElementById('btn-sim'), spinlog: document.getElementById('btn-spinlog'),
  };
  const developerPanels = ensureDeveloperPanels();
  const renderer = new SlotRenderer();
  const particleSystem = new ParticleSystem();
  engine = new CoreSlotEngine(refs.canvas, {
    mechanic: LemonPopSpinMechanic,
    animator: new CascadeDropAnimator(renderer, particleSystem, { normalClearDurationMs: 540, turboClearDurationMs: 190, popup: { detail: { show: false } } }),
    renderer, particleSystem, audioController: new AudioController(),
    spinLogRecorder: new SpinLogRecorder({ betAmount: BET_AMOUNT, scatterSymbol: null }),
    reelsCount: REELS_COUNT, rowsCount: ROWS_COUNT, paytable: PAYTABLE, reelStrips: REEL_STRIPS, winEvaluator,
    betAmount: BET_AMOUNT, wildSymbol: WILD_SYMBOL, popRushCascadeCount: POP_RUSH_CASCADE_COUNT,
    cascadeWinClearMode: 'all-at-once', cascadeWinPreviewDurationMs: 420,
    clearCellHighlight: false, straightLineVisualizer: { horizontalColor: '#fff052', verticalColor: '#7eefff', glow: 20 },
    playfield: PLAYFIELD, assetManifest: GAME_ASSET_MANIFEST,
    viewportBackground: { type: 'image', image: './assets/backgrounds/lemonpop_backround_2.png' },
    popRushViewportBackground: { type: 'image', image: './assets/backgrounds/lemonpop_backround_1.png' },
    music: { main: './assets/music/lemonpop_theme.mp3' },
    onPresentationPhaseChange: setPresentationPhase,
    onStateChange: state => updateSlotStateUI({ engine, state, refs: { spin: refs.spin, ticker: refs.ticker }, onUpdate: updateUI, messages: {
      spinning: 'SHAKE THE CAN…', stopping: 'STOPPING…', dropping_in: 'LEMONS LANDING…', falling: 'NO-REFILL CASCADE…',
      clearing: 'POP!', showing_wins: game => `WIN: $${game.lastWin.toFixed(2)}`, idle: 'READY TO POP',
    } }),
  });
  await engine.init();
  bindCommonSlotControls({ getEngine: () => engine, onUpdate: updateUI, betStep: BET_STEP, betMax: BET_MAX, linesMax: 1 });
  observeSlotViewport();
  refs.paytable.addEventListener('click', openPaytable);
  refs.paytableClose.addEventListener('click', closePaytable);
  refs.paytableModal.querySelector('.btn-modal-close').addEventListener('click', closePaytable);
  refs.spinlog.addEventListener('click', () => openSpinLogPanel({ engine, domRefs: { panel: developerPanels.spinLog } }));
  refs.sim.addEventListener('click', () => runSimulationAndRender({
    engine, paytable: PAYTABLE, betPerLine: BET_AMOUNT, linesCount: 1, numSpins: 250000,
    labels: LemonPopSpinMechanic.statsLabels,
    domRefs: { btnSim: refs.sim, panel: developerPanels.simulation, simModal: developerPanels.simulation,
      simStats: document.getElementById('sim-stats'), simRtpDisplay: document.getElementById('sim-rtp'),
      simTotalSpinsDisplay: document.getElementById('sim-total-spins'), simMaxWinDisplay: document.getElementById('sim-max-win'),
      simFreeSpinsDisplay: document.getElementById('sim-free-spins') },
  }));
  refs.tune.addEventListener('click', () => openTuningPanel({
    paytable: PAYTABLE, reelFrequencyTables: FREQUENCY_REELS, panel: developerPanels.tuning,
    tuneConfig: {
      reelsCount: REELS_COUNT, rowsCount: ROWS_COUNT, reelSeeds: REEL_SEEDS, reelLength: REEL_LENGTH,
      betPerLine: BET_AMOUNT, linesCount: 1, wildSymbol: WILD_SYMBOL, mechanic: LemonPopSpinMechanic,
      winEvaluatorName: 'checkStraightLineWins',
      winEvaluatorFactory: pt => (grid, multipliers) => checkStraightLineWins(grid, pt, { wildSymbol: WILD_SYMBOL, wildMultipliers: multipliers }),
      minClusterSize: 3, reelCoupling: 'independent', targetRtp: 96,
    },
  }));
  renderStraightLinePaytable({ container: document.getElementById('paytable-grid-content'), paytable: PAYTABLE, assets: engine.assets,
    wildSymbol: WILD_SYMBOL, renderSymbol: symbol => symbolIconHtml(symbol, engine.assets),
    featureNames: ['Four paid-spin cascades award one free Pop Rush respin.', ...POP_RUSH_VARIANTS.map(prettyVariant)],
  });
  updateUI();
}

export { initGame };

if (typeof window !== 'undefined') window.addEventListener('load', initGame);
