// Core Slot Game Engine Renderer & State Controller
import { checkWins, checkExpandingWins, PAYLINES } from './SlotMath.js';
import { audio } from './SlotAudio.js';

export class SlotEngine {
  constructor(canvas, config = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    
    // Core game configurations
    this.config = {
      reelsCount: 5,
      rowsCount: 3,
      paytable: {},
      reelStrips: [],
      symbolsConfig: {}, // Maps symbol name to {x, y, w, h} in spritesheet
      spritesheetUrl: '',
      onStateChange: () => {},
      onFreeSpinsTriggered: () => {},
      onWin: () => {},
      ...config
    };

    // State Variables
    this.state = 'idle'; // idle, spinning, stopping, evaluating, free_spins_intro, expanding, showing_wins, game_over
    this.balance = 1000;
    this.betPerLine = 1;
    this.linesCount = 10;
    this.totalBet = 10;
    this.lastWin = 0;
    
    // Free Spins State
    this.inFreeSpins = false;
    this.freeSpinsRemaining = 0;
    this.freeSpinsTotal = 0;
    this.freeSpinsAccumulatedWin = 0;
    this.expandingSymbol = null;

    // Sprite Asset
    this.spritesheet = new Image();
    this.assetsLoaded = false;

    // Reel Physics & Positions
    this.reels = [];
    this.symbolWidth = 0;
    this.symbolHeight = 0;
    this.reelsX = 0;
    this.reelsY = 0;
    this.reelsWidth = 0;
    this.reelsHeight = 0;
    
    // Animation timers & configs
    this.spinDuration = 2000; // MS
    this.spinStart = 0;
    this.reelDelay = 150; // MS delay between reel stops
    this.turboMode = false;
    this.autoPlay = false;

    // Win presentation state
    this.winData = null;
    this.expandingWinData = null;
    this.activeWinLineIndex = -1;
    this.winCycleTimer = 0;
    this.winCycleDuration = 1000; // ms per win line display
    this.winCycleIndex = -1; // -1 means show all wins, 0..N means show specific line win
    
    // Visual Effects
    this.particles = [];
    this.expandedReelsState = []; // Track which reels are currently expanded [false, false, ...]
    this.expansionProgress = 0; // 0..1 for expanding animation
    this.expansionReelsToAnimate = []; // indices of reels to expand

    // Sound engine alias
    this.audio = audio;

    this.init();
  }

  init() {
    this.updateBet();
    this.setupResize();
    this.loadAssets();
    this.setupReels();
    this.animate();
  }

  updateBet() {
    this.totalBet = this.betPerLine * this.linesCount;
  }

  loadAssets(spritesheetUrl = this.config.spritesheetUrl, symbolsConfig = this.config.symbolsConfig) {
    this.assetsLoaded = false;
    this.config.spritesheetUrl = spritesheetUrl;
    this.config.symbolsConfig = symbolsConfig;

    this.spritesheet.src = spritesheetUrl;
    this.spritesheet.onload = () => {
      this.assetsLoaded = true;
      this.resize();
    };
    this.spritesheet.onerror = () => {
      console.error("Failed to load spritesheet from: " + spritesheetUrl);
    };
  }

  setupReels() {
    this.reels = [];
    for (let r = 0; r < this.config.reelsCount; r++) {
      const strip = this.config.reelStrips[r] || ['jack', 'queen', 'king', 'ace'];
      
      // Initialize each reel with random symbols
      const symbols = [];
      for (let i = 0; i < this.config.rowsCount + 3; i++) {
        symbols.push(this.getRandomSymbol(strip));
      }

      this.reels.push({
        symbols: symbols,           // Array of symbol names (e.g. ['tut', 'jack', 'ace', ...])
        offsetY: 0,                 // Vertical scrolling pixel offset
        speed: 0,                   // Speed in pixels/frame
        state: 'idle',              // idle, spinning, stopping, bounce
        strip: strip,               // The reel strip configuration
        targetStopIndex: 0,         // Index of strip where it should stop
        stopDelay: 0,               // Millisecond delay before stopping
        feedIndex: 0,
        bounceProgress: 0,          // For reel stop bounce animation
        bounceDirection: 1          // 1 down, -1 up
      });
    }
    this.expandedReelsState = Array(this.config.reelsCount).fill(false);
  }

  getRandomSymbol(strip) {
    const idx = Math.floor(Math.random() * strip.length);
    return strip[idx];
  }

  setupResize() {
    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  resize() {
    const rect = this.canvas.parentElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    
    // Set display size
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
    
    // Set buffer size with high DPI support
    this.canvas.width = rect.width * dpr;
    this.canvas.height = rect.height * dpr;
    
    this.ctx.scale(dpr, dpr);

    // Calculate layouts
    const layoutW = rect.width;
    const layoutH = rect.height;

    // Slot Cabinet Margin Layout
    const marginX = layoutW * 0.05;
    const marginY = layoutH * 0.08;
    this.reelsWidth = layoutW - (2 * marginX);
    this.reelsHeight = layoutH - (2 * marginY);
    this.reelsX = marginX;
    this.reelsY = marginY;

    this.symbolWidth = this.reelsWidth / this.config.reelsCount;
    this.symbolHeight = this.reelsHeight / this.config.rowsCount;
  }

  // --- Game Loop ---
  animate() {
    this.update();
    this.render();
    requestAnimationFrame(() => this.animate());
  }

  update() {
    const now = Date.now();
    let allStopped = true;
    
    // Periodic state summary (every 120 frames)
    // if (!this._stateLogTimer || now - this._stateLogTimer > 3000) {
    //   this._stateLogTimer = now;
    //   const reelStates = this.reels.map((r, i) => ({
    //     reel: i,
    //     state: r.state,
    //     speed: r.speed.toFixed(1),
    //     offsetY: r.offsetY.toFixed(1),
    //     feedIdx: r.feedIndex,
    //     visible: [r.symbols[1], r.symbols[2], r.symbols[3]]
    //   }));
    //   console.log(`[STATE] engine.state=${this.state}, spinStart=${this.spinStart}, elapsed=${(now - this.spinStart).toFixed(0)}ms, reels:`, JSON.stringify(reelStates));
    //   if (this.targetGrid) {
    //     console.log(`[STATE] targetGrid:`, JSON.stringify(this.targetGrid));
    //   }
    // }

    // Update Particles
    this.particles = this.particles.filter(p => {
      p.x += p.vx;
      p.y += p.vy;
      p.alpha -= p.decay;
      p.rotation += p.vRotation;
      return p.alpha > 0;
    });

    // Update Reels Spin Physics
    for (let r = 0; r < this.reels.length; r++) {
      const reel = this.reels[r];
      
      if (reel.state === 'spinning') {
        allStopped = false;
        
        // Acceleration
        const maxSpeed = this.turboMode ? 80 : 50;
        if (reel.speed < maxSpeed) {
          reel.speed += 3;
        }
        
        reel.offsetY += reel.speed;
        
        // Wrap offset around symbol boundary
        if (reel.offsetY >= this.symbolHeight) {
          const shiftCount = Math.floor(reel.offsetY / this.symbolHeight);
          reel.offsetY = reel.offsetY % this.symbolHeight;
          
          // Shift symbols down, generate new at the top
          for (let s = 0; s < shiftCount; s++) {
            reel.symbols.pop();
            reel.symbols.unshift(this.getRandomSymbol(reel.strip));
          }
        }
        
        // Check if it's time to stop this reel
        const spinTimeElapsed = now - this.spinStart;
        if (spinTimeElapsed > reel.stopDelay) {
          console.log(`[Debug] Reel ${r} transitioning to stopping at ${now}`);
          reel.state = 'stopping';
          // Set engine state to 'stopping' when first reel starts stopping
          if (this.state === 'spinning') {
            this.state = 'stopping';
            this.config.onStateChange(this.state);
          }
        }
      } 
      else if (reel.state === 'stopping') {
        allStopped = false;

        // Decelerate slowly
        const minSpeed = 8;
        if (reel.speed > minSpeed) {
          reel.speed *= 0.90;
        } else {
          reel.speed = minSpeed;
        }

        reel.offsetY += reel.speed;

        if (reel.offsetY >= this.symbolHeight) {
          const shiftCount = Math.floor(reel.offsetY / this.symbolHeight);
          reel.offsetY = reel.offsetY % this.symbolHeight;
          
          for (let s = 0; s < shiftCount; s++) {
            reel.symbols.pop();
            const targetIdx = this.config.rowsCount - 1 - reel.feedIndex;
            const targetSymbol = this.targetGrid[r][targetIdx] || this.getRandomSymbol(reel.strip);
            reel.feedIndex++;
            reel.symbols.unshift(targetSymbol);
          }
        }

        // Check if we reached the final alignment spot (offsetY near 0, symbols align)
        // We match when we have exactly the final symbols loaded on the display reels.
        const visibleSymbols = [reel.symbols[1], reel.symbols[2], reel.symbols[3]];
        const targetSymbols = this.targetGrid[r];
        const matchesTarget = this.checkReelMatchesTarget(r);
        if (r === 0 && this.frameCount % 60 === 0) {
          console.log(`[STOP] Reel ${r}: state=stopping, speed=${reel.speed.toFixed(1)}, offsetY=${reel.offsetY.toFixed(1)}, feedIdx=${reel.feedIndex}, visible=${JSON.stringify(visibleSymbols)}, target=${JSON.stringify(targetSymbols)}, matches=${matchesTarget}`);
        }
        if (matchesTarget && reel.speed < 10) {
          console.log(`[Debug] Reel ${r} reached target and bouncing at ${now}`);
          reel.offsetY = 0;
          reel.speed = 0;
          reel.state = 'bounce';
          reel.bounceProgress = 0;
          reel.bounceDirection = 1; // Start bounce downward
          audio.playReelStop(r);
        }
      } 
      else if (reel.state === 'bounce') {
        allStopped = false;
        
        // mechanical bounce animation
        const bounceMax = this.symbolHeight * 0.12;
        const speed = bounceMax / 4;

        if (reel.bounceDirection === 1) {
          reel.offsetY += speed;
          if (reel.offsetY >= bounceMax) {
            reel.bounceDirection = -1;
          }
        } else {
          reel.offsetY -= speed;
          if (reel.offsetY <= 0) {
            reel.offsetY = 0;
            reel.state = 'idle';
            console.log(`[Debug] Reel ${r} settled to idle at ${now}`);
          }
        }
      }
    }

    // Handle transition from spinning to stops complete
    if (this.state === 'stopping' && allStopped) {
      console.log(`[Debug] All reels stopped. Evaluating results at ${now}`);
      this.evaluateSpinResult();
    }

    // Free Spins Expansion Animation
    if (this.state === 'expanding') {
      this.expansionProgress += 0.03;
      if (this.expansionProgress >= 1) {
        this.expansionProgress = 1;
        
        // Make the expansion persistent in state
        this.expansionReelsToAnimate.forEach(idx => {
          this.expandedReelsState[idx] = true;
          // Set all visible rows to the expanding symbol
          for (let row = 0; row < this.config.rowsCount; row++) {
            this.reels[idx].symbols[row + 1] = this.expandingSymbol;
          }
        });

        // Trigger expanding win sounds & presentation
        this.state = 'showing_wins';
        this.winCycleTimer = Date.now();
        this.winCycleIndex = -1; // Start showing all expanded wins
        
        const totalPayout = this.expandingWinData.totalPayoutMultiplier;
        const winAmount = totalPayout * this.betPerLine;
        this.balance += winAmount;
        this.freeSpinsAccumulatedWin += winAmount;
        this.lastWin = winAmount;

        audio.playWin(totalPayout);
        this.spawnWinParticles();
        this.config.onWin({ amount: winAmount, isExpanding: true });
        this.config.onStateChange(this.state);
      }
    }

    // Handle cycling of payline highlights
    if (this.state === 'showing_wins' && this.winData) {
      const timeElapsed = now - this.winCycleTimer;
      const totalWins = (this.expandingWinData ? this.expandingWinData.wins : this.winData.lineWins) || [];
      const hasScatter = this.winData.scatterWin && this.winData.scatterWin.payout > 0;
      
      const totalCycleItems = totalWins.length + (hasScatter ? 1 : 0);

      if (totalCycleItems > 1) {
        if (timeElapsed > this.winCycleDuration) {
          this.winCycleTimer = now;
          this.winCycleIndex = (this.winCycleIndex + 1) % totalCycleItems;
          
          // Map index to specific active lines or scatter
          if (this.winCycleIndex < totalWins.length) {
            this.activeWinLineIndex = totalWins[this.winCycleIndex].lineIndex;
          } else {
            this.activeWinLineIndex = -99; // Scatter indicator
          }
        }
      } else if (totalCycleItems === 1) {
        // Just show the single win line continuously
        this.winCycleIndex = 0;
        if (totalWins.length > 0) {
          this.activeWinLineIndex = totalWins[0].lineIndex;
        } else {
          this.activeWinLineIndex = -99;
        }
      } else {
        this.activeWinLineIndex = -1;
      }
    }
  }

  checkReelMatchesTarget(reelIdx) {
    const reel = this.reels[reelIdx];
    // Check if the current 3 visible symbols match the target grid
    // Visible symbols are at index 1, 2, 3 of the array
    for (let r = 0; r < this.config.rowsCount; r++) {
      if (reel.symbols[r + 1] !== this.targetGrid[reelIdx][r]) {
        return false;
      }
    }
    return true;
  }

  // --- Spin Controllers ---
  spin() {
    if (this.state !== 'idle' && this.state !== 'showing_wins') return;
    
    // Stop audio loops
    audio.stopBGM();

    // Check Balance
    if (!this.inFreeSpins) {
      if (this.balance < this.totalBet) {
        alert("Insufficient Balance!");
        this.autoPlay = false;
        return;
      }
      this.balance -= this.totalBet;
      this.lastWin = 0;
    }

    // Initialize/Reset State
    this.state = 'spinning';
    this.winData = null;
    this.expandingWinData = null;
    this.activeWinLineIndex = -1;
    this.expandedReelsState = Array(this.config.reelsCount).fill(false);
    this.config.onStateChange(this.state);

    // Pre-calculate Spin Result
    this.targetGrid = this.generateTargetGrid();
    console.log(`[SPIN] targetGrid:`, JSON.stringify(this.targetGrid));
    console.log(`[SPIN] spinDuration=${this.spinDuration}, turbo=${this.turboMode}, symbolHeight=${this.symbolHeight}`);
    
    // Trigger Spin Sound
    audio.playSpin();

    // Setup spin timers
    this.spinStart = Date.now();
    
    const stopInterval = this.turboMode ? 100 : this.reelDelay;
    for (let r = 0; r < this.reels.length; r++) {
      const reel = this.reels[r];
      reel.state = 'spinning';
      reel.speed = 20;
      reel.stopDelay = (this.turboMode ? 500 : this.spinDuration) + (r * stopInterval);
      reel.feedIndex = 0;
      console.log(`[SPIN] Reel ${r}: stopDelay=${reel.stopDelay}ms, strip=${reel.strip.length} symbols`);
    }
  }

  generateTargetGrid() {
    const grid = [];
    
    // Determine if we will force a scatter trigger for testing or generate randomly
    // A regular strip generation:
    for (let col = 0; col < this.config.reelsCount; col++) {
      const reelCol = [];
      const strip = this.config.reelStrips[col];
      
      // Select a random stop position on the strip
      const stopIndex = Math.floor(Math.random() * strip.length);
      for (let row = 0; row < this.config.rowsCount; row++) {
        const symbol = strip[(stopIndex + row) % strip.length];
        reelCol.push(symbol);
      }
      grid.push(reelCol);
    }
    
    return grid;
  }

  // Cheat method to test features
  forceWinResult(winType) {
    if (this.state !== 'idle' && this.state !== 'showing_wins') return;

    this.targetGrid = [];
    if (winType === 'scatter') {
      // Force 3 books on reels 1, 3, 5
      for (let col = 0; col < 5; col++) {
        const strip = this.config.reelStrips[col];
        const colSymbols = [this.getRandomSymbol(strip), this.getRandomSymbol(strip), this.getRandomSymbol(strip)];
        if (col === 0 || col === 2 || col === 4) {
          colSymbols[1] = 'book'; // Force book in middle
        }
        this.targetGrid.push(colSymbols);
      }
    } else if (winType === 'expanding') {
      // Force selected expanding symbol on 3 reels (e.g. 'tut' on 1, 3, 4)
      const sym = this.expandingSymbol || 'tut';
      for (let col = 0; col < 5; col++) {
        const strip = this.config.reelStrips[col];
        const colSymbols = [this.getRandomSymbol(strip), this.getRandomSymbol(strip), this.getRandomSymbol(strip)];
        if (col === 0 || col === 2 || col === 3) {
          colSymbols[Math.floor(Math.random() * 3)] = sym;
        }
        this.targetGrid.push(colSymbols);
      }
    } else if (winType === 'bigwin') {
      // Force line of 'tut'
      for (let col = 0; col < 5; col++) {
        this.targetGrid.push(['tut', 'tut', 'tut']);
      }
    }
    
    this.spin();
  }

  stopSpin() {
    if (this.state !== 'spinning') {
      console.log(`[Debug] stopSpin called but state is ${this.state}`);
      return;
    }
    console.log(`[Debug] stopSpin called. State: ${this.state}`);
    this.state = 'stopping';
    this.config.onStateChange(this.state);
    
    const now = Date.now();
    for (let r = 0; r < this.reels.length; r++) {
      this.reels[r].state = 'stopping';
      this.reels[r].stopDelay = now - this.spinStart + (r * 100);
      console.log(`[Debug] Reel ${r} stopDelay set to ${this.reels[r].stopDelay}`);
    }
  }

  evaluateSpinResult() {
    this.state = 'evaluating';
    this.config.onStateChange(this.state);

    const results = checkWins(
      this.targetGrid, 
      this.config.paytable, 
      this.linesCount, 
      'book', 
      'book'
    );

    this.winData = results;

    let payoutAmount = 0;
    
    // Evaluate Scatter Payout
    if (results.scatterWin) {
      payoutAmount += results.scatterWin.payout * this.totalBet;
    }

    // Evaluate Line Payouts
    payoutAmount += results.totalLinePayoutMultiplier * this.betPerLine;
    this.lastWin = payoutAmount;
    this.balance += payoutAmount;
    
    if (this.inFreeSpins) {
      this.freeSpinsAccumulatedWin += payoutAmount;
    }

    // Trigger standard win sounds/particle highlights
    if (payoutAmount > 0) {
      this.spawnWinParticles();
      audio.playWin(results.totalLinePayoutMultiplier + (results.scatterWin ? results.scatterWin.payout * 10 : 0));
      this.config.onWin({ amount: payoutAmount, isExpanding: false });
    }

    // Check Scatter Mode / Free Spins Trigger
    if (results.scatterWin && results.scatterWin.triggerFreeSpins) {
      this.state = 'free_spins_intro';
      this.config.onStateChange(this.state);
      audio.playScatterTrigger();
      
      // Delay before opening book modal in game
      setTimeout(() => {
        this.config.onFreeSpinsTriggered();
      }, 1500);
      return;
    }

    // Handle Expanding Symbol evaluation in Free Spins mode
    if (this.inFreeSpins && this.expandingSymbol) {
      const expandingResults = checkExpandingWins(
        this.targetGrid,
        this.expandingSymbol,
        this.config.paytable,
        this.linesCount
      );

      if (expandingResults) {
        this.expandingWinData = expandingResults;
        this.state = 'expanding';
        this.expansionProgress = 0;
        this.expansionReelsToAnimate = expandingResults.expandedReels;
        this.config.onStateChange(this.state);
        audio.playExpand();
        return;
      }
    }

    // Resume flow
    if (payoutAmount > 0) {
      this.state = 'showing_wins';
      this.winCycleTimer = Date.now();
      this.winCycleIndex = -1;
    } else {
      this.state = 'idle';
      this.handleAutoPlay();
    }
    
    this.config.onStateChange(this.state);
  }

  handleAutoPlay() {
    if (this.inFreeSpins) {
      // Auto progress free spins
      setTimeout(() => {
        this.spinFreeSpins();
      }, this.turboMode ? 800 : 1800);
    } else if (this.autoPlay) {
      setTimeout(() => {
        if (this.autoPlay && this.state === 'idle') {
          this.spin();
        }
      }, this.turboMode ? 300 : 1000);
    }
  }

  spinFreeSpins() {
    if (this.freeSpinsRemaining <= 0) {
      this.exitFreeSpins();
      return;
    }
    this.freeSpinsRemaining--;
    this.spin();
  }

  enterFreeSpins(spinsCount, expandingSymbol) {
    this.inFreeSpins = true;
    this.freeSpinsTotal = spinsCount;
    this.freeSpinsRemaining = spinsCount;
    this.expandingSymbol = expandingSymbol;
    this.freeSpinsAccumulatedWin = 0;
    
    // Start Spooky Background Loop
    audio.startBGM();

    this.state = 'idle';
    this.config.onStateChange(this.state);
    
    this.spinFreeSpins();
  }

  retriggerFreeSpins(spinsCount) {
    this.freeSpinsRemaining += spinsCount;
    this.freeSpinsTotal += spinsCount;
  }

  exitFreeSpins() {
    this.inFreeSpins = false;
    this.expandingSymbol = null;
    audio.stopBGM();
    
    this.state = 'game_over';
    this.config.onStateChange(this.state);
  }

  // --- Rendering Functions ---
  render() {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    if (!this.assetsLoaded) {
      this.renderLoading();
      return;
    }

    // Draw Background cabinet glow
    this.renderCabinet();

    // Clip to reels area
    this.ctx.save();
    this.ctx.beginPath();
    this.ctx.rect(this.reelsX, this.reelsY, this.reelsWidth, this.reelsHeight);
    this.ctx.clip();

    // Draw Reels Background
    this.renderReelsBackground();

    // Draw Symbols
    this.renderReelsSymbols();

    // Draw Expanding Overlay (if animating expansion)
    this.renderExpandingAnimation();

    this.ctx.restore();

    // Draw Cabinet Borders and Grid Lines
    this.renderGridBorders();

    // Draw Winning Lines & Frames
    this.renderWinEffects();

    // Draw Particles
    this.renderParticles();
  }

  renderLoading() {
    this.ctx.fillStyle = '#0f0f13';
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    this.ctx.fillStyle = '#d4af37'; // Gold
    this.ctx.font = 'bold 24px Outfit, Inter, sans-serif';
    this.ctx.textAlign = 'center';
    this.ctx.textBaseline = 'middle';
    
    // Glowing loading text
    this.ctx.shadowColor = '#d4af37';
    this.ctx.shadowBlur = 15;
    this.ctx.fillText("LOADING SACRED SCROLLS...", this.canvas.width / (2 * (window.devicePixelRatio || 1)), this.canvas.height / (2 * (window.devicePixelRatio || 1)));
    this.ctx.shadowBlur = 0;
  }

  renderCabinet() {
    const rx = this.reelsX;
    const ry = this.reelsY;
    const rw = this.reelsWidth;
    const rh = this.reelsHeight;

    // Glowing cabinet background
    const gradient = this.ctx.createRadialGradient(
      rx + rw / 2, ry + rh / 2, rh * 0.2, 
      rx + rw / 2, ry + rh / 2, rw * 0.7
    );
    gradient.addColorStop(0, '#1a1405'); // Gold-tinted obsidian
    gradient.addColorStop(1, '#07070b'); // Obsidian

    this.ctx.fillStyle = gradient;
    this.ctx.fillRect(0, 0, rx * 2 + rw, ry * 2 + rh);

    // Glowing neon border around slot
    this.ctx.strokeStyle = '#d4af37';
    this.ctx.lineWidth = 4;
    this.ctx.shadowColor = '#d4af37';
    this.ctx.shadowBlur = 10;
    this.ctx.strokeRect(rx - 2, ry - 2, rw + 4, rh + 4);
    this.ctx.shadowBlur = 0;
  }

  renderReelsBackground() {
    this.ctx.fillStyle = 'rgba(10, 10, 15, 0.85)';
    this.ctx.fillRect(this.reelsX, this.reelsY, this.reelsWidth, this.reelsHeight);
    
    // Dark separators
    this.ctx.strokeStyle = 'rgba(212, 175, 55, 0.15)';
    this.ctx.lineWidth = 1;
    for (let c = 1; c < this.config.reelsCount; c++) {
      const cx = this.reelsX + (c * this.symbolWidth);
      this.ctx.beginPath();
      this.ctx.moveTo(cx, this.reelsY);
      this.ctx.lineTo(cx, this.reelsY + this.reelsHeight);
      this.ctx.stroke();
    }
  }

  renderReelsSymbols() {
    for (let col = 0; col < this.config.reelsCount; col++) {
      const reel = this.reels[col];
      const cx = this.reelsX + (col * this.symbolWidth);
      const isExpanded = this.expandedReelsState[col];

      // Draw symbols in the array
      // Visible rows are rows 1, 2, 3. Row 0 and 4 are hidden/bleeding symbols.
      for (let s = 0; s < reel.symbols.length; s++) {
        const symbol = reel.symbols[s];
        
        // Calculate Y position
        // Row 0 is shifted by offsetY.
        const cy = this.reelsY + ((s - 1) * this.symbolHeight) + reel.offsetY;
        
        // Draw the symbol
        // If the reel is spinning fast, apply motion blur (stretch vertically)
        const isSpinningFast = reel.state === 'spinning' && reel.speed > 30;
        this.drawSymbol(symbol, cx, cy, this.symbolWidth, this.symbolHeight, isSpinningFast ? reel.speed : 0);
      }
    }
  }

  drawSymbol(name, x, y, width, height, blurSpeed = 0) {
    const tile = this.config.symbolsConfig[name];
    if (!tile) return;

    // Outer border margin
    const margin = width * 0.08;
    const destX = x + margin;
    const destY = y + margin;
    const destW = width - (2 * margin);
    const destH = height - (2 * margin);

    this.ctx.save();
    
    if (blurSpeed > 0) {
      // Motion blur effect using vertical scaling and alpha blending
      const stretch = Math.min(2.0, 1 + (blurSpeed / 50));
      const blurCount = 3;
      
      this.ctx.globalAlpha = 0.35;
      for (let i = 0; i < blurCount; i++) {
        const offset = (i - (blurCount - 1) / 2) * (blurSpeed * 0.15);
        this.ctx.drawImage(
          this.spritesheet,
          tile.x, tile.y, tile.w, tile.h,
          destX, destY + offset - (destH * (stretch - 1) / 2), destW, destH * stretch
        );
      }
    } else {
      // Standard crystal clear draw
      this.ctx.drawImage(
        this.spritesheet,
        tile.x, tile.y, tile.w, tile.h,
        destX, destY, destW, destH
      );
    }

    this.ctx.restore();
  }

  renderExpandingAnimation() {
    if (this.state !== 'expanding' || !this.expandingSymbol) return;

    const tile = this.config.symbolsConfig[this.expandingSymbol];
    if (!tile) return;

    // Draw the expansion overlays on active columns
    this.expansionReelsToAnimate.forEach(colIdx => {
      const cx = this.reelsX + (colIdx * this.symbolWidth);

      // Expansion grows outwards from the center row (row 1)
      const centerRowY = this.reelsY + (1 * this.symbolHeight);
      
      this.ctx.save();
      this.ctx.globalAlpha = this.expansionProgress * 0.9;
      
      // Calculate animated heights for row 0, 1, 2
      const fullH = this.symbolHeight * 3;
      const animH = fullH * this.expansionProgress;
      const animY = centerRowY + (this.symbolHeight / 2) - (animH / 2);

      // Render expanding neon aura
      this.ctx.fillStyle = 'rgba(212, 175, 55, 0.2)';
      this.ctx.fillRect(cx, animY, this.symbolWidth, animH);
      
      this.ctx.shadowColor = '#d4af37';
      this.ctx.shadowBlur = 20;
      this.ctx.strokeStyle = '#d4af37';
      this.ctx.lineWidth = 3;
      this.ctx.strokeRect(cx + 2, animY, this.symbolWidth - 4, animH);
      this.ctx.shadowBlur = 0;

      // Draw expanding symbols on the 3 rows based on progress
      for (let r = 0; r < 3; r++) {
        const finalY = this.reelsY + (r * this.symbolHeight);
        
        // Only render if within the expanding height bounds
        if (finalY + (this.symbolHeight/2) >= animY && finalY + (this.symbolHeight/2) <= animY + animH) {
          const margin = this.symbolWidth * 0.08;
          const scale = 0.5 + (0.5 * this.expansionProgress);
          
          this.ctx.save();
          this.ctx.translate(cx + this.symbolWidth/2, finalY + this.symbolHeight/2);
          this.ctx.scale(scale, scale);
          
          this.ctx.drawImage(
            this.spritesheet,
            tile.x, tile.y, tile.w, tile.h,
            -this.symbolWidth/2 + margin, -this.symbolHeight/2 + margin, 
            this.symbolWidth - (2*margin), this.symbolHeight - (2*margin)
          );
          
          this.ctx.restore();
        }
      }

      this.ctx.restore();
    });
  }

  renderGridBorders() {
    const rx = this.reelsX;
    const ry = this.reelsY;
    const rw = this.reelsWidth;
    const rh = this.reelsHeight;

    // Cabinet thick border
    this.ctx.strokeStyle = '#2d2510'; // antique gold
    this.ctx.lineWidth = 6;
    this.ctx.strokeRect(rx, ry, rw, rh);

    // Subtle horizontal grid borders (separating rows)
    this.ctx.strokeStyle = 'rgba(212, 175, 55, 0.3)';
    this.ctx.lineWidth = 2;
    for (let r = 1; r < this.config.rowsCount; r++) {
      const cy = ry + (r * this.symbolHeight);
      this.ctx.beginPath();
      this.ctx.moveTo(rx, cy);
      this.ctx.lineTo(rx + rw, cy);
      this.ctx.stroke();
    }
  }

  renderWinEffects() {
    if (this.state !== 'showing_wins' || !this.winData) return;

    const totalWins = (this.expandingWinData ? this.expandingWinData.wins : this.winData.lineWins) || [];
    const hasScatter = this.winData.scatterWin && this.winData.scatterWin.payout > 0;

    // 1. Draw win lines
    totalWins.forEach((win, idx) => {
      // Only draw the currently active line in the cycle (or all if cycle is -1)
      const isActive = (this.winCycleIndex === -1) || (idx === this.winCycleIndex && this.activeWinLineIndex === win.lineIndex);
      if (!isActive) return;

      const path = PAYLINES[win.lineIndex];
      this.ctx.save();
      this.ctx.strokeStyle = this.getNeonColorForLine(win.lineIndex);
      this.ctx.lineWidth = 4;
      this.ctx.lineCap = 'round';
      this.ctx.lineJoin = 'round';
      
      // Shadow glow
      this.ctx.shadowColor = this.ctx.strokeStyle;
      this.ctx.shadowBlur = 12;

      this.ctx.beginPath();
      for (let col = 0; col < 5; col++) {
        const row = path[col];
        const cx = this.reelsX + (col * this.symbolWidth) + (this.symbolWidth / 2);
        const cy = this.reelsY + (row * this.symbolHeight) + (this.symbolHeight / 2);
        if (col === 0) {
          this.ctx.moveTo(cx, cy);
        } else {
          this.ctx.lineTo(cx, cy);
        }
      }
      this.ctx.stroke();
      
      // Draw Line Tag numbers at start and end
      const startY = this.reelsY + (path[0] * this.symbolHeight) + (this.symbolHeight / 2);
      const endY = this.reelsY + (path[4] * this.symbolHeight) + (this.symbolHeight / 2);
      this.drawTag(win.lineIndex + 1, this.reelsX - 15, startY, this.ctx.strokeStyle);
      this.drawTag(win.lineIndex + 1, this.reelsX + this.reelsWidth + 15, endY, this.ctx.strokeStyle);

      this.ctx.restore();
    });

    // 2. Draw glowing highlights on matching symbols
    let activeWinsToHighlight = [];
    if (this.winCycleIndex === -1) {
      // Highlight ALL winning spots
      totalWins.forEach(w => activeWinsToHighlight.push(...w.winningPositions));
      if (hasScatter) {
        activeWinsToHighlight.push(...this.winData.scatterWin.winningPositions);
      }
    } else {
      // Highlight only the specific active win cycle item
      if (this.winCycleIndex < totalWins.length) {
        activeWinsToHighlight.push(...totalWins[this.winCycleIndex].winningPositions);
      } else if (hasScatter) {
        activeWinsToHighlight.push(...this.winData.scatterWin.winningPositions);
      }
    }

    // Filter unique coordinates
    const uniquePositions = [];
    activeWinsToHighlight.forEach(pos => {
      if (!uniquePositions.some(p => p[0] === pos[0] && p[1] === pos[1])) {
        uniquePositions.push(pos);
      }
    });

    // Render glowing box overlays
    uniquePositions.forEach(([col, row]) => {
      const cx = this.reelsX + (col * this.symbolWidth);
      const cy = this.reelsY + (row * this.symbolHeight);
      
      this.ctx.save();
      this.ctx.strokeStyle = '#d4af37'; // gold border
      this.ctx.lineWidth = 3;
      
      // Pulsing glow factor
      const pulse = 5 + Math.sin(Date.now() / 100) * 4;
      this.ctx.shadowColor = '#d4af37';
      this.ctx.shadowBlur = pulse;

      this.ctx.fillStyle = 'rgba(212, 175, 55, 0.15)'; // gold tint overlay
      this.ctx.fillRect(cx + 4, cy + 4, this.symbolWidth - 8, this.symbolHeight - 8);
      this.ctx.strokeRect(cx + 4, cy + 4, this.symbolWidth - 8, this.symbolHeight - 8);

      this.ctx.restore();
    });
  }

  drawTag(num, x, y, color) {
    this.ctx.save();
    this.ctx.fillStyle = '#0f0f13';
    this.ctx.strokeStyle = color;
    this.ctx.lineWidth = 2;
    
    this.ctx.beginPath();
    this.ctx.arc(x, y, 12, 0, Math.PI * 2);
    this.ctx.fill();
    this.ctx.stroke();

    this.ctx.fillStyle = '#fff';
    this.ctx.font = 'bold 11px Outfit, Inter, sans-serif';
    this.ctx.textAlign = 'center';
    this.ctx.textBaseline = 'middle';
    this.ctx.fillText(num, x, y);
    this.ctx.restore();
  }

  getNeonColorForLine(lineIdx) {
    const colors = [
      '#ff003c', // Red
      '#00ff66', // Green
      '#00d2ff', // Light Blue
      '#ffcc00', // Yellow
      '#ff00ff', // Violet
      '#ff6600', // Orange
      '#00ffff', // Cyan
      '#9933ff', // Deep Purple
      '#d4af37', // Gold
      '#33ff33'  // Lime
    ];
    return colors[lineIdx % colors.length];
  }

  spawnWinParticles() {
    this.particles = [];
    const totalWins = (this.expandingWinData ? this.expandingWinData.wins : this.winData.lineWins) || [];
    
    let spots = [];
    totalWins.forEach(w => spots.push(...w.winningPositions));
    if (this.winData.scatterWin) {
      spots.push(...this.winData.scatterWin.winningPositions);
    }

    spots.forEach(([col, row]) => {
      const cx = this.reelsX + (col * this.symbolWidth) + (this.symbolWidth / 2);
      const cy = this.reelsY + (row * this.symbolHeight) + (this.symbolHeight / 2);

      // Create 20 gold star/bubble particles per spot
      for (let i = 0; i < 20; i++) {
        const angle = Math.random() * Math.PI * 2;
        const speed = 1 + Math.random() * 5;
        this.particles.push({
          x: cx,
          y: cy,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed - 1.5, // slightly upward force
          size: 2 + Math.random() * 6,
          alpha: 1.0,
          decay: 0.015 + Math.random() * 0.02,
          color: `hsl(${45 + Math.random() * 15}, 100%, ${50 + Math.random() * 30}%)`, // Gold gradients
          rotation: Math.random() * Math.PI * 2,
          vRotation: -0.1 + Math.random() * 0.2
        });
      }
    });
  }

  renderParticles() {
    this.particles.forEach(p => {
      this.ctx.save();
      this.ctx.globalAlpha = p.alpha;
      this.ctx.fillStyle = p.color;

      // Draw star shape or glowing circle
      this.ctx.beginPath();
      this.ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      this.ctx.fill();
      
      this.ctx.restore();
    });
  }
}
