// Game coordinator for Mayan Tumble - a 5x3 payline-based cascading slot.
import { CascadeEngine } from '../../core/CascadeEngine.js';
import { generateReel, checkWins } from '../../core/SlotMath.js';
import { openSpinLogPanel } from '../../core/SpinLogPanel.js';
import { createMultiplierTilesMode } from '../../core/FreeSpinsModes.js';
import { CascadeSpinMechanic } from '../../core/CascadeSpinMechanic.js';
import { runSimulationAndRender, openTuneFrequenciesPanel } from '../../core/SimulationPanel.js';

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

// Initial, approximate frequencies before running the tuner.
export const REEL_LENGTH = 500;

const DEFAULT_FREQ = {
  defaults: { minFrequency: 0.01, maxFrequency: 1.0 },
  symbols: {
    gold:     { frequency: 0.05, minGap: 3, maxStack: 1 },
    llama:    { frequency: 0.04 },
    face:     { frequency: 0.07 },
    maise:    { frequency: 0.12 },
    head:     { frequency: 0.12 },
    jaguar:   { frequency: 0.15 },
    ace:      { frequency: 0.22 },
    king:     { frequency: 0.22 },
    queen:    { frequency: 0.28 },
    jack:     { frequency: 0.28 },
    ten:      { frequency: 0.32 },
  }
};

export const FREQUENCY_REEL1 = JSON.parse(JSON.stringify(DEFAULT_FREQ));
export const FREQUENCY_REEL2 = JSON.parse(JSON.stringify(DEFAULT_FREQ));
export const FREQUENCY_REEL3 = JSON.parse(JSON.stringify(DEFAULT_FREQ));
export const FREQUENCY_REEL4 = JSON.parse(JSON.stringify(DEFAULT_FREQ));
export const FREQUENCY_REEL5 = JSON.parse(JSON.stringify(DEFAULT_FREQ));

export const FREQUENCY_REELS = [FREQUENCY_REEL1, FREQUENCY_REEL2, FREQUENCY_REEL3, FREQUENCY_REEL4, FREQUENCY_REEL5];

export const REEL_STRIPS = FREQUENCY_REELS.map((freqTable, i) => generateReel(freqTable, REEL_LENGTH, REEL_SEEDS[i], [], 3, PAYTABLE));

const winEvaluator = (grid) => checkLineCascadeWins(grid, PAYTABLE, 'gold', SCATTER_TRIGGER_COUNT, PAYLINES, null);

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
const THEME_NAME = 'mayan';

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
        betPerLine: BET_AMOUNT / PAYLINES.length,
        linesCount: PAYLINES.length,
        numSpins: 100000,
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
          scatterSymbol: 'gold',
          reelSeeds: REEL_SEEDS,
          betPerLine: BET_AMOUNT / PAYLINES.length,
          linesCount: PAYLINES.length,
          // Not optional here the way it is for a cluster game. Trials run in Worker threads, and
          // a closure cannot cross postMessage - the worker rebuilds this game's evaluator from
          // `winEvaluatorName` plus whatever primitives the config carries (see
          // core/mechanicRegistry.js). checkLineCascadeWins is a LINE evaluator, so without the
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
    paylines: PAYLINES,
    // Stone and jungle rather than the engine's default candy pink-on-purple, which is Candy
    // Frenzy's look and was showing through under this game's art. No ruled cells: this is a
    // payline game, so a win is a path across the grid rather than a shape made of cells, and the
    // lines only made the playfield look like a spreadsheet. The grain replaces them - it gives
    // the surface something to be without drawing anything the player has to read.
    playfield: {
      backdropInner: '#16281c',
      backdropOuter: '#050c07',
      outline: '#dfb239',
      outlineGlow: 6,
      frame: '#0b120d',
      gridLines: null,
      noise: { color: [156, 196, 140], strength: 0.16, scale: 5, seed: 20260727 },
      loadingBackground: '#0a1410',
      loadingColor: '#dfb239',
      loadingText: 'ENTERING THE TEMPLE...',
    },
    winEvaluator,
    scatterSymbol: 'gold',
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
    gameTicker.textContent = state === 'dropping_in' ? 'TUMBLING IN...' : 'CASCADING...';
  } else if (state === 'clearing') {
    gameTicker.textContent = 'MAYAN WIN!';
  } else {
    btnSpin.textContent = 'SPIN';
    btnSpin.className = 'btn-spin';

    if (state === 'showing_wins') {
      gameTicker.textContent = `WIN: $${engine.lastWin.toFixed(2)}!`;
    } else if (state === 'free_spins_intro') {
      gameTicker.textContent = 'TEMPLE BONUS TRIGGER!';
    } else if (state === 'game_over') {
      gameTicker.textContent = 'BONUS ROUND COMPLETE!';
      handleFreeSpinsComplete();
    } else {
      gameTicker.textContent = 'TEMPLE OF GOLD';
    }
  }
}

function handleWin(winInfo) {
  updateUI();
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
    if (meta.payout) {
      if (meta.type === 'scatter') {
        const p = meta.payout;
        content += `<strong>3+ Scatters:</strong> ${p[2]}x total bet<br>`;
        content += `<strong>4+ Scatters:</strong> ${p[3]}x total bet<br>`;
        content += `<strong>5+ Scatters:</strong> ${p[4]}x total bet<br>`;
        content += `<em style="color:#ffe94a; font-size:10px;">3+ Scatters also trigger ${FREE_SPINS_AWARD} Free Spins!</em>`;
      } else {
        const p = meta.payout;
        content += `<strong>3 matching:</strong> ${p[2]}x line bet<br>`;
        content += `<strong>4 matching:</strong> ${p[3]}x line bet<br>`;
        content += `<strong>5 matching:</strong> ${p[4]}x line bet<br>`;
      }
    }

    payLines.innerHTML = content;
    item.appendChild(payLines);
    container.appendChild(item);
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('load', initGame);
}
