// Game Coordinator for Book of Book Book Slot Machine
import { SlotEngine } from '../../core/SlotEngine.js';
import { PAYLINES, generateReel } from '../../core/SlotMath.js';
import { tuneFrequencies } from '../../core/SpinSimulator.js';

// 1. Paytable Config (Classic Book of Dead/Ra multipliers)
// Frequencies tuned (with SlotMath's now-fixed payout math and generateReel's scatter
// min-gap enforcement) to land near 96% RTP while keeping the book/scatter trigger rate
// around 0.5% of spins (~1 in 200), with 4+ books rare and 5+ books effectively astronomical.
const PAYTABLE = {
  book:     { payout: [0,  0,   2,   20,  200], frequency: 0.045, type: 'scatter', paymode: 'any',  wild: false, triggerFreeSpins: true,  friendlyName: 'Book of Books' },
  explorer: { payout: [0, 10, 100, 1000, 5000], frequency: 0.079, type: 'premium', paymode: 'line', wild: false, triggerFreeSpins: false, friendlyName: 'The Explorer' },
  tut:      { payout: [0,  5,  40,  400, 2000], frequency: 0.157, type: 'premium', paymode: 'line', wild: false, triggerFreeSpins: false, friendlyName: 'Tutankhamun' },
  anubis:   { payout: [0,  5,  30,  100,  750], frequency: 0.235, type: 'premium', paymode: 'line', wild: false, triggerFreeSpins: false, friendlyName: 'Anubis Guard' },
  scarab:   { payout: [0,  5,  30,  100,  750], frequency: 0.235, type: 'premium', paymode: 'line', wild: false, triggerFreeSpins: false, friendlyName: 'Scarab Beetle' },
  ace:      { payout: [0,  0,   5,   40,  150], frequency: 0.201, type: 'regular', paymode: 'line', wild: false, triggerFreeSpins: false, friendlyName: 'Golden Ace' },
  king:     { payout: [0,  0,   5,   40,  150], frequency: 0.201, type: 'regular', paymode: 'line', wild: false, triggerFreeSpins: false, friendlyName: 'Pharaoh King' },
  queen:    { payout: [0,  0,   5,   30,  100], frequency: 0.201, type: 'regular', paymode: 'line', wild: false, triggerFreeSpins: false, friendlyName: 'Royal Queen' },
  jack:     { payout: [0,  0,   5,   30,  100], frequency: 0.201, type: 'regular', paymode: 'line', wild: false, triggerFreeSpins: false, friendlyName: 'Desert Jack' },
  ten:      { payout: [0,  0,   5,   30,  100], frequency: 0.201, type: 'regular', paymode: 'line', wild: false, triggerFreeSpins: false, friendlyName: 'Lucky Ten' },
};

// Symbols eligible to be picked as the free spins expanding symbol - anything that
// isn't a scatter (scatter symbols trigger free spins, they can't also expand during them).
const EXPANDING_CANDIDATES = Object.keys(PAYTABLE).filter(s => PAYTABLE[s].type !== 'scatter');

// 2. Reel Strips Generation (Randomized for each reel)
const REEL_STRIPS = [
  generateReel(PAYTABLE, 220, 1234),
  generateReel(PAYTABLE, 220, 567),
  generateReel(PAYTABLE, 220, 89),
  generateReel(PAYTABLE, 220, 765),
  generateReel(PAYTABLE, 220, 3321)
];

// 3. UI Dom Selectors - will be initialized in load handler
let canvas, btnSpin, btnAuto, btnTurbo, btnMute, btnPaytable, btnPaytableOk;
let themeSelect, displayBalance, betValue, betMinus, betPlus, gameTicker;
let btnSim, simModal, btnCloseSim, btnTune;
let simRtpDisplay, simTotalSpinsDisplay, simMaxWinDisplay, simFreeSpinsDisplay;
let modalPaytable, modalFsTrigger, modalFsSummary, btnStartFs, btnCloseFsSummary;
let fsPanel, fsCounter, fsSymbolName, fsSymbolThumbnail;
let bookRevealCanvas, bookRevealCtx, chosenSymbolReveal, fsTotalWin;
let cheatScatter, cheatExpand, cheatBigWin;

// Debug mode - only enable cheat buttons in development
const DEBUG_MODE = true; // Set to false in production

function runSimulation() {
  if (!engine) return;
  
  // Show loading state (optional, but good for UX as 10k spins take a moment)
  btnSim.textContent = 'RUNNING...';
  btnSim.disabled = true;

  // Use setTimeout to allow the UI thread to update before the heavy calculation
  setTimeout(() => {
    try {
      const results = engine.runSimulation(1000000);
      
      simRtpDisplay.textContent = results.rtp;
      simTotalSpinsDisplay.textContent = results.totalSpins;
      simMaxWinDisplay.textContent = `$${results.maxWin}`;
      const pct = results.totalSpins > 0 ? (results.freeSpinsTriggered / results.totalSpins) * 100 : 0;
      simFreeSpinsDisplay.textContent = `${results.freeSpinsTriggered} (${pct.toFixed(2)}%)`;

      // --- Detailed Stats Processing ---
      const symbolStats = {}; // { 'explorer': { counts: { 3: { count: 50, totalAmount: 1250 } }, expanding: { counts: {} } } } }
      
      results.detailedWins.forEach(win => {
        if (!symbolStats[win.symbol]) {
          symbolStats[win.symbol] = { counts: {}, expanding: { counts: {} } };
        }
        
        if (win.type === 'expanding') {
          if (!symbolStats[win.symbol].expanding.counts[win.count]) {
            symbolStats[win.symbol].expanding.counts[win.count] = { count: 0, totalAmount: 0 };
          }
          symbolStats[win.symbol].expanding.counts[win.count].count += 1;
          symbolStats[win.symbol].expanding.counts[win.count].totalAmount += win.winAmount;
        } else {
          if (!symbolStats[win.symbol].counts[win.count]) {
            symbolStats[win.symbol].counts[win.count] = { count: 0, totalAmount: 0 };
          }
          symbolStats[win.symbol].counts[win.count].count += 1;
          symbolStats[win.symbol].counts[win.count].totalAmount += win.winAmount;
        }
      });

      console.log('Symbols captured in simulation wins:', Object.keys(symbolStats));

      // --- UI Generation for Detailed Stats ---
      let detailsContainer = document.getElementById('sim-details');
      if (!detailsContainer) {
        detailsContainer = document.createElement('div');
        detailsContainer.id = 'sim-details';
        detailsContainer.style.marginTop = '20px';
        detailsContainer.style.padding = '15px';
        detailsContainer.style.background = 'rgba(255, 255, 255, 0.1)';
        detailsContainer.style.borderRadius = '12px';
        detailsContainer.style.fontSize = '0.9em';
        simModal.appendChild(detailsContainer);
      } else {
        detailsContainer.innerHTML = '';
      }

      // Always list every paytable symbol, even ones with zero recorded wins in this run,
      // so the breakdown reflects the full paytable rather than only what happened to hit.
      // Book leads the Premium section even though its paytable type is 'scatter', since
      // it's the game's headline symbol.
      const premiumSymbols = ['book', ...Object.keys(PAYTABLE).filter(s => PAYTABLE[s].type === 'premium')];
      const nonPremiumSymbols = Object.keys(PAYTABLE).filter(s => !premiumSymbols.includes(s));

      let detailsHtml = '<h3 style="margin-top: 0; border-bottom: 1px solid rgba(255,255,255,0.2); padding-bottom: 8px;">Detailed Win Breakdown</h3>';

      // Renders a counts map ({ hitCount: { count, totalAmount } }) as a compact table:
      // Hits | Wins | Avg Win | Total Win.
      const fmt = (n) => n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });
      const renderWinTable = (counts, hitLabel, accentColor, emptyText) => {
        const sortedKeys = Object.keys(counts).sort((a, b) => a - b);
        if (sortedKeys.length === 0) {
          return `<div style="color: #666; font-style: italic; font-size: 0.8em;">${emptyText}</div>`;
        }
        let html = `<table style="width: 100%; border-collapse: collapse; font-size: 0.95em;">`;
        html += `<thead><tr style="color: #888; font-size: 0.8em; text-transform: uppercase;">
                    <th style="text-align: left; font-weight: normal; padding: 2px 4px 4px 0;">${hitLabel}</th>
                    <th style="text-align: right; font-weight: normal; padding: 2px 4px 4px;">Wins</th>
                    <th style="text-align: right; font-weight: normal; padding: 2px 4px 4px;">Avg Win</th>
                    <th style="text-align: right; font-weight: normal; padding: 2px 0 4px;">Total Win</th>
                  </tr></thead><tbody>`;
        sortedKeys.forEach(key => {
          const data = counts[key];
          const avg = data.totalAmount / data.count;
          html += `<tr>
                      <td style="padding: 2px 4px 2px 0; color: ${accentColor};">${key}</td>
                      <td style="text-align: right; padding: 2px 4px;">${data.count}</td>
                      <td style="text-align: right; padding: 2px 4px;">$${fmt(avg)}</td>
                      <td style="text-align: right; padding: 2px 0; font-weight: bold;">$${fmt(data.totalAmount)}</td>
                    </tr>`;
        });
        html += `</tbody></table>`;
        return html;
      };

      const createSection = (title, symbols) => {
        if (symbols.length === 0) return `<div style="color: #666; font-style: italic; font-size: 0.8em;">No wins found for ${title}</div>`;
        let sectionHtml = `<h4 style="margin: 15px 0 10px 0; color: #aaa; text-transform: uppercase; font-size: 0.75em; letter-spacing: 1px;">${title}</h4>`;
        sectionHtml += `<div style="display: grid; grid-template-columns: repeat(5, 1fr); gap: 12px;">`;

        symbols.forEach(symbol => {
          const stats = symbolStats[symbol] || { counts: {}, expanding: { counts: {} } };
          const friendlyName = PAYTABLE[symbol]?.friendlyName || symbol;
          const isScatter = PAYTABLE[symbol]?.type === 'scatter';

          sectionHtml += `<div style="border: 1px solid rgba(255,255,255,0.2); padding: 12px; border-radius: 8px; background: rgba(255,255,255,0.05); font-size: 0.85em;">`;
          sectionHtml += `<strong style="display: block; margin-bottom: 8px; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 4px;">${friendlyName}</strong>`;

          // Normal (line) or Scatter Wins Sub-section
          sectionHtml += `<div style="margin-bottom: 8px;">`;
          sectionHtml += `<span style="font-size: 0.7em; color: #999; text-transform: uppercase;">${isScatter ? 'Scatter Wins' : 'Normal Wins'}</span>`;
          sectionHtml += renderWinTable(stats.counts, 'Hits', '#ccc', isScatter ? 'No scatter wins' : 'No standard line wins');
          sectionHtml += `</div>`;

          // Expanding Wins Sub-section
          if (stats.expanding && Object.keys(stats.expanding.counts).length > 0) {
            sectionHtml += `<div style="margin-top: 8px; padding-top: 4px; border-top: 1px dashed rgba(255,255,255,0.1);">`;
            sectionHtml += `<span style="font-size: 0.7em; color: #ffd700; text-transform: uppercase;">Expanding Wins</span>`;
            sectionHtml += renderWinTable(stats.expanding.counts, 'Reels', '#ffd700', '');
            sectionHtml += `</div>`;
          }

          sectionHtml += `</div>`;
        });

        sectionHtml += `</div>`;
        return sectionHtml;
      };

      // Stacked full-width sections (rather than squeezing two 3-column grids side by
      // side into half the modal) so each symbol card gets enough room to lay out its
      // win breakdown without wrapping awkwardly at typical modal widths.
      detailsHtml += createSection('Premium Symbols', premiumSymbols);
      detailsHtml += createSection('Standard Symbols', nonPremiumSymbols);

      detailsContainer.innerHTML = detailsHtml;

      simModal.style.display = 'block';
      simModal.style.maxWidth = '1200px';
      simModal.style.width = '95%';
    } catch (error) {
      console.error('Simulation failed:', error);
      alert('Error running simulation');
    } finally {
      btnSim.textContent = 'RUN SIMULATION';
      btnSim.disabled = false;
    }
  }, 50);
}

// Runs the frequency auto-balancer (core/SpinSimulator.js: tuneFrequencies) against the
// live PAYTABLE and shows the suggested frequencies side by side with the current ones.
// This only reports a suggestion - it does not mutate PAYTABLE or the live reels, since
// applying it means regenerating REEL_STRIPS and is a deliberate code change, not a runtime toggle.
function runFrequencyTuner() {
  if (!btnTune) return;

  btnTune.textContent = 'TUNING...';
  btnTune.disabled = true;

  setTimeout(() => {
    try {
      const { paytable: tunedPaytable, rtp, triggerRatePct, diagnostics } = tuneFrequencies(PAYTABLE, {
        targetRtp: 96,
        targetTriggerRatePct: 0.6,
        trialSpins: 300000,
        trialsPerPoint: 2,
        maxIterations: 10,
        // tuneFrequencies runs fully synchronously, so the browser can't repaint between
        // iterations - this only shows up in the console, not the (frozen) button label.
        onProgress: (phase, i, mult, r) => {
          console.log(`  [tuner ${phase} ${i}] mult=${mult.toFixed(4)} -> RTP=${r.rtp.toFixed(2)}% trigger=${r.triggerRate.toFixed(3)}%`);
        }
      });

      let tuneContainer = document.getElementById('tune-details');
      if (!tuneContainer) {
        tuneContainer = document.createElement('div');
        tuneContainer.id = 'tune-details';
        tuneContainer.style.marginTop = '20px';
        tuneContainer.style.padding = '15px';
        tuneContainer.style.background = 'rgba(255, 255, 255, 0.1)';
        tuneContainer.style.borderRadius = '12px';
        tuneContainer.style.fontSize = '0.9em';
        simModal.appendChild(tuneContainer);
      } else {
        tuneContainer.innerHTML = '';
      }

      let html = `<h3 style="margin-top: 0; border-bottom: 1px solid rgba(255,255,255,0.2); padding-bottom: 8px;">Frequency Tuner Suggestion</h3>`;
      html += `<p style="font-size: 0.85em; color: #ccc; margin: 8px 0;">Achieved RTP: <strong>${rtp.toFixed(2)}%</strong> &nbsp;|&nbsp; Free spin trigger rate: <strong>${triggerRatePct.toFixed(3)}%</strong> (1 in ${(100 / triggerRatePct).toFixed(0)})</p>`;
      html += `<table style="width: 100%; border-collapse: collapse; font-size: 0.9em; margin-top: 10px;">`;
      html += `<thead><tr style="color: #888; font-size: 0.8em; text-transform: uppercase; border-bottom: 1px solid rgba(255,255,255,0.15);">
                  <th style="text-align: left; padding: 4px;">Symbol</th>
                  <th style="text-align: left; padding: 4px;">Type</th>
                  <th style="text-align: right; padding: 4px;">Current Freq</th>
                  <th style="text-align: right; padding: 4px;">Suggested Freq</th>
                  <th style="text-align: right; padding: 4px;">Δ</th>
                </tr></thead><tbody>`;
      Object.keys(PAYTABLE).forEach(symbol => {
        const current = PAYTABLE[symbol].frequency;
        const suggested = tunedPaytable[symbol].frequency;
        const delta = suggested - current;
        const deltaColor = Math.abs(delta) < 0.001 ? '#888' : (delta > 0 ? '#7fd97f' : '#e67f7f');
        html += `<tr style="border-bottom: 1px solid rgba(255,255,255,0.05);">
                    <td style="padding: 4px;">${PAYTABLE[symbol].friendlyName || symbol}</td>
                    <td style="padding: 4px; color: #999;">${PAYTABLE[symbol].type}</td>
                    <td style="text-align: right; padding: 4px;">${current.toFixed(4)}</td>
                    <td style="text-align: right; padding: 4px; font-weight: bold;">${suggested.toFixed(4)}</td>
                    <td style="text-align: right; padding: 4px; color: ${deltaColor};">${delta >= 0 ? '+' : ''}${delta.toFixed(4)}</td>
                  </tr>`;
      });
      html += `</tbody></table>`;
      html += `<p style="font-size: 0.75em; color: #888; margin-top: 10px;">This is a suggestion only - apply it by editing PAYTABLE's frequency values in game.js and reloading, so REEL_STRIPS regenerates from the new weights.</p>`;

      tuneContainer.innerHTML = html;

      simModal.style.display = 'block';
      simModal.style.maxWidth = '900px';
      simModal.style.width = '95%';

      console.log('Frequency tuner diagnostics:', diagnostics);
    } catch (error) {
      console.error('Frequency tuning failed:', error);
      alert('Error running frequency tuner');
    } finally {
      btnTune.textContent = 'TUNE FREQUENCIES';
      btnTune.disabled = false;
    }
  }, 50);
}


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
  gameTicker = document.getElementById('game-ticker');

  btnSim = document.getElementById('btn-sim');
  btnTune = document.getElementById('btn-tune');
  simModal = document.getElementById('sim-modal');
  btnCloseSim = document.getElementById('btn-close-sim');

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
    btnSim.addEventListener('click', runSimulation);
  }
  if (btnTune) {
    btnTune.addEventListener('click', runFrequencyTuner);
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
  displayBalance.textContent = `$${engine.balance.toFixed(0)}`;
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
  engine.returnToIdle();
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
    if (engine.betPerLine > 1) {
      engine.betPerLine--;
      engine.updateBet();
      updateUI();
    }
  });

  betPlus.addEventListener('click', () => {
    if (engine.state !== 'idle' && engine.state !== 'showing_wins') return;
    const newBetPerLine = engine.betPerLine + 1;
    const newTotalBet = newBetPerLine * engine.linesCount;
    if (newBetPerLine <= 100 && engine.balance >= newTotalBet) {
      engine.betPerLine = newBetPerLine;
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
