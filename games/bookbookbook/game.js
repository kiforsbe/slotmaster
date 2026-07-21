// Game Coordinator for Book of Book Book Slot Machine
import { SlotEngine } from '../../core/SlotEngine.js';
import { PAYLINES } from '../../core/SlotMath.js';

function mulberry32(seed) {
  return function() {
    let t = seed += 0x6D2B79F5;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  }
}

function shuffle(array, rng) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

function generateReel(paytable, targetLength, seed, exclude=[]) {
  // Step 1: compute weights from 5-of-a-kind payout
  const weights = {};
  for (const symbol in paytable) {
    if (exclude.includes(symbol)) continue; // skip excluded symbols
    const payout = paytable[symbol][5];
    weights[symbol] = 1 / (payout + 1);
  }

  // Step 2: normalize counts to target length
  const totalWeight = Object.values(weights).reduce((a,b)=>a+b,0);
  const counts = {};
  for (const symbol in weights) {
    counts[symbol] = Math.max(1, Math.round(weights[symbol] / totalWeight * targetLength));
  }

  // Step 3: build reel
  const reel = [];
  for (const [symbol, count] of Object.entries(counts)) {
    for (let i=0; i<count; i++) reel.push(symbol);
  }

  // Step 4: shuffle with seed
  const rng = mulberry32(seed);
  return shuffle(reel, rng);
}

// 1. Paytable Config (Classic Book of Dead/Ra multipliers)
// Index of array = hit count (0 to 5)
const PAYTABLE = {
  book:    [0, 0, 20, 200, 2000, 10000],  // Book (Scatter pays of Total Bet!)
  tut:     [0, 0, 10, 100, 1000, 5000],  // Tutankhamun
  anubis:  [0, 0, 5, 40, 400, 2000],     // Anubis
  scarab:  [0, 0, 5, 30, 100, 750],      // Scarab Beetle
  cat:     [0, 0, 5, 30, 100, 750],      // Egyptian Bastet Cat
  ankh:    [0, 0, 5, 15, 50, 500],       // Ankh Cross
  ace:     [0, 0, 0, 5, 40, 150],        // Ace
  king:    [0, 0, 0, 5, 40, 150],        // King
  queen:   [0, 0, 0, 5, 30, 100],        // Queen
  jack:    [0, 0, 0, 5, 30, 100],        // Jack
};

// 2. Reel Strips Config (Egyptian themed distribution of symbols)
// Only symbols common to all three tile sets: jack, queen, king, ace, ankh, scarab, cat, tut, anubis, book
const REEL_STRIPS = [
  generateReel(PAYTABLE, 220, 1234),
  generateReel(PAYTABLE, 220, 567),
  generateReel(PAYTABLE, 220, 89),
  generateReel(PAYTABLE, 220, 765),
  generateReel(PAYTABLE, 220, 3321)
];

// Map of user friendly names for reveal screens
const FRIENDLY_NAMES = {
  tut: "Tutankhamun",
  anubis: "Anubis Guard",
  scarab: "Scarab Beetle",
  cat: "Bastet Cat",
  ankh: "Sacred Ankh",
  ace: "Golden Ace",
  king: "Pharaoh King",
  queen: "Royal Queen",
  jack: "Desert Jack",
  book: "Book of Books"
};

// 3. UI Dom Selectors
const canvas = document.getElementById('game-canvas');
const btnSpin = document.getElementById('btn-spin');
const btnAuto = document.getElementById('btn-auto');
const btnTurbo = document.getElementById('btn-turbo');
const btnMute = document.getElementById('btn-mute');
const btnPaytable = document.getElementById('btn-paytable');
const btnPaytableOk = document.getElementById('btn-paytable-ok');
const themeSelect = document.getElementById('theme-select');
const displayBalance = document.getElementById('display-balance');
const betValue = document.getElementById('bet-value');
const betMinus = document.getElementById('bet-minus');
const betPlus = document.getElementById('bet-plus');
const gameTicker = document.getElementById('game-ticker');

// Modals
const modalPaytable = document.getElementById('modal-paytable');
const modalFsTrigger = document.getElementById('modal-fs-trigger');
const modalFsSummary = document.getElementById('modal-fs-summary');
const btnStartFs = document.getElementById('btn-start-fs');
const btnCloseFsSummary = document.getElementById('btn-close-fs-summary');
const revealSymbolTxt = document.getElementById('reveal-symbol-txt');
const chosenSymbolReveal = document.getElementById('chosen-symbol-reveal');
const fsTotalWin = document.getElementById('fs-total-win');

// Free spins overlay
const fsPanel = document.getElementById('fs-panel');
const fsCounter = document.getElementById('fs-counter');
const fsSymbolThumbnail = document.getElementById('fs-symbol-thumbnail');
const fsSymbolName = document.getElementById('fs-symbol-name');

// Debug Cheats
const cheatScatter = document.getElementById('cheat-scatter');
const cheatExpand = document.getElementById('cheat-expand');
const cheatBigWin = document.getElementById('cheat-bigwin');

let engine = null;
let currentTheme = 'style_3';

// 4. Async Theme Config Loader
async function loadThemeAssets(themeName) {
  try {
    const response = await fetch(`assets/${themeName}/${themeName}.tiles.json`);
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

    const spritesheetUrl = `assets/${themeName}/${data.sheet}`;
    
    return { spritesheetUrl, symbolsConfig };
  } catch (error) {
    console.error(`Failed to fetch tile config for theme: ${themeName}`, error);
    // Return empty fallback
    return null;
  }
}

// 5. Initialize game on window load
window.addEventListener('load', async () => {
  const themeAssets = await loadThemeAssets(currentTheme);
  if (!themeAssets) {
    alert("Error loading assets!");
    return;
  }

  // Create slot engine instance
  engine = new SlotEngine(canvas, {
    reelsCount: 5,
    rowsCount: 3,
    paytable: PAYTABLE,
    reelStrips: REEL_STRIPS,
    symbolsConfig: themeAssets.symbolsConfig,
    spritesheetUrl: themeAssets.spritesheetUrl,
    
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
  displayBalance.textContent = `$${engine.balance.toFixed(2)}`;
  betValue.textContent = engine.betPerLine;
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
      gameTicker.textContent = `WIN: $${winVal.toFixed(2)}!`;
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
    fsSymbolName.textContent = FRIENDLY_NAMES[engine.expandingSymbol] || engine.expandingSymbol;
    
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
      engine.state = 'free_spins_intro';
      engine.config.onStateChange(engine.state);
      handleInitialFreeSpinsTrigger();
    }
  }
}

function handleInitialFreeSpinsTrigger() {
  btnSpin.disabled = true;
  modalFsTrigger.classList.add('active');
  
  const bookContainer = document.getElementById('animated-book-container');
  bookContainer.classList.remove('open');
  chosenSymbolReveal.classList.remove('reveal');
  btnStartFs.style.display = 'none';
  revealSymbolTxt.textContent = "READING SACRED TEXTS...";

  // 3D book animation timings
  setTimeout(() => {
    bookContainer.classList.add('open');
    revealSymbolTxt.textContent = "THE CHOSEN ONE IS...";
  }, 1000);

  setTimeout(() => {
    // Select random standard symbol (exclude book) — only symbols common to all three tile sets
    const candidates = ['tut', 'anubis', 'scarab', 'cat', 'ankh', 'ace', 'king', 'queen', 'jack'];
    const chosen = candidates[Math.floor(Math.random() * candidates.length)];
    
    // Update text
    revealSymbolTxt.textContent = chosen.toUpperCase();
    chosenSymbolReveal.textContent = `${FRIENDLY_NAMES[chosen].toUpperCase()} SELECETED`;
    chosenSymbolReveal.classList.add('reveal');
    btnStartFs.style.display = 'inline-block';
    
    // Temporarily save selected symbol on engine trigger
    engine.expandingSymbol = chosen;
    
    // Play sound alert
    engine.audio.playScatterTrigger();
  }, 2500);
}

function startFreeSpins() {
  modalFsTrigger.classList.remove('active');
  btnSpin.disabled = false;
  
  // Hand control to engine with 10 free spins and selected symbol
  engine.enterFreeSpins(10, engine.expandingSymbol);
}

function handleFreeSpinsComplete() {
  fsTotalWin.textContent = `$${engine.freeSpinsAccumulatedWin.toFixed(2)}`;
  modalFsSummary.classList.add('active');
  engine.audio.playScatterTrigger();
}

function handleScatterRetrigger(scatterCount) {
  // Add extra spins based on scatter count: 2->5, 3->10, 4->15, 5->20
  const extraSpins = { 2: 5, 3: 10, 4: 15, 5: 20 };
  const added = extraSpins[scatterCount] || (scatterCount * 5);
  
  engine.freeSpinsTotal += added;
  engine.freeSpinsRemaining += added;
  
  // Update the free spins counter display immediately
  fsCounter.textContent = `FREE SPINS: ${engine.freeSpinsRemaining} / ${engine.freeSpinsTotal}`;
  
  // Show a brief on-screen notification
  gameTicker.textContent = `+${added} EXTRA SPINS!`;
  engine.audio.playScatterTrigger();
  
  // Reset state so the next auto-spin continues the bonus
  engine.state = 'idle';
  handleStateChange('idle');
}

function closeFreeSpinsSummary() {
  modalFsSummary.classList.remove('active');
  engine.state = 'idle';
  handleStateChange('idle');
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
    if (engine.state === 'spinning' || engine.state === 'stopping') {
      engine.stopSpin();
    } else {
      engine.spin();
    }
  });

  // Bet adjustments
  betMinus.addEventListener('click', () => {
    if (engine.state !== 'idle' && engine.state !== 'showing_wins') return;
    if (engine.betPerLine > 1) {
      engine.betPerLine--;
      engine.updateBet();
      updateUI();
    }
  });

  betPlus.addEventListener('click', () => {
    if (engine.state !== 'idle' && engine.state !== 'showing_wins') return;
    if (engine.betPerLine < 100) {
      engine.betPerLine++;
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
  document.querySelector('#modal-paytable .btn-modal-close').addEventListener('click', closePaytable);

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
  btnStartFs.addEventListener('click', startFreeSpins);
  btnCloseFsSummary.addEventListener('click', closeFreeSpinsSummary);

  // Debug Cheat actions
  cheatScatter.addEventListener('click', () => engine.forceWinResult('scatter'));
  cheatExpand.addEventListener('click', () => {
    if (!engine.inFreeSpins) {
      alert("Must be in Free Spins mode to test Expanding symbols! Click Scatter Trigger cheat first.");
      return;
    }
    engine.forceWinResult('expanding');
  });
  cheatBigWin.addEventListener('click', () => engine.forceWinResult('bigwin'));
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
    title.textContent = FRIENDLY_NAMES[symbol] || symbol;
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
