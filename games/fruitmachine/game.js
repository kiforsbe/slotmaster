// Game Coordinator for Lucky Fruits Slot Machine
import { SlotEngine } from '../../core/SlotEngine.js';
import { generateReel, checkWildLineWins } from '../../core/SlotMath.js';
import { runSimulationAndRender, openTuneFrequenciesPanel } from '../../core/SimulationPanel.js';

// Grid/reel parameters shared by the live game, the RUN SIMULATION button, and the
// frequency tuner - a single source of truth so all three actually model the same reels
// instead of the simulation/tuner silently drifting onto their own hardcoded defaults.
export const REELS_COUNT = 3;
export const ROWS_COUNT = 3;
export const REEL_LENGTH = 500;
export const REEL_SEEDS = [123, 456, 789];
// Paytable payouts (e.g. bar's 10x) were designed against a $1 total bet spread across
// all 5 lines - i.e. 20 cents per line, not $1 per line - so the default/minimum
// per-line bet is set to match that unit.
export const BET_PER_LINE = 0.20;
export const BET_PER_LINE_STEP = 0.20;
export const BET_PER_LINE_MAX = 20;
export const LINES_COUNT = 5;

// Payline definitions - 3 reels x 3 rows: the three horizontal rows, plus the two true
// diagonals (not V-shapes - see docs/superpowers/specs design doc).
export const PAYLINES = [
  [1, 1, 1], // Line 1: Middle Row
  [2, 2, 2], // Line 2: Bottom Row
  [0, 0, 0], // Line 3: Top Row
  [2, 1, 0], // Line 4: Diagonal, bottom-left to upper-right
  [0, 1, 2], // Line 5: Diagonal, upper-left to bottom-right
];

// Paytable. Frequencies are ordered so that higher-paying symbols are rarer (standard
// slot design), then must be re-tuned via TUNE FREQUENCIES to hit target RTP - with only
// 5 lines on 3 reels and a payout ceiling of 10x, that pass will likely need to raise
// several of these weights across the board to reach 96%.
// `bar` is the sole `type: 'premium'` symbol - marking it that way is what lets TUNE
// FREQUENCIES' premium/other reallocation actually move the needle for this paytable
// (its scatter-tuning phase is a no-op here since there's no scatter symbol).
// Payout values are multipliers of betPerLine. They're calibrated against the game's
// actual 20-cent per-line bet (BET_PER_LINE above) - e.g. cherries' 2.00 single-symbol
// multiplier gives a real $0.40 win at the default bet, matching the original cents-based
// design (40c/80c/$1.60 for 1/2/3 cherries, $10 for 3 bars, etc. at a 20-cent line bet).
export const PAYTABLE = {
  bar:        { payout: [0.00, 0.00, 50.00], type: 'premium', friendlyName: 'Bar' },
  clover:     { payout: [0.00, 0.00, 20.00], type: 'regular', friendlyName: 'Clover',     wildPenalty: 1 },
  pear:       { payout: [0.00, 0.00, 15.00], type: 'regular', friendlyName: 'Pear',       wildPenalty: 1 },
  melon:      { payout: [0.00, 0.00, 15.00], type: 'regular', friendlyName: 'Watermelon', wildPenalty: 1 },
  grapes:     { payout: [0.00, 0.00, 10.00], type: 'regular', friendlyName: 'Grapes',     wildPenalty: 1 },
  plum:       { payout: [0.00, 0.00, 10.00], type: 'regular', friendlyName: 'Plum' },
  orange:     { payout: [0.00, 0.00,  8.00], type: 'regular', friendlyName: 'Orange' },
  cherries:   { payout: [2.00, 4.00,  8.00], type: 'regular', friendlyName: 'Cherries' },
  star:       { payout: [0.00, 0.00,  0.00], type: 'wild',    friendlyName: 'Star',       wild: true, wildExcludes: ['cherries', 'bar'] },
  strawberry: { payout: [0.00, 0.00,  0.00], type: 'wild',    friendlyName: 'Strawberry', aloneBonus: 4.00 },
};

// Frequency tables for each reel. These are based on the actual symbol weights used in the
// original machines. `fixed: true` marks a symbol as excluded from TUNE FREQUENCIES' Phase 2
// search on that specific reel (its frequency there is never touched) - star and strawberry
// are wild symbols and are always meant to stay fixed, independent of payout ordering.
// `defaults` holds this reel's fallback minGap/maxStack (empty here - fruitmachine has no
// symbol that needs spacing/stacking constraints); a symbol can override either under its
// own entry in `symbols`. Note that REEL_1 does not contain the star or strawberry symbols.
export const FREQUENCY_REEL1 = {
  defaults: {},
  symbols: {
    bar:        { frequency: 24.5 },
    clover:     { frequency: 20.1 },
    pear:       { frequency: 13.2 },
    melon:      { frequency: 17.6 },
    grapes:     { frequency: 3.5 },
    plum:       { frequency: 10.1 },
    orange:     { frequency: 3.5 },
    cherries:   { frequency: 3.5 },
    star:       { frequency: 0.0, fixed: true },
    strawberry: { frequency: 0.0, fixed: true },
  },
};

export const FREQUENCY_REEL2 = {
  defaults: {},
  symbols: {
    bar:        { frequency: 8.9 },
    clover:     { frequency: 10.5 },
    pear:       { frequency: 10.5 },
    melon:      { frequency: 11.7 },
    grapes:     { frequency: 12.3 },
    plum:       { frequency: 13.0 },
    orange:     { frequency: 13.6 },
    cherries:   { frequency: 15.5 },
    star:       { frequency: 0.0, fixed: true },
    strawberry: { frequency: 0.0, fixed: true },
  },
};

export const FREQUENCY_REEL3 = {
  defaults: {},
  symbols: {
    bar:        { frequency: 22.8 },
    clover:     { frequency: 14.3 },
    pear:       { frequency: 6.2 },
    melon:      { frequency: 18.0 },
    grapes:     { frequency: 3.3 },
    plum:       { frequency: 9.7 },
    orange:     { frequency: 3.8 },
    cherries:   { frequency: 3.3 },
    star:       { frequency: 28.3, min: 20, max: 30 },
    strawberry: { frequency: 6.3, min: 2, max: 6 },
  },
};

// Generate the reel strips based on the frequency tables and seeds.
// The generateReel function will create a random distribution of symbols for each reel based on the specified frequencies and seed values.
export const REEL_STRIPS = [
  generateReel(FREQUENCY_REEL1, REEL_LENGTH, REEL_SEEDS[0]),
  generateReel(FREQUENCY_REEL2, REEL_LENGTH, REEL_SEEDS[1]),
  generateReel(FREQUENCY_REEL3, REEL_LENGTH, REEL_SEEDS[2]),
];

// UI Dom Selectors - initialized in load handler
let canvas, btnSpin, btnAuto, btnTurbo, btnMute, btnPaytable, btnPaytableOk;
let displayBalance, betValue, betMinus, betPlus, gameTicker;
let displayTotalBet, linesValue, linesMinus, linesPlus;
let btnSim, simModal, btnCloseSim, btnTune, simStats;
let simRtpDisplay, simTotalSpinsDisplay, simMaxWinDisplay, simFreeSpinsDisplay;
let modalPaytable;

let engine = null;
const THEME_NAME = 'fruitmachine_1';

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
        reelFrequencyTables: [FREQUENCY_REEL1, FREQUENCY_REEL2, FREQUENCY_REEL3],
        tuneConfig: {
          reelsCount: REELS_COUNT,
          rowsCount: ROWS_COUNT,
          paylines: PAYLINES,
          winEvaluator: checkWildLineWins,
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
    winEvaluator: checkWildLineWins,
    symbolsConfig: themeAssets.symbolsConfig,
    spritesheetUrl: themeAssets.spritesheetUrl,
    betPerLine: BET_PER_LINE,
    linesCount: LINES_COUNT,

    onStateChange: (state) => handleStateChange(state),
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
    } else {
      gameTicker.textContent = 'IDLE';
    }
  }
}

function handleWin(winInfo) {
  updateUI();
}

function setupUIHandlers() {
  btnSpin.addEventListener('click', () => {
    engine.requestSpin();
  });

  betMinus.addEventListener('click', () => {
    if (engine.state !== 'idle' && engine.state !== 'showing_wins') return;
    if (engine.betPerLine > BET_PER_LINE_STEP + 1e-9) {
      // Round to 2dp - repeated 0.20 steps otherwise drift (e.g. 0.6000000000000001).
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
    if (symbol === 'cherries') {
      content += `<strong>3x:</strong> 1.60x<br><strong>2x:</strong> 0.80x<br><strong>1x:</strong> 0.40x<br>`;
    } else if (meta.payout[meta.payout.length - 1] > 0) {
      content += `<strong>3 of a kind:</strong> ${meta.payout[meta.payout.length - 1]}x<br>`;
    }

    if (meta.wild) {
      const target = meta.wildOnly ? meta.wildOnly.join(', ') : 'most symbols';
      content += `<em style="color:#ffd23f; font-size:10px;">Wild for ${target} (reel 3 only)</em><br>`;
    }
    if (meta.aloneBonus) {
      content += `<em style="color:#ffd23f; font-size:10px;">Pays ${meta.aloneBonus}x on reel 3, regardless of reels 1-2</em>`;
    }
    if (meta.wildPenalty) {
      content += `<em style="color:#d9a891; font-size:10px;">-${meta.wildPenalty} when won via wild</em>`;
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
      height: 30px;
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
      innerHtml += '<div style="display:flex; flex-direction:column; justify-content:space-between; height:100%; width: 5px;">';
      for (let r = 0; r < ROWS_COUNT; r++) {
        const active = (path[c] === r);
        innerHtml += `<div style="width:5px; height:5px; border-radius:50%; background: ${active ? '#ffd23f' : '#3a1010'};"></div>`;
      }
      innerHtml += '</div>';
    }
    innerHtml += '</div>';
    innerHtml += `<span style="position:absolute; bottom:1px; right:3px; font-size:8px; font-weight:bold; color:#b57d6c;">L${idx + 1}</span>`;

    div.innerHTML = innerHtml;
    linesPreview.appendChild(div);
  });
}

// Guarded so this module can be imported under Node (e.g. by tests) without a DOM.
if (typeof window !== 'undefined') {
  window.addEventListener('load', initGame);
}
