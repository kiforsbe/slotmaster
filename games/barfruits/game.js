// Game Coordinator for Bar Fruits Slot Machine
import { SlotEngine } from '../../core/SlotEngine.js';
import { generateReel } from '../../core/SlotMath.js';
import { runSimulationAndRender, openTuneFrequenciesPanel } from '../../core/SimulationPanel.js';

// Grid/reel parameters shared by the live game, the RUN SIMULATION button, and the
// frequency tuner - a single source of truth so all three actually model the same reels
// instead of the simulation/tuner silently drifting onto their own hardcoded defaults.
export const REELS_COUNT = 5;
export const ROWS_COUNT = 4;
export const REEL_LENGTH = 500;
export const REEL_SEEDS = [4231, 8765, 123, 9981, 5567];
export const BET_PER_LINE = 0.10;
export const BET_PER_LINE_STEP = 0.10;
export const BET_PER_LINE_MAX = 10;
export const LINES_COUNT = 20;

// Payline definitions - 5 reels x 4 rows, 20 fixed lines (a standard count for this grid
// size - not all-ways/megaways). Straight rows, then progressively deeper V/inverted-V,
// W/M, step, and zigzag shapes so the extra 4th row actually gets used, not just tacked on.
export const PAYLINES = [
  [0, 0, 0, 0, 0], // Line 1: Row 1 (Top)
  [1, 1, 1, 1, 1], // Line 2: Row 2 (Upper-Middle)
  [2, 2, 2, 2, 2], // Line 3: Row 3 (Lower-Middle)
  [3, 3, 3, 3, 3], // Line 4: Row 4 (Bottom)
  [0, 1, 3, 1, 0], // Line 5: Deep V (Top-Bottom-Top)
  [3, 2, 0, 2, 3], // Line 6: Deep Inverted V (Bottom-Top-Bottom)
  [1, 2, 3, 2, 1], // Line 7: Shallow V (Rows 2-4)
  [2, 1, 0, 1, 2], // Line 8: Shallow Inverted V (Rows 1-3)
  [0, 3, 0, 3, 0], // Line 9: W-Shape (Top/Bottom)
  [3, 0, 3, 0, 3], // Line 10: M-Shape (Bottom/Top)
  [1, 2, 1, 2, 1], // Line 11: W-Shape (Middle Rows)
  [2, 1, 2, 1, 2], // Line 12: M-Shape (Middle Rows)
  [0, 0, 1, 2, 3], // Line 13: Step Down (Top to Bottom)
  [3, 3, 2, 1, 0], // Line 14: Step Up (Bottom to Top)
  [0, 1, 1, 2, 3], // Line 15: Step Down, Delayed
  [3, 2, 2, 1, 0], // Line 16: Step Up, Delayed
  [0, 1, 0, 1, 0], // Line 17: Zigzag (Top Rows)
  [3, 2, 3, 2, 3], // Line 18: Zigzag (Bottom Rows)
  [0, 1, 2, 3, 3], // Line 19: Descending Run
  [3, 2, 1, 0, 0], // Line 20: Ascending Run
];

// Paytable. No wild - only a scatter (`star`, pays anywhere, triggers free spins) plus 10
// regular line-pay symbols split into premiums (the bar ladder, clover, bell) and normals
// (fruits). Frequencies are ordered so premiums are rarer than normals, then re-tuned via
// TUNE FREQUENCIES to hit target RTP, same workflow as fruitmachine/bookbookbook.
// payout[i] is the payout for (i+1) matching symbols, left-to-right from reel 1 (index 0/1
// unused here - nothing pays on 1 or 2 of a kind in this paytable).
export const PAYTABLE = {
  bar_triple: { payout: [0, 0, 100, 500, 2000], type: 'premium', friendlyName: 'Triple Bar' },
  bar_double: { payout: [0, 0,  50, 200,  750], type: 'premium', friendlyName: 'Double Bar' },
  bar:        { payout: [0, 0,  30, 100,  400], type: 'premium', friendlyName: 'Single Bar' },
  bell:       { payout: [0, 0,  20,  60,  200], type: 'premium', friendlyName: 'Golden Bell' },
  clover:     { payout: [0, 0,  15,  50,  150], type: 'premium', friendlyName: 'Lucky Clover' },
  strawberry: { payout: [0, 0,  10,  30,  100], type: 'regular', friendlyName: 'Strawberry' },
  plum:       { payout: [0, 0,   8,  25,   80], type: 'regular', friendlyName: 'Plum' },
  grapes:     { payout: [0, 0,   6,  20,   60], type: 'regular', friendlyName: 'Grapes' },
  orange:     { payout: [0, 0,   5,  15,   50], type: 'regular', friendlyName: 'Orange' },
  melon:      { payout: [0, 0,   4,  12,   40], type: 'regular', friendlyName: 'Watermelon' },
  star:       { payout: [0, 0,   2,  10,   50], type: 'scatter', paymode: 'any', wild: false, triggerFreeSpins: true, friendlyName: 'Star' },
};

// Frequency tables for each reel. All five reels start out identical (same pattern as
// bookbookbook - a pure baseline, differentiate per reel via TUNE FREQUENCIES) - each is
// still its own separate object, not a shared reference, so hand-editing one later (e.g.
// pasting a tuned result back for a single reel) can't silently affect the others. `star`
// carries an explicit `minGap: 4` (equal to ROWS_COUNT) rather than relying on
// generateReel's automatic triggerFreeSpins-based fallback (which defaults to 3) - with 4
// visible rows, a gap of only 3 could still place two stars inside the same visible window
// on one reel; `maxStack: 1` additionally guarantees it never repeats back-to-back on the
// strip.
export const FREQUENCY_REEL1 = {
  defaults: {},
  symbols: {
    bar_triple: { frequency: 0.4 },
    bar_double: { frequency: 0.7 },
    bar:        { frequency: 1.3 },
    bell:       { frequency: 1.8 },
    clover:     { frequency: 2.5 },
    strawberry: { frequency: 5 },
    plum:       { frequency: 6 },
    grapes:     { frequency: 7 },
    orange:     { frequency: 8 },
    melon:      { frequency: 9 },
    star:       { frequency: 0.6, minGap: 4, maxStack: 1 },
  },
};

export const FREQUENCY_REEL2 = {
  defaults: {},
  symbols: {
    bar_triple: { frequency: 0.4 },
    bar_double: { frequency: 0.7 },
    bar:        { frequency: 1.3 },
    bell:       { frequency: 1.8 },
    clover:     { frequency: 2.5 },
    strawberry: { frequency: 5 },
    plum:       { frequency: 6 },
    grapes:     { frequency: 7 },
    orange:     { frequency: 8 },
    melon:      { frequency: 9 },
    star:       { frequency: 0.6, minGap: 4, maxStack: 1 },
  },
};

export const FREQUENCY_REEL3 = {
  defaults: {},
  symbols: {
    bar_triple: { frequency: 0.4 },
    bar_double: { frequency: 0.7 },
    bar:        { frequency: 1.3 },
    bell:       { frequency: 1.8 },
    clover:     { frequency: 2.5 },
    strawberry: { frequency: 5 },
    plum:       { frequency: 6 },
    grapes:     { frequency: 7 },
    orange:     { frequency: 8 },
    melon:      { frequency: 9 },
    star:       { frequency: 0.6, minGap: 4, maxStack: 1 },
  },
};

export const FREQUENCY_REEL4 = {
  defaults: {},
  symbols: {
    bar_triple: { frequency: 0.4 },
    bar_double: { frequency: 0.7 },
    bar:        { frequency: 1.3 },
    bell:       { frequency: 1.8 },
    clover:     { frequency: 2.5 },
    strawberry: { frequency: 5 },
    plum:       { frequency: 6 },
    grapes:     { frequency: 7 },
    orange:     { frequency: 8 },
    melon:      { frequency: 9 },
    star:       { frequency: 0.6, minGap: 4, maxStack: 1 },
  },
};

export const FREQUENCY_REEL5 = {
  defaults: {},
  symbols: {
    bar_triple: { frequency: 0.4 },
    bar_double: { frequency: 0.7 },
    bar:        { frequency: 1.3 },
    bell:       { frequency: 1.8 },
    clover:     { frequency: 2.5 },
    strawberry: { frequency: 5 },
    plum:       { frequency: 6 },
    grapes:     { frequency: 7 },
    orange:     { frequency: 8 },
    melon:      { frequency: 9 },
    star:       { frequency: 0.6, minGap: 4, maxStack: 1 },
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
export const REEL_STRIPS = FREQUENCY_REELS.map((freqTable, i) => generateReel(freqTable, REEL_LENGTH, REEL_SEEDS[i], [], 4, PAYTABLE));

// UI Dom Selectors - initialized in load handler
let canvas, btnSpin, btnAuto, btnTurbo, btnMute, btnPaytable, btnPaytableOk;
let displayBalance, betValue, betMinus, betPlus, gameTicker;
let displayTotalBet, linesValue, linesMinus, linesPlus;
let btnSim, simModal, btnCloseSim, btnTune, simStats;
let simRtpDisplay, simTotalSpinsDisplay, simMaxWinDisplay, simFreeSpinsDisplay;
let modalPaytable, modalFsTrigger, modalFsSummary, btnStartFs, btnCloseFsSummary, fsAwardAmount;
let fsPanel, fsCounter, fsTotalWin;
let cheatScatter, cheatBigWin;

// Debug mode - only enable cheat buttons in development
const DEBUG_MODE = true; // Set to false in production

let engine = null;
let pendingFreeSpinsAward = 0;
const THEME_NAME = 'fruitmachine_1'; // Same shared asset pack as games/fruitmachine

// Async Theme Config Loader
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
      openTuneFrequenciesPanel({
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
        },
        domRefs: { simModal, simStats },
      });
    });
  }
  if (btnCloseSim) {
    btnCloseSim.addEventListener('click', () => {
      simModal.style.display = 'none';
    });
  }

  const themeAssets = await loadThemeAssets(THEME_NAME);
  if (!themeAssets) {
    alert('Error loading assets!');
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
    scatterSymbol: 'star',
    symbolsConfig: themeAssets.symbolsConfig,
    spritesheetUrl: themeAssets.spritesheetUrl,
    betPerLine: BET_PER_LINE,
    linesCount: LINES_COUNT,

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

function handleStateChange(state) {
  updateUI();

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
      gameTicker.textContent = `WIN: $${winVal.toFixed(2)}!`;
    } else if (state === 'free_spins_intro') {
      gameTicker.textContent = 'SCATTER TRIGGER!';
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
    engine.requestSpin();
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
  document.querySelector('#modal-paytable .btn-modal-close').addEventListener('click', closePaytable);

  if (btnStartFs) btnStartFs.addEventListener('click', startFreeSpins);
  if (btnCloseFsSummary) btnCloseFsSummary.addEventListener('click', closeFreeSpinsSummary);

  if (DEBUG_MODE) {
    if (cheatScatter) cheatScatter.addEventListener('click', () => engine.forceWinResult('scatter'));
    if (cheatBigWin) cheatBigWin.addEventListener('click', () => engine.forceWinResult('bigwin'));
  }
}

// Renders the modal paytable descriptions and payline previews dynamically
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
    for (let hits = 5; hits >= 3; hits--) {
      if (meta.payout[hits - 1] > 0) {
        if (symbol === 'star') {
          content += `<strong>${hits}x Scatters:</strong> ${meta.payout[hits - 1]}x Total Bet<br>`;
        } else {
          content += `<strong>${hits} of a kind:</strong> ${meta.payout[hits - 1]}x<br>`;
        }
      }
    }

    if (symbol === 'star') {
      content += `<em style="color:#ffd23f; font-size:10px;">Pays anywhere. 3+ triggers Free Spins (3=10, 4=15, 5=20)</em>`;
    }

    payLines.innerHTML = content;
    item.appendChild(payLines);
    container.appendChild(item);
  }

  const linesPreview = document.getElementById('paylines-preview');
  linesPreview.innerHTML = '';
  PAYLINES.forEach((path, idx) => {
    const div = document.createElement('div');
    div.style.cssText = `
      width: 36px;
      height: 36px;
      border: 1px solid rgba(255,210,63,0.4);
      background: #100303;
      border-radius: 4px;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      padding: 3px;
      position: relative;
      cursor: pointer;
    `;
    div.title = `Line ${idx + 1}`;

    let innerHtml = '<div style="display:flex; justify-content:space-between; height:100%;">';
    for (let c = 0; c < REELS_COUNT; c++) {
      innerHtml += '<div style="display:flex; flex-direction:column; justify-content:space-between; height:100%; width: 4px;">';
      for (let r = 0; r < ROWS_COUNT; r++) {
        const active = (path[c] === r);
        innerHtml += `<div style="width:4px; height:4px; border-radius:50%; background: ${active ? '#ffd23f' : '#3a1010'};"></div>`;
      }
      innerHtml += '</div>';
    }
    innerHtml += '</div>';
    innerHtml += `<span style="position:absolute; bottom:1px; right:3px; font-size:7px; font-weight:bold; color:#b57d6c;">L${idx + 1}</span>`;

    div.innerHTML = innerHtml;
    linesPreview.appendChild(div);
  });
}

// Guarded so this module can be imported under Node (e.g. by tests) without a DOM.
if (typeof window !== 'undefined') {
  window.addEventListener('load', initGame);
}
