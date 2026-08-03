// Beach Party — 5x5, 30-line reel game. Wide 256x128 tile art (vs. every other game's square
// tiles) and tall multi-row "stacked" surfer symbols are new to this game; see
// games/beachparty/docs/DESIGN.md for the full design.
import { generateReel, checkWins } from '../../core/math/SlotMath.js';
import { CoreSlotEngine } from '../../core/engine/CoreSlotEngine.js';
import { LineMechanic } from '../../core/engine/mechanics/LineMechanic.js';
import { ReelScrollAnimator } from '../../core/engine/animators/ReelScrollAnimator.js';
import { SlotRenderer } from '../../core/rendering/SlotRenderer.js';
import { SpinLogRecorder } from '../../core/engine/SpinLogRecorder.js';
import { AudioController } from '../../core/engine/AudioController.js';
import { runSimulationAndRender } from '../../core/ui/dev/SimulationPanel.js';
import { openTuningPanel } from '../../core/ui/dev/tuning/TuningPanelView.js';
import { openSpinLogPanel } from '../../core/ui/dev/SpinLogPanel.js';
import { bindCommonSlotControls, observeSlotViewport, updateSlotStateUI } from '../../core/ui/SlotGameUI.js';
import { ensureDeveloperPanels } from '../../core/ui/DeveloperPanels.js';
import { renderLinePaytable } from '../../core/ui/PaytableRenderer.js';

// Grid/reel parameters - single source of truth for the live game, RUN SIMULATION, and the
// frequency tuner (same convention as every other game here - see barfruits' own game.js).
export const REELS_COUNT = 5;
export const ROWS_COUNT = 5;
export const REEL_SEEDS = [3001, 3003, 3007, 3011, 3013];
export const REEL_LENGTH = 400;
export const BET_PER_LINE = 0.05;
export const BET_PER_LINE_STEP = 0.05;
export const BET_PER_LINE_MAX = 5;
export const LINES_COUNT = 30;

export const WILD_SYMBOL = 'wild';
export const BONUS_SYMBOL = 'bonus';
// Blue is the highest-paying surfer (see PAYTABLE below) - the jackpot itself pays a flat
// JACKPOT_MULTIPLIER rather than a specific symbol's own line payout, so there's no separate
// "jackpot symbol" constant to track here beyond that ordering.
export const SURFER_COLORS = ['surfer_yellow', 'surfer_pink', 'surfer_green', 'surfer_blue'];
export const JACKPOT_MULTIPLIER = 250;
// Reels 1, 3, 5 in human terms - the only reels the bonus symbol can land on.
export const BONUS_REEL_INDEXES = [0, 2, 4];
export const BONUS_SPINS_AWARD = 8;

// New 5x5 template - see docs/PAYLINES-TEMPLATES.md's "5x5 playfield" section for the shape
// rationale (straight rows, diagonals, V/inverted-V at 3 depths, steps, U-shapes at 3 depths,
// zigzags at 3 row-pairs, W/M at 3 spreads).
export const PAYLINES = [
  [0,0,0,0,0], [1,1,1,1,1], [2,2,2,2,2], [3,3,3,3,3], [4,4,4,4,4],
  [0,1,2,3,4], [4,3,2,1,0],
  [0,2,4,2,0], [4,2,0,2,4],
  [1,2,3,2,1], [3,2,1,2,3],
  [0,1,3,1,0], [4,3,1,3,4],
  [0,0,2,4,4], [4,4,2,0,0],
  [0,1,1,1,0], [4,3,3,3,4],
  [1,0,0,0,1], [3,4,4,4,3],
  [2,1,0,1,2], [2,3,4,3,2],
  [0,1,0,1,0], [4,3,4,3,4],
  [1,2,1,2,1], [3,2,3,2,3],
  [0,2,0,2,0], [4,2,4,2,4],
  [0,4,0,4,0], [4,0,4,0,4],
  [1,3,1,3,1],
];

// Paytable. Seed payout values, to be tuned for real RTP (~96% target) via the TUNE FREQUENCIES
// panel once reels exist - not hand-computed (same workflow every other game here uses).
// payout[i] is the payout for (i+1) matching symbols, left-to-right from reel 1 (indexes 0/1
// unused - nothing pays on 1 or 2 of a kind in this paytable).
export const PAYTABLE = {
  wild:          { type: 'wild', friendlyName: 'Wild Surfer', wild: true, payout: [0, 0, 25, 100, 400] },
  // Surf-culture nicknames instead of plain color labels, ranked loosely by skill/status to
  // match payout tier (Kahuna > Shredder > Rider > Grom).
  surfer_blue:   { type: 'premium', friendlyName: 'Big Kahuna', payout: [0, 0, 20, 60, 250] },
  surfer_green:  { type: 'premium', friendlyName: 'Wave Shredder', payout: [0, 0, 15, 45, 180] },
  surfer_pink:   { type: 'premium', friendlyName: 'Coral Rider', payout: [0, 0, 10, 30, 120] },
  surfer_yellow: { type: 'premium', friendlyName: 'Sunny Grom', payout: [0, 0, 8, 25, 100] },
  ace:           { type: 'regular', friendlyName: 'Ace', payout: [0, 0, 6, 20, 60] },
  king:          { type: 'regular', friendlyName: 'King', payout: [0, 0, 5, 16, 50] },
  queen:         { type: 'regular', friendlyName: 'Queen', payout: [0, 0, 4, 14, 40] },
  jack:          { type: 'regular', friendlyName: 'Jack', payout: [0, 0, 4, 12, 35] },
  ten:           { type: 'regular', friendlyName: 'Ten', payout: [0, 0, 3, 10, 30] },
  // Trigger-only: reels 1/3/5, no direct line payout. `type`/`paymode` mirror barfruits' `star`
  // so PaytableRenderer's existing scatter-style rendering picks it up correctly, and
  // `triggerFreeSpins: true` gives it generateReel's default minGap spacing (3) even though the
  // actual trigger check is custom (see evaluateBeachPartyWin below) rather than checkWins' own
  // built-in "anywhere on the grid" scatter path.
  bonus:         { type: 'scatter', paymode: 'any', friendlyName: 'Beach Bonus', triggerFreeSpins: true },
};

// Rendering-only: each surfer color's 5-tall stack variant tiles, top row to bottom row. Never
// appears as its own paytable entry - a stacked run still pays as N-of-a-kind on the base
// symbol name, identical to an unstacked run (see core/rendering/StackedSymbols.js).
export const STACKED_SYMBOLS = {
  surfer_yellow: ['surfer_yellow_1', 'surfer_yellow_2', 'surfer_yellow_3', 'surfer_yellow_4', 'surfer_yellow_5'],
  surfer_pink:   ['surfer_pink_1', 'surfer_pink_2', 'surfer_pink_3', 'surfer_pink_4', 'surfer_pink_5'],
  surfer_green:  ['surfer_green_1', 'surfer_green_2', 'surfer_green_3', 'surfer_green_4', 'surfer_green_5'],
  surfer_blue:   ['surfer_blue_1', 'surfer_blue_2', 'surfer_blue_3', 'surfer_blue_4', 'surfer_blue_5'],
};

const FREQUENCIES = {
  defaults: { minGap: 1, maxStack: 1, minStack: 1 },
  symbols: {
    wild:          { frequency: 0.025, minGap: 4 },
    surfer_blue:   { frequency: 0.035, minStack: 2, maxStack: 5, stackChance: 0.45 },
    surfer_green:  { frequency: 0.045, minStack: 2, maxStack: 5, stackChance: 0.45 },
    surfer_pink:   { frequency: 0.060, minStack: 2, maxStack: 5, stackChance: 0.45 },
    surfer_yellow: { frequency: 0.075, minStack: 2, maxStack: 5, stackChance: 0.45 },
    ace:           { frequency: 0.110 },
    king:          { frequency: 0.130 },
    queen:         { frequency: 0.150 },
    jack:          { frequency: 0.170 },
    ten:           { frequency: 0.190 },
    bonus:         { frequency: 0.040 },
  },
};

// One frequency table per reel, bonus zeroed out on reels 2 and 4 (indexes 1 and 3) - it only
// ever lands on reels 1, 3, 5 (indexes 0, 2, 4).
export const FREQUENCY_REELS = REEL_SEEDS.map((_, reelIndex) => {
  const table = structuredClone(FREQUENCIES);
  if (!BONUS_REEL_INDEXES.includes(reelIndex)) table.symbols.bonus.frequency = 0;
  return table;
});

export const REEL_STRIPS = FREQUENCY_REELS.map((table, index) => generateReel(table, REEL_LENGTH, REEL_SEEDS[index], [], 3, PAYTABLE));

// Returns the surfer color fully covering this reel's column (all ROWS_COUNT rows the same
// surfer symbol), or null if the column isn't a full stack of one surfer color.
export function fullyStackedColor(grid, col) {
  const column = grid[col];
  const first = column[0];
  if (!SURFER_COLORS.includes(first)) return null;
  return column.every(cell => cell === first) ? first : null;
}

// Custom, reel-restricted trigger check: `bonus` must land on reels 1, 3, and 5 (not merely
// "anywhere on the grid", which is what checkWins' built-in scatterSymbol path assumes) - see
// DESIGN.md §5. Shaped exactly like checkWins' own scatterWin object so it flows through
// CoreSlotEngine's existing onScatterTrigger unchanged.
export function detectBonusTrigger(grid) {
  const coveredReels = BONUS_REEL_INDEXES.filter(col => grid[col].includes(BONUS_SYMBOL));
  const winningPositions = coveredReels.flatMap(col => grid[col]
    .map((cell, row) => (cell === BONUS_SYMBOL ? [col, row] : null))
    .filter(Boolean));
  return {
    symbol: BONUS_SYMBOL,
    count: coveredReels.length,
    payout: 0,
    winningPositions,
    triggerFreeSpins: coveredReels.length === BONUS_REEL_INDEXES.length,
  };
}

// "Reef Royale" mini jackpot: true when full 5-tall stacks of all 4 distinct surfer colors are
// on the board at once (needs >= 4 of the 5 reels fully stacked, one per color).
export function detectJackpot(grid) {
  const stackedColors = new Set();
  for (let col = 0; col < grid.length; col++) {
    const color = fullyStackedColor(grid, col);
    if (color) stackedColors.add(color);
  }
  return SURFER_COLORS.every(color => stackedColors.has(color));
}

// Wraps checkWins with two Beach-Bonus-only rules layered on top - both no-ops outside free
// spins, so the base game is exactly checkWins' own line-pay math:
//   1. Stacked wilds: a reel that's a full 5-tall stack of one surfer color counts as wild for
//      line-matching (the grid is copied for this - engine.grid, used for rendering, is
//      untouched, so the surfer art still displays instead of a wild icon).
//   2. Mini jackpot: collecting a full stack of all 4 colors at once pays JACKPOT_MULTIPLIER x
//      total bet, via scatterWin.payout (which LineMechanic already scales by totalBet, unlike
//      lineWins which scale by betPerLine) - on top of the (already large) wild-substituted
//      line win from rule 1, not instead of it.
//
// NOTE: SpinSimulator's batch path has no concept of "is this simulated spin a free spin" for
// LineMechanic (unlike CascadeSpinMechanic's FreeSpinsModes) - so `inFreeSpins` only ever comes
// from live play. RUN SIMULATION/TUNE FREQUENCIES therefore measures base-game economics only;
// building the missing plumbing is a separate feature, intentionally out of scope here.
export function evaluateBeachPartyWin(grid, paytable, paylines, linesCount, wildSymbol, scatterSymbol, { inFreeSpins = false } = {}) {
  const evalGrid = inFreeSpins
    ? grid.map((column, col) => (fullyStackedColor(grid, col) ? column.map(() => wildSymbol) : column))
    : grid;
  const winData = checkWins(evalGrid, paytable, paylines, linesCount, wildSymbol, scatterSymbol);

  const bonusTrigger = detectBonusTrigger(grid);
  const jackpotHit = inFreeSpins && detectJackpot(grid);
  const scatterWin = (bonusTrigger.count > 0 || jackpotHit)
    ? { ...bonusTrigger, payout: jackpotHit ? JACKPOT_MULTIPLIER : 0, jackpot: jackpotHit }
    : null;

  return { ...winData, scatterWin };
}

// The live engine's own winEvaluator - a thin wrapper supplying inFreeSpins from the module's
// own `engine` binding (declared and assigned in initGame(), below). Not used by tests directly
// (they call evaluateBeachPartyWin, which takes inFreeSpins as a plain argument instead).
export const winEvaluator = (grid, paytable, paylines, linesCount, wildSymbol, scatterSymbol) =>
  evaluateBeachPartyWin(grid, paytable, paylines, linesCount, wildSymbol, scatterSymbol, { inFreeSpins: engine?.inFreeSpins === true });

const GAME_ASSET_MANIFEST = {
  symbols: { url: './assets/symbols/symbols.tiles.json', type: 'tilemap' },
  music: { url: './assets/music/pacific_drift_theme.mp3', type: 'music' },
  musicFreeSpins: { url: './assets/music/pixel_drift.mp3', type: 'music' },
  viewportBackground: { url: './assets/backgrounds/beach_lifeguard_hut_2.png', type: 'image' },
  freeSpinsViewportBackground: { url: './assets/backgrounds/boards_on_the_beach.png', type: 'image' },
};

const DEBUG_MODE = true; // Set to false in production - matches every other game's own flag.

let engine = null;
let pendingBonusSpinsAward = 0;
let refs = {};
let developerPanelsRef = null;

async function initGame() {
  refs = {
    canvas: document.getElementById('game-canvas'),
    spin: document.getElementById('btn-spin'), auto: document.getElementById('btn-auto'),
    turbo: document.getElementById('btn-turbo'), mute: document.getElementById('btn-mute'),
    paytable: document.getElementById('btn-paytable'), paytableOk: document.getElementById('btn-paytable-ok'),
    balance: document.getElementById('display-balance'), bet: document.getElementById('bet-value'),
    betMinus: document.getElementById('bet-minus'), betPlus: document.getElementById('bet-plus'),
    totalBet: document.getElementById('display-total-bet'), lines: document.getElementById('lines-value'),
    linesMinus: document.getElementById('lines-minus'), linesPlus: document.getElementById('lines-plus'),
    ticker: document.getElementById('game-ticker'),
    sim: document.getElementById('btn-sim'), tune: document.getElementById('btn-tune'), spinlog: document.getElementById('btn-spinlog'),
    paytableModal: document.getElementById('modal-paytable'),
    fsTriggerModal: document.getElementById('modal-fs-trigger'), fsSummaryModal: document.getElementById('modal-fs-summary'),
    btnStartFs: document.getElementById('btn-start-fs'), btnCloseFsSummary: document.getElementById('btn-close-fs-summary'),
    fsAwardAmount: document.getElementById('fs-award-amount'),
    fsPanel: document.getElementById('fs-panel'), fsCounter: document.getElementById('fs-counter'), fsTotalWin: document.getElementById('fs-total-win'),
    cheatBonus: document.getElementById('cheat-scatter'), cheatBigWin: document.getElementById('cheat-bigwin'),
    debugShortcuts: document.querySelector('.debug-shortcuts'),
  };
  if (refs.debugShortcuts && DEBUG_MODE) refs.debugShortcuts.classList.add('debug-enabled');

  developerPanelsRef = ensureDeveloperPanels();
  const renderer = new SlotRenderer();

  engine = new CoreSlotEngine(refs.canvas, {
    mechanic: LineMechanic,
    animator: new ReelScrollAnimator(renderer),
    renderer,
    spinLogRecorder: new SpinLogRecorder({ betPerLine: BET_PER_LINE, linesCount: LINES_COUNT, scatterSymbol: BONUS_SYMBOL }),
    audioController: new AudioController(),

    reelsCount: REELS_COUNT, rowsCount: ROWS_COUNT,
    paytable: PAYTABLE, reelStrips: REEL_STRIPS, paylines: PAYLINES,
    wildSymbol: WILD_SYMBOL,
    // Only used by the debug forceWinResult('scatter') cheat (see _buildForcedGrid in
    // CoreSlotEngine.js) - lands 'bonus' on reels 0/2/4, which happens to be exactly
    // BONUS_REEL_INDEXES for a 5-reel grid. The live win evaluator ignores this field entirely,
    // computing its own reel-restricted trigger from the raw grid (see detectBonusTrigger).
    scatterSymbol: BONUS_SYMBOL,
    winEvaluator,
    betPerLine: BET_PER_LINE, linesCount: LINES_COUNT,

    symbolAspectRatio: 2, // 256x128 tiles - wide cells, new to this game (see GridLayout.js).
    stackedSymbols: STACKED_SYMBOLS,
    // Flush win-highlight boxes (SlotRenderer.drawWinEffects) instead of every other game's
    // 4px inset - this game only, other games keep the default.
    winHighlightInset: 0,
    // Beach Party leans on its own photo backgrounds rather than a themed cabinet: no frame/
    // glow border around the reels, and a much lighter reels-area tint (SlotRenderer's default
    // rgba(10,10,15,0.85) nearly blacks out the background art) so the beach art stays visible
    // behind the symbols.
    playfield: {
      frame: 'transparent',
      outline: 'transparent',
      reelsBackground: 'rgba(4, 20, 22, 0.28)',
    },

    assetManifest: GAME_ASSET_MANIFEST,
    // `image`/`main`/`freespins` below are GAME_ASSET_MANIFEST keys, not literal paths - resolved
    // against the loaded asset map (SlotRenderer.drawViewportBackground / CoreSlotEngine.loadAssets),
    // so both go through AssetLoader's own URL resolution and preloading instead of a raw string.
    viewportBackground: { type: 'image', image: 'viewportBackground' },
    freeSpinsViewportBackground: { type: 'image', image: 'freeSpinsViewportBackground' },
    // Per-state theme music (CoreSlotEngine/SlotAudio's { main, freespins } mechanism, unused by
    // every other game so far) - Beach Bonus gets its own track instead of looping the base theme
    // through the bonus round.
    music: {
      main: 'music',
      freespins: 'musicFreeSpins',
    },

    onStateChange: state => updateSlotStateUI({
      engine, state, refs: { spin: refs.spin, ticker: refs.ticker }, onUpdate: updateUI,
      messages: {
        spinning: 'SPINNING...', stopping: 'STOPPING...',
        // Reef Royale jackpot gets its own ticker message instead of the generic win amount -
        // engine.winData is the same object SlotRenderer._drawLine already reads, carrying the
        // scatterWin evaluateBeachPartyWin returned for this spin, jackpot flag included.
        showing_wins: game => (game.winData?.scatterWin?.jackpot
          ? `\u{1F389} REEF ROYALE JACKPOT! +$${game.lastWin.toFixed(2)}`
          : `WIN: $${game.lastWin.toFixed(2)}!`),
        free_spins_intro: 'BEACH BONUS!', game_over: 'BEACH BONUS COMPLETE!', idle: 'IDLE',
      },
      onGameOver: handleBonusComplete,
    }),
    onScatterTrigger: (count, isInFreeSpins) => handleBonusTrigger(count, isInFreeSpins),
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
  refs.balance.textContent = `$${engine.balance.toFixed(2)}`;
  refs.bet.textContent = engine.betPerLine.toFixed(2);
  refs.lines.innerHTML = `<sup>${engine.linesCount}</sup>/<sub>${LINES_COUNT}</sub>`;
  refs.totalBet.textContent = `$${engine.totalBet.toFixed(2)}`;

  if (engine.inFreeSpins) {
    refs.fsPanel.classList.add('active');
    refs.fsCounter.textContent = `BEACH BONUS: ${engine.freeSpinsRemaining} / ${engine.freeSpinsTotal}`;
  } else {
    refs.fsPanel.classList.remove('active');
  }
}

function buildPaytableContent() {
  renderLinePaytable({
    container: document.getElementById('paytable-grid-content'), paytable: PAYTABLE, paylines: PAYLINES,
    reelsCount: REELS_COUNT, assets: engine?.assets, scatterTriggerCount: BONUS_REEL_INDEXES.length,
    freeSpinsAward: BONUS_SPINS_AWARD, paylinePreviewContainer: document.getElementById('paylines-preview'),
  });
}

// Bonus lifecycle - game code decides everything, CoreSlotEngine only provides the mechanism
// (enterFreeSpinsIntro/enterFreeSpins/retriggerFreeSpins/exitFreeSpins). No expanding symbol
// here (that's the separate Book-of-Dead-style mechanic this game doesn't use) - Beach Bonus's
// own stacked-wild/jackpot rules live entirely inside winEvaluator (above), gated on
// engine.inFreeSpins, so enterFreeSpins is called with expandingSymbol = null.
function handleBonusTrigger(count, isInFreeSpins) {
  if (isInFreeSpins) {
    engine.retriggerFreeSpins(BONUS_SPINS_AWARD);
    refs.ticker.textContent = `+${BONUS_SPINS_AWARD} MORE BONUS SPINS!`;
    engine.audio.playScatterTrigger();
    updateUI();
    return;
  }

  pendingBonusSpinsAward = BONUS_SPINS_AWARD;
  engine.enterFreeSpinsIntro();
  refs.fsAwardAmount.textContent = BONUS_SPINS_AWARD;
  refs.fsTriggerModal.classList.add('active');
  engine.audio.playScatterTrigger();
}

function startBonus() {
  refs.fsTriggerModal.classList.remove('active');
  engine.enterFreeSpins(pendingBonusSpinsAward, null);
}

function handleBonusComplete() {
  refs.fsTotalWin.textContent = `$${engine.freeSpinsAccumulatedWin.toFixed(2)}`;
  refs.fsSummaryModal.classList.add('active');
  engine.audio.playScatterTrigger();
}

function closeBonusSummary() {
  refs.fsSummaryModal.classList.remove('active');
  engine.returnToIdle();
  updateUI();
  engine.handleAutoPlay();
}

function setupUIHandlers() {
  refs.spin.addEventListener('click', () => {
    if (engine.state !== 'idle' && engine.state !== 'showing_wins') engine.stopSpin();
    else engine.requestSpin();
  });

  refs.betMinus.addEventListener('click', () => {
    if (engine.state !== 'idle' && engine.state !== 'showing_wins') return;
    if (engine.betPerLine > BET_PER_LINE_STEP + 1e-9) {
      engine.betPerLine = Math.round((engine.betPerLine - BET_PER_LINE_STEP) * 100) / 100;
      engine.updateBet();
      updateUI();
    }
  });

  refs.betPlus.addEventListener('click', () => {
    if (engine.state !== 'idle' && engine.state !== 'showing_wins') return;
    const newBetPerLine = Math.round((engine.betPerLine + BET_PER_LINE_STEP) * 100) / 100;
    const newTotalBet = newBetPerLine * engine.linesCount;
    if (newBetPerLine <= BET_PER_LINE_MAX + 1e-9 && engine.balance >= newTotalBet) {
      engine.betPerLine = newBetPerLine;
      engine.updateBet();
      updateUI();
    }
  });

  refs.linesMinus.addEventListener('click', () => {
    if (engine.state !== 'idle' && engine.state !== 'showing_wins') return;
    if (engine.linesCount > 1) {
      engine.linesCount--;
      engine.updateBet();
      updateUI();
    }
  });

  refs.linesPlus.addEventListener('click', () => {
    if (engine.state !== 'idle' && engine.state !== 'showing_wins') return;
    const newLinesCount = engine.linesCount + 1;
    const newTotalBet = engine.betPerLine * newLinesCount;
    if (newLinesCount <= LINES_COUNT && engine.balance >= newTotalBet) {
      engine.linesCount = newLinesCount;
      engine.updateBet();
      updateUI();
    }
  });

  refs.auto.addEventListener('click', () => {
    engine.autoPlay = !engine.autoPlay;
    refs.auto.classList.toggle('active', engine.autoPlay);
    if (engine.autoPlay && engine.state === 'idle') engine.spin();
  });

  refs.turbo.addEventListener('click', () => {
    engine.turboMode = !engine.turboMode;
    refs.turbo.classList.toggle('active', engine.turboMode);
  });

  refs.mute.addEventListener('click', () => {
    const isMuted = engine.audio.toggleMute();
    refs.mute.textContent = isMuted ? '\u{1F507} Sound OFF' : '\u{1F50A} Sound ON';
    refs.mute.classList.toggle('active', isMuted);
  });

  refs.paytable.addEventListener('click', () => refs.paytableModal.classList.add('active'));
  refs.paytableOk.addEventListener('click', () => refs.paytableModal.classList.remove('active'));
  document.querySelectorAll('.btn-modal-close').forEach(btn => {
    btn.addEventListener('click', () => {
      const overlay = btn.closest('.modal-overlay');
      if (overlay) { overlay.classList.remove('active'); return; }
      const simModalEl = btn.closest('.sim-modal');
      if (simModalEl) simModalEl.style.display = 'none';
    });
  });

  if (refs.btnStartFs) refs.btnStartFs.addEventListener('click', startBonus);
  if (refs.btnCloseFsSummary) refs.btnCloseFsSummary.addEventListener('click', closeBonusSummary);

  if (refs.sim) refs.sim.addEventListener('click', () => runSimulationAndRender({
    engine, paytable: PAYTABLE, betPerLine: BET_PER_LINE, linesCount: LINES_COUNT, numSpins: 200000,
    domRefs: { btnSim: refs.sim, simModal: developerPanelsRef.simulation },
  }));
  if (refs.tune) refs.tune.addEventListener('click', () => openTuningPanel({
    paytable: PAYTABLE, reelFrequencyTables: FREQUENCY_REELS, panel: developerPanelsRef.tuning,
    tuneConfig: {
      reelsCount: REELS_COUNT, rowsCount: ROWS_COUNT, paylines: PAYLINES, scatterSymbol: BONUS_SYMBOL,
      reelSeeds: REEL_SEEDS, betPerLine: BET_PER_LINE, linesCount: LINES_COUNT, reelLength: REEL_LENGTH,
    },
  }));
  if (refs.spinlog) refs.spinlog.addEventListener('click', () => openSpinLogPanel({ engine, domRefs: { panel: developerPanelsRef.spinLog } }));

  if (DEBUG_MODE) {
    if (refs.cheatBonus) refs.cheatBonus.addEventListener('click', () => engine.forceWinResult('scatter'));
    if (refs.cheatBigWin) refs.cheatBigWin.addEventListener('click', () => engine.forceWinResult('bigwin'));
  }
}

export { initGame };

if (typeof window !== 'undefined') window.addEventListener('load', initGame);
