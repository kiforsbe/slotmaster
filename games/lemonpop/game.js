// Lemon Pop — 5x5 no-refill straight-line cascades with persistent wild cans.

// Imports from the core engine, math, and UI packages
import { CoreSlotEngine } from '../../core/engine/CoreSlotEngine.js';
import { CascadeDropAnimator } from '../../core/engine/animators/CascadeDropAnimator.js';
import { SlotRenderer } from '../../core/rendering/SlotRenderer.js';
import { ParticleSystem } from '../../core/rendering/ParticleSystem.js';
import { SpinLogRecorder } from '../../core/engine/SpinLogRecorder.js';
import { AudioController } from '../../core/engine/AudioController.js';
import { generateReel } from '../../core/math/SlotMath.js';
import { checkStraightLineWins } from '../../core/math/StraightLineMath.js';
import { bindCommonSlotControls, observeSlotViewport, updateSlotStateUI } from '../../core/ui/SlotGameUI.js';
import { ensureDeveloperPanels } from '../../core/ui/DeveloperPanels.js';
import { openSpinLogPanel } from '../../core/ui/dev/SpinLogPanel.js';
import { runSimulationAndRender } from '../../core/ui/dev/SimulationPanel.js';
import { openTuningPanel } from '../../core/ui/dev/tuning/TuningPanelView.js';
import { renderStraightLinePaytable } from '../../core/ui/PaytableRenderer.js';

// Lemon Pop's own pluggable mechanic and feature implementations, plus the game's own constants.
import { LemonPopSpinMechanic } from './LemonPopSpinMechanic.js';
import { POP_FEATURES, POP_RUSH_VARIANTS } from './LemonPopFeatures.js';

// The rest of this file is the game's own constants and UI wiring, not part of the core engine.
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
const DEBUG_MODE = true;

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
let lastLoggedPopDebugStep = null;
const POP_RING_PATH_LENGTH = 300;
const POP_RING_SEGMENT_LENGTH = 100;

function symbolIconHtml(symbol, assets, size = 34, options = {}) {
  const sprite = assets?.symbols?.tiles?.[symbol];
  const tile = sprite?.frameAt?.() || sprite?.frames?.[0]?.tile || sprite?.frames?.[0] || sprite;
  if (!tile || !assets?.symbols?.sheetUrl) return '';
  const centered = options.centered === true;
  const scale = centered ? (size / Math.max(tile.w, tile.h)) : (size / tile.w);
  const width = centered ? size : size;
  const height = centered ? size : Math.round(tile.h * scale);
  const left = centered ? ((size - (tile.w * scale)) / 2) - (tile.x * scale) : 0;
  const top = centered ? ((size - (tile.h * scale)) / 2) - (tile.y * scale) : 0;
  const imageStyle = centered
    ? `left:${left}px;top:${top}px;transform:scale(${scale})`
    : `transform:scale(${scale}) translate(${-tile.x}px,${-tile.y}px)`;
  return `<span class="paytable-icon" style="width:${width}px;height:${height}px"><img src="${assets.symbols.sheetUrl}" alt="" style="${imageStyle}"></span>`;
}

function measureOpaqueTileBounds(spritesheet, tile) {
  const canvas = document.createElement('canvas');
  canvas.width = tile.w;
  canvas.height = tile.h;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return null;
  context.drawImage(spritesheet, tile.x, tile.y, tile.w, tile.h, 0, 0, tile.w, tile.h);
  const { data, width, height } = context.getImageData(0, 0, tile.w, tile.h);
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (data[((y * width) + x) * 4 + 3] === 0) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }

  if (maxX < minX || maxY < minY) return null;
  return { x: minX, y: minY, w: (maxX - minX) + 1, h: (maxY - minY) + 1 };
}

function createCenteredMeterIcon(symbol, assets, size = 46) {
  const sprite = assets?.symbols?.tiles?.[symbol];
  const tile = sprite?.frameAt?.() || sprite?.frames?.[0]?.tile || sprite?.frames?.[0] || sprite;
  const spritesheet = assets?.symbols?.image;
  if (!tile || !spritesheet) return null;

  const crop = measureOpaqueTileBounds(spritesheet, tile) || { x: 0, y: 0, w: tile.w, h: tile.h };
  const dpr = window.devicePixelRatio || 1;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(size * dpr);
  canvas.height = Math.round(size * dpr);
  canvas.style.width = `${size}px`;
  canvas.style.height = `${size}px`;
  const context = canvas.getContext('2d');
  if (!context) return null;
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.imageSmoothingEnabled = true;
  const drawScale = size / Math.max(crop.w, crop.h);
  const drawWidth = crop.w * drawScale;
  const drawHeight = crop.h * drawScale;
  const drawX = (size - drawWidth) / 2;
  const drawY = (size - drawHeight) / 2;
  context.drawImage(
    spritesheet,
    tile.x + crop.x,
    tile.y + crop.y,
    crop.w,
    crop.h,
    drawX,
    drawY,
    drawWidth,
    drawHeight,
  );

  const wrapper = document.createElement('span');
  wrapper.className = 'paytable-icon';
  wrapper.style.width = `${size}px`;
  wrapper.style.height = `${size}px`;
  wrapper.append(canvas);
  return wrapper;
}

function updatePopRushMeter() {
  const step = engine?.spinSequence?.[engine?.stepIndex ?? -1];
  const progress = step?.popProgress || { totalLines: 0, linesPerPop: LINES_PER_POP, popsToRush: POPS_TO_RUSH };
  const linesPerPop = progress.linesPerPop || LINES_PER_POP;
  const popsToRush = progress.popsToRush || POPS_TO_RUSH;
  const bankedChargeLines = Math.max(0, progress.bankedChargeLines ?? progress.totalLines ?? 0);
  const completedPops = Math.min(popsToRush, progress.availablePops ?? progress.completedPops ?? Math.floor(bankedChargeLines / linesPerPop));
  const linesInCurrentPop = completedPops === popsToRush ? linesPerPop : (progress.linesInCurrentPop ?? Math.min(linesPerPop, bankedChargeLines % linesPerPop));
  const segmentLines = Array.from({ length: popsToRush }, (_, index) => Math.max(0, Math.min(linesPerPop, bankedChargeLines - (index * linesPerPop))));

  refs.popChargeSegments?.forEach((segment, index) => {
    const segmentFill = Math.max(0, Math.min(1, (segmentLines[index] || 0) / linesPerPop));
    const filledLength = segmentFill * POP_RING_SEGMENT_LENGTH;
    const isUnlocked = index === 0 || completedPops >= index;
    segment.style.strokeDasharray = `${filledLength} ${POP_RING_PATH_LENGTH - filledLength}`;
    segment.classList.toggle('unlocked', isUnlocked);
    segment.classList.toggle('charging', segmentFill > 0 && segmentFill < 1);
    segment.classList.toggle('filled', segmentFill === 1);
  });

  refs.popCharge?.classList.toggle('charging', linesInCurrentPop > 0 && completedPops < popsToRush);
  refs.popCharge?.classList.toggle('filled', completedPops === popsToRush);
}

function logPopDebug(step) {
  if ((!step?.popDebug && !step?.popSettleDebug) || step === lastLoggedPopDebugStep) return;
  lastLoggedPopDebugStep = step;
  if (step.popDebug) console.debug('[Lemon Pop]', step.popDebug);
  if (step.popSettleDebug) console.debug('[Lemon Pop]', step.popSettleDebug);
}

function updateUI() {
  if (!engine) return;
  refs.balance.textContent = `$${engine.balance.toFixed(2)}`;
  refs.bet.textContent = engine.betAmount.toFixed(2);
  updatePopRushMeter();
}

function setPresentationPhase(phase, step) {
  document.body.classList.toggle('pop-rush-active', phase === 'pop-rush');
  logPopDebug(step);
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

function triggerCheat(cheat) {
  if (!DEBUG_MODE || !engine) return;
  if (engine.state !== 'idle' && engine.state !== 'showing_wins') return;
  const previousCheat = engine.config.debugNextCheat;
  try {
    engine.config.debugNextCheat = cheat;
    void engine.spin();
  } finally {
    engine.config.debugNextCheat = previousCheat ?? null;
  }
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
    featureLabel: document.getElementById('pop-feature-label'), popCharge: document.querySelector('.pop-charge'),
    popChargeTracks: [...document.querySelectorAll('.pop-charge-track')],
    popChargeIcon: document.querySelector('.pop-charge-icon'), popChargeSegments: [...document.querySelectorAll('.pop-charge-fill')],
    tune: document.getElementById('btn-tune'), sim: document.getElementById('btn-sim'), spinlog: document.getElementById('btn-spinlog'),
    debugShortcuts: document.querySelector('.debug-shortcuts'),
    cheatMiniWildSplash: document.getElementById('cheat-mini-wild-splash'),
    cheatMiniWildSplashSparse: document.getElementById('cheat-mini-wild-splash-sparse'),
    cheatMiniFlavorShift: document.getElementById('cheat-mini-flavor-shift'),
    cheatMiniBubbleBurst: document.getElementById('cheat-mini-bubble-burst'),
    cheatMajorPopRush: document.getElementById('cheat-major-pop-rush'),
    cheatMajorCitrusCross: document.getElementById('cheat-major-citrus-cross'),
    cheatMajorFlavorRemix: document.getElementById('cheat-major-flavor-remix'),
    cheatMajorSodaStorm: document.getElementById('cheat-major-soda-storm'),
  };
  if (refs.debugShortcuts && DEBUG_MODE) refs.debugShortcuts.classList.add('debug-enabled');
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
    debugPopFeatures: true,
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
  if (refs.popChargeIcon) {
    const centeredMeterIcon = createCenteredMeterIcon(WILD_SYMBOL, engine.assets, 60);
    if (centeredMeterIcon) {
      refs.popChargeIcon.replaceChildren(centeredMeterIcon);
    } else {
      refs.popChargeIcon.innerHTML = symbolIconHtml(WILD_SYMBOL, engine.assets, 60, { centered: true });
    }
  }
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
  refs.cheatMiniWildSplash?.addEventListener('click', () => triggerCheat({ type: 'mini-pop', feature: 'wild-splash' }));
  refs.cheatMiniWildSplashSparse?.addEventListener('click', () => triggerCheat({ type: 'mini-pop', feature: 'wild-splash', sparseGrid: true }));
  refs.cheatMiniFlavorShift?.addEventListener('click', () => triggerCheat({ type: 'mini-pop', feature: 'flavor-shift' }));
  refs.cheatMiniBubbleBurst?.addEventListener('click', () => triggerCheat({ type: 'mini-pop', feature: 'bubble-burst' }));
  refs.cheatMajorPopRush?.addEventListener('click', () => triggerCheat({ type: 'pop-rush', variant: 'pop-rush' }));
  refs.cheatMajorCitrusCross?.addEventListener('click', () => triggerCheat({ type: 'pop-rush', variant: 'citrus-cross' }));
  refs.cheatMajorFlavorRemix?.addEventListener('click', () => triggerCheat({ type: 'pop-rush', variant: 'flavor-remix' }));
  refs.cheatMajorSodaStorm?.addEventListener('click', () => triggerCheat({ type: 'pop-rush', variant: 'soda-storm' }));
  renderStraightLinePaytable({ container: document.getElementById('paytable-grid-content'), paytable: PAYTABLE, assets: engine.assets,
    wildSymbol: WILD_SYMBOL, renderSymbol: symbol => symbolIconHtml(symbol, engine.assets),
    featureNames: [
      'Every five winning lines fills one can segment. Filled mini Pops trigger only after the current cascades stop.',
      'Clear the board with a full can to award one free Pop Rush respin.',
      `Pop effects: ${POP_FEATURES.map(prettyPopFeature).join(', ')}.`,
      ...POP_RUSH_VARIANTS.map(prettyVariant),
    ],
  });
  updateUI();
}

export { initGame };

if (typeof window !== 'undefined') window.addEventListener('load', initGame);
