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
import { POP_FEATURES, POP_RUSH_VARIANTS } from '../../core/math/LemonPopFeatures.js';
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
export const LINES_PER_POP = 5;
export const POPS_TO_RUSH = 3;
// Calibrated over the complete three-Pop progression + Pop Rush sequence for the seven-symbol
// reel set. All ladders scale together, preserving hierarchy and feature logic at 96% RTP.
export const PAYOUT_SCALE = 1.62074;
const ladder = values => values.map(value => value * PAYOUT_SCALE);

// Premiums may combine with each other and wild cans, paying half of the strongest natural
// premium. Normal symbols pay only when their natural symbol matches.
export const PAYTABLE = {
  lemonice:    { type: 'premium', friendlyName: 'Lemon Ice',    linePayout: ladder([1.30, 4.25, 18.00]) },
  pinkpop:     { type: 'premium', friendlyName: 'Pink Pop',    linePayout: ladder([1.00, 3.30, 13.50]) },
  pinkfizz:    { type: 'premium', friendlyName: 'Pink Fizz',   linePayout: ladder([0.70, 2.10, 6.80]) },
  lemonwedge:  { type: 'regular', friendlyName: 'Lemon Wedge', linePayout: ladder([0.20, 0.52, 1.72]) },
  gumdrop:     { type: 'regular', friendlyName: 'Gumdrop',     linePayout: ladder([0.16, 0.40, 1.34]) },
  heart:       { type: 'regular', friendlyName: 'Lemon Heart', linePayout: ladder([0.14, 0.35, 1.16]) },
  lemoncandy:  { type: 'regular', friendlyName: 'Lemon Candy', linePayout: ladder([0.12, 0.30, 1.00]) },
  lemonpop:    { type: 'wild', friendlyName: 'Wild Can', wild: true, linePayout: ladder([0.45, 1.50, 6.00]) },
};

const FREQUENCIES = {
  defaults: { minGap: 1, maxStack: 2, minStack: 1, minFrequency: 0.01, maxFrequency: 0.30 },
  symbols: {
    lemonice: { frequency: 0.025 }, pinkpop: { frequency: 0.040 }, pinkfizz: { frequency: 0.055 },
    lemonwedge: { frequency: 0.150 }, gumdrop: { frequency: 0.170 }, heart: { frequency: 0.200 }, lemoncandy: { frequency: 0.250 },
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
  const step = engine?.spinSequence?.[engine?.stepIndex ?? -1];
  const progress = step?.popProgress || { totalLines: 0, linesPerPop: LINES_PER_POP, popsToRush: POPS_TO_RUSH };
  const linesPerPop = progress.linesPerPop || LINES_PER_POP;
  refs.popCharges?.forEach((charge, index) => {
    const chargeLines = Math.max(0, Math.min(linesPerPop, progress.totalLines - (index * linesPerPop)));
    charge.style.setProperty('--charge-fill', `${(chargeLines / linesPerPop) * 100}%`);
    charge.classList.toggle('charging', chargeLines > 0 && chargeLines < linesPerPop);
    charge.classList.toggle('filled', chargeLines === linesPerPop);
    charge.querySelector('b').textContent = `${chargeLines}/${linesPerPop}`;
  });
}

function updateUI() {
  if (!engine) return;
  refs.balance.textContent = `$${engine.balance.toFixed(2)}`;
  refs.bet.textContent = engine.betAmount.toFixed(2);
  updatePopRushMeter();
}

function setPresentationPhase(phase, step) {
  document.body.classList.toggle('pop-rush-active', phase === 'pop-rush');
  const latestFeature = step?.popFeatures?.at(-1);
  if (phase === 'base' && latestFeature) {
    refs.featureLabel.textContent = `POP ${latestFeature.popIndex}: ${prettyPopFeature(latestFeature.feature)}`;
    refs.featurePanel.classList.add('active');
  } else {
    refs.featurePanel.classList.remove('active');
  }
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

function prettyPopFeature(feature) {
  return ({ 'wild-splash': 'WILD SPLASH', 'flavor-shift': 'FLAVOR SHIFT', 'bubble-burst': 'BUBBLE BURST' })[feature] || feature;
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
    rushLabel: document.getElementById('pop-rush-label'), featurePanel: document.getElementById('pop-feature-panel'),
    featureLabel: document.getElementById('pop-feature-label'), popCharges: [...document.querySelectorAll('.pop-charge')],
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
    betAmount: BET_AMOUNT, wildSymbol: WILD_SYMBOL, linesPerPop: LINES_PER_POP, popsToRush: POPS_TO_RUSH,
    cascadeWinClearMode: 'all-at-once', cascadeWinPreviewDurationMs: 420,
    clearCellHighlight: false, straightLineVisualizer: { horizontalColor: '#fff052', verticalColor: '#7eefff', glow: 20 },
    playfield: PLAYFIELD, assetManifest: GAME_ASSET_MANIFEST,
    viewportBackground: { type: 'image', image: './assets/backgrounds/lemonpop_backround_2.png' },
    popRushViewportBackground: { type: 'image', image: './assets/backgrounds/lemonpop_backround_1.png' },
    onPresentationPhaseChange: setPresentationPhase,
    onStateChange: state => updateSlotStateUI({ engine, state, refs: { spin: refs.spin, ticker: refs.ticker }, onUpdate: updateUI, messages: {
      spinning: 'SHAKE THE CAN…', stopping: 'STOPPING…', dropping_in: 'LEMONS LANDING…', falling: 'NO-REFILL CASCADE…',
      clearing: 'POP!', showing_wins: game => `WIN: $${game.lastWin.toFixed(2)}`, idle: 'READY TO POP',
    } }),
  });
  await engine.init();
  ['lemonwedge', 'gumdrop', 'heart'].forEach((symbol, index) => {
    const icon = refs.popCharges[index]?.querySelector('.pop-charge-icon');
    if (icon) icon.innerHTML = symbolIconHtml(symbol, engine.assets, 30);
  });
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
      linesPerPop: LINES_PER_POP, popsToRush: POPS_TO_RUSH,
    },
  }));
  renderStraightLinePaytable({ container: document.getElementById('paytable-grid-content'), paytable: PAYTABLE, assets: engine.assets,
    wildSymbol: WILD_SYMBOL, renderSymbol: symbol => symbolIconHtml(symbol, engine.assets),
    featureNames: [
      'Every five winning lines fills one Pop and triggers a random Pop effect.',
      'Fill all three Pops to award one free Pop Rush respin.',
      `Pop effects: ${POP_FEATURES.map(prettyPopFeature).join(', ')}.`,
      ...POP_RUSH_VARIANTS.map(prettyVariant),
    ],
  });
  updateUI();
}

export { initGame };

if (typeof window !== 'undefined') window.addEventListener('load', initGame);
