// Game Coordinator for Book of Book Book Slot Machine
import { SlotEngine } from '../../core/SlotEngine.js';
import { generateReel } from '../../core/SlotMath.js';
import { runSimulationAndRender, openTuneFrequenciesPanel } from '../../core/SimulationPanel.js';
import { openSpinLogPanel } from '../../core/SpinLogPanel.js';

// Grid/reel parameters shared by the live game, the RUN SIMULATION button, and the
// frequency tuner - a single source of truth so all three actually model the same reels
// instead of the simulation/tuner silently drifting onto their own hardcoded defaults.
const REELS_COUNT = 5;
const ROWS_COUNT = 3;
const REEL_SEEDS = [1234, 567, 89, 765, 3321];
const BET_PER_LINE = 0.10;
const BET_PER_LINE_STEP = 0.10;
const BET_PER_LINE_MAX = 100;
const LINES_COUNT = 10;

// Payline definitions - previously lived in core/SlotMath.js as a shared default;
// each game now owns its own paylines so the core stays grid-shape-agnostic.
const PAYLINES = [
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

// 1. Paytable Config (Classic Book of Dead/Ra multipliers)
// Rules only (payout, type, paymode, wild, triggerFreeSpins, friendlyName) - no `.frequency`
// field. Frequencies live only on the per-reel FREQUENCY_REELn tables below (same model as
// games/fruitmachine/game.js) - see tuneFrequencies' own docs in core/SpinSimulator.js for
// why frequencies must come from the reels, not the paytable.
const PAYTABLE = {
  book:     { payout: [0,  0,   2,   20,  200], type: 'scatter', paymode: 'any',  wild: false, triggerFreeSpins: true,  friendlyName: 'Book of Books' },
  explorer: { payout: [0, 10, 100, 1000, 5000], type: 'premium', paymode: 'line', wild: false, triggerFreeSpins: false, friendlyName: 'The Explorer' },
  tut:      { payout: [0,  5,  40,  400, 2000], type: 'premium', paymode: 'line', wild: false, triggerFreeSpins: false, friendlyName: 'Tutankhamun' },
  anubis:   { payout: [0,  5,  30,  100,  750], type: 'premium', paymode: 'line', wild: false, triggerFreeSpins: false, friendlyName: 'Anubis Guard' },
  scarab:   { payout: [0,  5,  30,  100,  750], type: 'premium', paymode: 'line', wild: false, triggerFreeSpins: false, friendlyName: 'Scarab Beetle' },
  ace:      { payout: [0,  0,   5,   40,  150], type: 'regular', paymode: 'line', wild: false, triggerFreeSpins: false, friendlyName: 'Golden Ace' },
  king:     { payout: [0,  0,   5,   40,  150], type: 'regular', paymode: 'line', wild: false, triggerFreeSpins: false, friendlyName: 'Pharaoh King' },
  queen:    { payout: [0,  0,   5,   30,  100], type: 'regular', paymode: 'line', wild: false, triggerFreeSpins: false, friendlyName: 'Royal Queen' },
  jack:     { payout: [0,  0,   5,   30,  100], type: 'regular', paymode: 'line', wild: false, triggerFreeSpins: false, friendlyName: 'Desert Jack' },
  ten:      { payout: [0,  0,   5,   30,  100], type: 'regular', paymode: 'line', wild: false, triggerFreeSpins: false, friendlyName: 'Lucky Ten' },
};

// ---- Tuned 2026-07-26 ----
// Achieved: RTP 96.56%  |  free-spin trigger 0.539%
//
// To reproduce this exact run, the tuner needs all of the following - same searchSeed AND
// same reel geometry, since strips are generated from them:
//   searchSeed 12345   reelSeeds [1234, 567, 89, 765, 3321]
//   reelLength 500   reels 5 x 3 rows
//   target RTP 96% +/-1.5   target trigger 0.6% +/-0.15
//   100,000 spins x 4 trials   cmaes, max 150 iterations
//   initial weights: provided   max RTP std error 1
//   loss weights: ordering 1, limit 0.5, uniformity 0.75, stdError 2, triggerRate 0, spacing 0
//   ordering bias by reel: [1, 1, -1, -1, 0]
//
// REEL_LENGTH is part of the result, not a separate setting - these frequencies were tuned
// against this length and do not reproduce the RTP above at any other.
export const REEL_LENGTH = 500;

export const FREQUENCY_REEL1 = {
  defaults: { minFrequency: 0, maxFrequency: 1 },
  symbols: {
    book:     { frequency: 0.051, minGap: 3, maxStack: 1 },
    explorer: { frequency: 0.1254 },
    tut:      { frequency: 0.2348 },
    anubis:   { frequency: 0.2456 },
    scarab:   { frequency: 0.3618 },
    ace:      { frequency: 0.1815 },
    king:     { frequency: 0.1819 },
    queen:    { frequency: 0.09743 },
    jack:     { frequency: 0.08196 },
    ten:      { frequency: 0.1987 },
  },
};

export const FREQUENCY_REEL2 = {
  defaults: { minFrequency: 0, maxFrequency: 1 },
  symbols: {
    book:     { frequency: 0.051, minGap: 3, maxStack: 1 },
    explorer: { frequency: 0.0799 },
    tut:      { frequency: 0.3301 },
    anubis:   { frequency: 0.4368 },
    scarab:   { frequency: 0.1495 },
    ace:      { frequency: 0.15 },
    king:     { frequency: 0.1922 },
    queen:    { frequency: 0.0399 },
    jack:     { frequency: 0.2116 },
    ten:      { frequency: 0.1188 },
  },
};

export const FREQUENCY_REEL3 = {
  defaults: { minFrequency: 0, maxFrequency: 1 },
  symbols: {
    book:     { frequency: 0.051, minGap: 3, maxStack: 1 },
    explorer: { frequency: 0.01107 },
    tut:      { frequency: 0.04584 },
    anubis:   { frequency: 0.08015 },
    scarab:   { frequency: 0.1573 },
    ace:      { frequency: 0.2109 },
    king:     { frequency: 0.3279 },
    queen:    { frequency: 0.1773 },
    jack:     { frequency: 0.1307 },
    ten:      { frequency: 0.5677 },
  },
};

export const FREQUENCY_REEL4 = {
  defaults: { minFrequency: 0, maxFrequency: 1 },
  symbols: {
    book:     { frequency: 0.051, minGap: 3, maxStack: 1 },
    explorer: { frequency: 0.2864 },
    tut:      { frequency: 0.06792 },
    anubis:   { frequency: 0.2197 },
    scarab:   { frequency: 0.1836 },
    ace:      { frequency: 0.08335 },
    king:     { frequency: 0.1286 },
    queen:    { frequency: 0.2444 },
    jack:     { frequency: 0.2964 },
    ten:      { frequency: 0.1988 },
  },
};

export const FREQUENCY_REEL5 = {
  defaults: { minFrequency: 0, maxFrequency: 1 },
  symbols: {
    book:     { frequency: 0.051, minGap: 3, maxStack: 1 },
    explorer: { frequency: 0.05194 },
    tut:      { frequency: 0.09915 },
    anubis:   { frequency: 0.3734 },
    scarab:   { frequency: 0.1399 },
    ace:      { frequency: 0.1814 },
    king:     { frequency: 0.1599 },
    queen:    { frequency: 0.4149 },
    jack:     { frequency: 0.1221 },
    ten:      { frequency: 0.1664 },
  },
};
const FREQUENCY_REELS = [FREQUENCY_REEL1, FREQUENCY_REEL2, FREQUENCY_REEL3, FREQUENCY_REEL4, FREQUENCY_REEL5];

// Symbols eligible to be picked as the free spins expanding symbol - anything that
// isn't a scatter (scatter symbols trigger free spins, they can't also expand during them).
const EXPANDING_CANDIDATES = Object.keys(PAYTABLE).filter(s => PAYTABLE[s].type !== 'scatter');

// Extra free spins awarded by a retrigger (2+ scatters landing during an active free-spins
// round), by scatter count - unlike barfruits, the INITIAL trigger always awards a flat 10
// regardless of scatter count (see startFreeSpins below); only a retrigger's award scales
// with how many scatters landed. The `2` entry is presently unreachable in real play (checkWins'
// default scatterTriggerCount of 3 means book never actually produces a scatterWin at exactly
// 2), kept here anyway to document the intended schedule rather than silently drop it.
const RETRIGGER_FREE_SPINS_AWARD = { 2: 5, 3: 10, 4: 15, 5: 20 };

// 2. Reel Strips Generation (Randomized for each reel, from each reel's own frequency table).
// PAYTABLE is passed as the 6th arg so generateReel's default minGap spacing can read
// PAYTABLE.book.triggerFreeSpins, since these per-reel tables don't carry that field
// themselves (see generateReel's own doc in core/SlotMath.js).
const REEL_STRIPS = FREQUENCY_REELS.map((freqTable, i) => generateReel(freqTable, REEL_LENGTH, REEL_SEEDS[i], [], 3, PAYTABLE));

// 3. UI Dom Selectors - will be initialized in load handler
let canvas, btnSpin, btnAuto, btnTurbo, btnMute, btnPaytable, btnPaytableOk;
let themeSelect, displayBalance, betValue, betMinus, betPlus, gameTicker, displayTotalBet;
let linesValue, linesMinus, linesPlus;
let btnSim, simModal, btnCloseSim, btnTune, simStats, btnSpinLog;
let simRtpDisplay, simTotalSpinsDisplay, simMaxWinDisplay, simFreeSpinsDisplay;
let modalPaytable, modalFsTrigger, modalFsSummary, btnStartFs, btnCloseFsSummary;
let fsPanel, fsCounter, fsSymbolName, fsSymbolThumbnail;
let bookRevealCanvas, bookRevealCtx, chosenSymbolReveal, fsTotalWin;
let cheatScatter, cheatExpand, cheatBigWin;

// Debug mode - only enable cheat buttons in development
const DEBUG_MODE = true; // Set to false in production


let engine = null;
let currentTheme = 'style_4';  // Default theme

// 4. Async Theme Config Loader
async function loadThemeAssets(themeName) {
  try {
    const response = await fetch(`./assets/${themeName}/${themeName}.tiles.json`);
    const data = await response.json();
    
    // Convert tiles array into symbol mapping config
    const symbolsConfig = {};
    data.tiles.forEach(tile => {
      symbolsConfig[tile.name] = {
        x: tile.x,
        y: tile.y,
        w: tile.w,
        h: tile.h
      };
    });

    const spritesheetUrl = `./assets/${themeName}/${data.sheet}`;
    
    return { spritesheetUrl, symbolsConfig };
  } catch (error) {
    console.error(`Failed to fetch tile config for theme: ${themeName}`, error);
    // Return empty fallback
    return null;
  }
}

// 5. Initialize game on window load
window.addEventListener('load', async () => {
  // Initialize all DOM references
  canvas = document.getElementById('game-canvas');
  btnSpin = document.getElementById('btn-spin');
  btnAuto = document.getElementById('btn-auto');
  btnTurbo = document.getElementById('btn-turbo');
  btnMute = document.getElementById('btn-mute');
  btnPaytable = document.getElementById('btn-paytable');
  btnPaytableOk = document.getElementById('btn-paytable-ok');
  themeSelect = document.getElementById('theme-select');
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
  simModal = document.getElementById('sim-modal');
  btnCloseSim = document.getElementById('btn-close-sim');
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

  fsPanel = document.getElementById('fs-panel');
  fsCounter = document.getElementById('fs-counter');
  fsSymbolName = document.getElementById('fs-symbol-name');
  fsSymbolThumbnail = document.getElementById('fs-symbol-thumbnail');

  bookRevealCanvas = document.getElementById('book-reveal-canvas');
  bookRevealCtx = bookRevealCanvas.getContext('2d');
  chosenSymbolReveal = document.getElementById('chosen-symbol-reveal');
  fsTotalWin = document.getElementById('fs-total-win');

  cheatScatter = document.getElementById('cheat-scatter');
  cheatExpand = document.getElementById('cheat-expand');
  cheatBigWin = document.getElementById('cheat-bigwin');

  // Enable cheat buttons only in debug mode
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
      openTuneFrequenciesPanel({
        paytable: PAYTABLE,
        reelFrequencyTables: FREQUENCY_REELS,
        tuneConfig: {
          reelsCount: REELS_COUNT,
          rowsCount: ROWS_COUNT,
          paylines: PAYLINES,
          scatterSymbol: 'book',
          reelSeeds: REEL_SEEDS,
          betPerLine: BET_PER_LINE,
          linesCount: LINES_COUNT,
          reelLength: REEL_LENGTH,
          // freeSpinsAwardTable is deliberately omitted - the initial trigger always awards a
          // flat 10 (see startFreeSpins), which is simulateSpins' own default when no table is
          // given. Retriggers scale by scatter count instead (RETRIGGER_FREE_SPINS_AWARD) -
          // without this, tuned RTP estimates missed the retrigger mechanic entirely.
          retriggerFreeSpinsAwardTable: RETRIGGER_FREE_SPINS_AWARD,
          // This game's free spins DO include the Book-of-Dead-style expanding wild (see
          // handleInitialFreeSpinsTrigger/EXPANDING_CANDIDATES below) - without opting in here,
          // simulateSpins now assumes no expanding-wild mechanic at all (see its own doc for why
          // that default changed) and tuned RTP would miss a real, meaningful chunk of this
          // game's payout.
          hasExpandingWild: true,
        },
        domRefs: { simModal, simStats },
      });
    });
  }
  if (btnSpinLog) {
    btnSpinLog.addEventListener('click', () => {
      openSpinLogPanel({ engine, domRefs: { simModal, simStats } });
    });
  }
  if (btnCloseSim) {
    btnCloseSim.addEventListener('click', () => {
      simModal.style.display = 'none';
    });
  }

  const themeAssets = await loadThemeAssets(currentTheme);
  if (!themeAssets) {
    alert("Error loading assets!");
    return;
  }

  // Create slot engine instance
  engine = new SlotEngine(canvas, {
    reelsCount: REELS_COUNT,
    rowsCount: ROWS_COUNT,
    paytable: PAYTABLE,
    reelStrips: REEL_STRIPS,
    paylines: PAYLINES,
    wildSymbol: null,
    scatterSymbol: 'book',
    symbolsConfig: themeAssets.symbolsConfig,
    spritesheetUrl: themeAssets.spritesheetUrl,
    betPerLine: BET_PER_LINE,
    linesCount: LINES_COUNT,
    // Read by engine.runSimulation() (-> simulateSpins) so RUN SIMULATION matches this game's
    // real retrigger schedule instead of assuming no retriggers at all.
    retriggerFreeSpinsAwardTable: RETRIGGER_FREE_SPINS_AWARD,
    // This game's free spins really do include an expanding wild (see EXPANDING_CANDIDATES) -
    // without this, RUN SIMULATION would assume no expanding-wild mechanic at all.
    hasExpandingWild: true,

    onStateChange: (state) => handleStateChange(state),
    onScatterTrigger: (scatterCount, isInFreeSpins) => handleScatterTrigger(scatterCount, isInFreeSpins),
    onWin: (winInfo) => handleWin(winInfo)
  });

  // Load balance and bet sizes
  updateUI();
  setupUIHandlers();
  buildPaytableContent();
});

// Update UI text values
function updateUI() {
  if (!engine) return;
  displayBalance.textContent = `$${engine.balance.toFixed(0)}`;
  betValue.textContent = engine.betPerLine.toFixed(2);
  linesValue.textContent = `${engine.linesCount} / ${LINES_COUNT}`;
  displayTotalBet.textContent = `$${engine.totalBet.toFixed(2)}`;
}

// 6. Handle state changes from the engine
function handleStateChange(state) {
  updateUI();

  // Update central spin button
  if (state === 'spinning') {
    btnSpin.textContent = 'STOP';
    btnSpin.className = 'btn-spin spinning';
    gameTicker.textContent = 'SPINNING...';
  } else if (state === 'stopping') {
    btnSpin.textContent = 'STOP';
    btnSpin.className = 'btn-spin spinning';
    gameTicker.textContent = 'STOPPING...';
  } else {
    btnSpin.textContent = 'SPIN';
    btnSpin.className = 'btn-spin';
    
    if (state === 'showing_wins') {
      const winVal = engine.lastWin;
      gameTicker.textContent = `WIN: $${winVal.toFixed(0)}!`;
    } else if (state === 'expanding') {
      gameTicker.textContent = `EXPANDING SYMBOLS!`;
    } else if (state === 'free_spins_intro') {
      gameTicker.textContent = `SCATTER TRIGGER!`;
    } else if (state === 'game_over') {
      gameTicker.textContent = `FREE SPINS COMPLETE!`;
      handleFreeSpinsComplete();
    } else {
      gameTicker.textContent = 'IDLE';
    }
  }

  // Update Free Spins Indicators
  if (engine.inFreeSpins) {
    fsPanel.classList.add('active');
    fsCounter.textContent = `FREE SPINS: ${engine.freeSpinsRemaining} / ${engine.freeSpinsTotal}`;
    const friendlyName = PAYTABLE[engine.expandingSymbol].friendlyName || engine.expandingSymbol;
    fsSymbolName.textContent = friendlyName;
    
    // Set thumbnail image position
    const tile = engine.config.symbolsConfig[engine.expandingSymbol];
    if (tile) {
      fsSymbolThumbnail.style.backgroundImage = `url('${engine.config.spritesheetUrl}')`;
      
      // Calculate background offsets (scale down from spritesheet coordinate size)
      const scale = 32 / tile.w;
      fsSymbolThumbnail.style.backgroundSize = `${tile.w * scale}px ${tile.h * scale}px`;
      fsSymbolThumbnail.style.backgroundPosition = `-${tile.x * scale}px -${tile.y * scale}px`;
    }
  } else {
    fsPanel.classList.remove('active');
  }
}

// 7. Free Spins Modes Orchestration
// Unified scatter handler — game decides what counts as initial trigger vs retrigger
function handleScatterTrigger(scatterCount, isInFreeSpins) {
  if (isInFreeSpins) {
    // Retrigger: 2+ scatters adds extra spins
    handleScatterRetrigger(scatterCount);
  } else {
    // Initial trigger: only 3+ scatters starts free spins
    if (scatterCount >= 3) {
      engine.enterFreeSpinsIntro();
      handleInitialFreeSpinsTrigger();
    }
  }
}

// Draws a strip of symbol icons (straight from the active theme's spritesheet) that
// scrolls to a stop on `chosenSymbol` — a mini slot reel rendered on canvas, using
// the same drawImage/tile-atlas approach as SlotEngine's own reel rendering.
let bookReelAnimFrame = null;

function playBookSymbolReel(chosenSymbol, durationMs) {
  if (bookReelAnimFrame) {
    cancelAnimationFrame(bookReelAnimFrame);
    bookReelAnimFrame = null;
  }

  const candidates = EXPANDING_CANDIDATES;
  const stripLength = 18;
  const stripSymbols = [];
  for (let i = 0; i < stripLength - 1; i++) {
    stripSymbols.push(candidates[Math.floor(Math.random() * candidates.length)]);
  }
  stripSymbols.push(chosenSymbol);

  const dpr = window.devicePixelRatio || 1;
  const cssW = bookRevealCanvas.clientWidth;
  const cssH = bookRevealCanvas.clientHeight;
  bookRevealCanvas.width = cssW * dpr;
  bookRevealCanvas.height = cssH * dpr;
  bookRevealCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const { symbolsConfig } = engine.config;
  const spritesheet = engine.spritesheet;
  const iconSize = cssH;
  const artSize = Math.max(0, Math.min(cssW, iconSize) - 16);
  const finalOffset = (stripSymbols.length - 1) * iconSize;
  const easeOutCubic = t => 1 - Math.pow(1 - t, 3);

  function drawFrame(offsetY) {
    bookRevealCtx.clearRect(0, 0, cssW, cssH);
    bookRevealCtx.fillStyle = '#fdf5e6';
    bookRevealCtx.fillRect(0, 0, cssW, cssH);

    stripSymbols.forEach((symbol, i) => {
      const cellY = (i * iconSize) - offsetY;
      if (cellY + iconSize < 0 || cellY > cssH) return; // skip icons outside the visible page
      const tile = symbolsConfig[symbol];
      if (!tile) return;
      const destX = (cssW - artSize) / 2;
      const destY = cellY + (iconSize - artSize) / 2;
      bookRevealCtx.drawImage(spritesheet, tile.x, tile.y, tile.w, tile.h, destX, destY, artSize, artSize);
    });
  }

  const startTime = performance.now();
  function tick(now) {
    const t = Math.min(1, (now - startTime) / durationMs);
    drawFrame(finalOffset * easeOutCubic(t));
    bookReelAnimFrame = t < 1 ? requestAnimationFrame(tick) : null;
  }

  drawFrame(0);
  bookReelAnimFrame = requestAnimationFrame(tick);
}

function handleInitialFreeSpinsTrigger() {
  btnSpin.disabled = true;
  modalFsTrigger.classList.add('active');

  const bookContainer = document.getElementById('animated-book-container');
  bookContainer.classList.remove('open');
  chosenSymbolReveal.classList.remove('reveal');
  btnStartFs.style.display = 'none';

  // Select the awarded symbol up front so the reel can land on it exactly
  const candidates = EXPANDING_CANDIDATES;
  const chosen = candidates[Math.floor(Math.random() * candidates.length)];
  const spinDuration = 1400;

  setTimeout(() => {
    // Book turns open while the page's symbol reel spins, landing together
    bookContainer.classList.add('open');
    playBookSymbolReel(chosen, spinDuration);
  }, 400);

  setTimeout(() => {
    const friendlyName = PAYTABLE[chosen].friendlyName || chosen;
    chosenSymbolReveal.textContent = `${friendlyName.toUpperCase()} SELECTED`;
    chosenSymbolReveal.classList.add('reveal');
    btnStartFs.style.display = 'inline-block';

    // Temporarily save selected symbol on engine trigger
    engine.expandingSymbol = chosen;

    // Play sound alert
    engine.audio.playScatterTrigger();
  }, 400 + spinDuration);
}

function startFreeSpins() {
  modalFsTrigger.classList.remove('active');
  btnSpin.disabled = false;
  
  // Hand control to engine with 10 free spins and selected symbol
  engine.enterFreeSpins(10, engine.expandingSymbol);
}

function handleFreeSpinsComplete() {
  fsTotalWin.textContent = `$${engine.freeSpinsAccumulatedWin.toFixed(0)}`;
  modalFsSummary.classList.add('active');
  engine.audio.playScatterTrigger();
}

function handleScatterRetrigger(scatterCount) {
  const added = RETRIGGER_FREE_SPINS_AWARD[scatterCount] || (scatterCount * 5);
  
  engine.freeSpinsTotal += added;
  engine.freeSpinsRemaining += added;
  
  // Update the free spins counter display immediately
  fsCounter.textContent = `FREE SPINS: ${engine.freeSpinsRemaining} / ${engine.freeSpinsTotal}`;
  
  // Show a brief on-screen notification
  gameTicker.textContent = `+${added} EXTRA SPINS!`;
  engine.audio.playScatterTrigger();
  
  // Reset state so the next auto-spin continues the bonus. returnToIdle() only sets state -
  // it deliberately doesn't schedule anything itself (see its own comment), so the free-spin
  // loop must be explicitly resumed here or it silently stalls after every retrigger.
  engine.returnToIdle();
  engine.handleAutoPlay();
}

function closeFreeSpinsSummary() {
  modalFsSummary.classList.remove('active');
  engine.returnToIdle();
  updateUI();
  
  // If autoplay was active, continue
  engine.handleAutoPlay();
}

function handleWin(winInfo) {
  updateUI();
}

// 8. Event Handlers Binding
function setupUIHandlers() {
  // Spin button
  btnSpin.addEventListener('click', () => {
    engine.requestSpin();
  });

  // Bet adjustments
  betMinus.addEventListener('click', () => {
    if (engine.state !== 'idle' && engine.state !== 'showing_wins') return;
    if (engine.betPerLine > BET_PER_LINE_STEP + 1e-9) {
      // Round to 2dp - repeated 0.10 steps otherwise drift (e.g. 0.6000000000000001).
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

  // Lines adjustments
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

  // Auto Toggle
  btnAuto.addEventListener('click', () => {
    engine.autoPlay = !engine.autoPlay;
    btnAuto.classList.toggle('active', engine.autoPlay);
    if (engine.autoPlay && engine.state === 'idle') {
      engine.spin();
    }
  });

  // Turbo Toggle
  btnTurbo.addEventListener('click', () => {
    engine.turboMode = !engine.turboMode;
    btnTurbo.classList.toggle('active', engine.turboMode);
  });

  // Mute Toggle
  btnMute.addEventListener('click', () => {
    const isMuted = engine.audio.toggleMute();
    btnMute.textContent = isMuted ? '🔇 Sound OFF' : '🔊 Sound ON';
    btnMute.classList.toggle('active', isMuted);
  });

  // Paytable Toggle
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

  // Theme Switcher
  themeSelect.addEventListener('change', async (e) => {
    const newTheme = e.target.value;
    currentTheme = newTheme;
    
    // Load theme assets and tell engine to swap
    const assets = await loadThemeAssets(newTheme);
    if (assets) {
      engine.loadAssets(assets.spritesheetUrl, assets.symbolsConfig);
    }
  });

  // Free spins action listeners
  if (btnStartFs) btnStartFs.addEventListener('click', startFreeSpins);
  if (btnCloseFsSummary) btnCloseFsSummary.addEventListener('click', closeFreeSpinsSummary);

  // Debug Cheat actions - only enabled in debug mode
  if (DEBUG_MODE) {
    if (cheatScatter) cheatScatter.addEventListener('click', () => engine.forceWinResult('scatter'));
    if (cheatExpand) {
      cheatExpand.addEventListener('click', () => {
        if (!engine.inFreeSpins) {
          alert("Must be in Free Spins mode to test Expanding symbols! Click Scatter Trigger cheat first.");
          return;
        }
        engine.forceWinResult('expanding');
      });
    }
    if (cheatBigWin) cheatBigWin.addEventListener('click', () => engine.forceWinResult('bigwin'));
  }
}

// 9. Render modal paytable descriptions dynamically
function buildPaytableContent() {
  const container = document.getElementById('paytable-grid-content');
  container.innerHTML = '';

  for (const [symbol, payouts] of Object.entries(PAYTABLE)) {
    const item = document.createElement('div');
    item.className = 'paytable-item';

    const title = document.createElement('span');
    title.className = 'paytable-symbol-name';
    title.textContent = PAYTABLE[symbol].friendlyName || symbol;
    item.appendChild(title);

    const payLines = document.createElement('div');
    payLines.className = 'paytable-payouts';

    // List payouts in reverse (5 hits to 2 hits)
    let content = '';
    for (let hits = 5; hits >= 2; hits--) {
      if (payouts[hits] > 0) {
        if (symbol === 'book') {
          content += `<strong>${hits}x Scatters:</strong> ${payouts[hits]}x Total Bet<br>`;
        } else {
          content += `<strong>${hits} of a kind:</strong> ${payouts[hits]}x<br>`;
        }
      }
    }
    
    // Label books wild substitution
    if (symbol === 'book') {
      content += `<em style="color:#d4af37; font-size:10px;">Acts as Wild substitute</em>`;
    }

    payLines.innerHTML = content;
    item.appendChild(payLines);
    container.appendChild(item);
  }

  // Draw miniature line previews
  const linesPreview = document.getElementById('paylines-preview');
  linesPreview.innerHTML = '';
  PAYLINES.forEach((path, idx) => {
    const div = document.createElement('div');
    div.style.cssText = `
      width: 44px;
      height: 30px;
      border: 1px solid rgba(212,175,55,0.4);
      background: #09090d;
      border-radius: 4px;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      padding: 3px;
      position: relative;
      cursor: pointer;
    `;
    div.title = `Line ${idx + 1}`;
    
    // Draw miniature path representation using small grid cells
    // 5 columns, 3 rows
    let innerHtml = '<div style="display:flex; justify-content:space-between; height:100%;">';
    for (let c = 0; c < 5; c++) {
      innerHtml += '<div style="display:flex; flex-direction:column; justify-content:space-between; height:100%; width: 5px;">';
      for (let r = 0; r < 3; r++) {
        const active = (path[c] === r);
        innerHtml += `<div style="width:5px; height:5px; border-radius:50%; background: ${active ? '#d4af37' : '#222'};"></div>`;
      }
      innerHtml += '</div>';
    }
    innerHtml += '</div>';
    innerHtml += `<span style="position:absolute; bottom:1px; right:3px; font-size:8px; font-weight:bold; color:#777;">L${idx+1}</span>`;
    
    div.innerHTML = innerHtml;
    linesPreview.appendChild(div);
  });
}
