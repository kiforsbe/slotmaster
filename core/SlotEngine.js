// Core Slot Game Engine Renderer & State Controller
import { checkWins, createSeededRng } from './SlotMath.js';
import { audio } from './SlotAudio.js';
import { simulateSpins } from './SpinSimulator.js';
import { LineMechanic } from './LineMechanic.js';
import { createSpinLogEntry, applyExpandingWinToSpinLogEntry } from './SpinLog.js';
import { computeGridLayout } from './GridLayout.js';
import { drawSpriteSymbol } from './SpriteDrawer.js';
import { ParticleSystem } from './ParticleSystem.js';

// Caps SlotEngine.spinLog's size (see its own doc) - generous for a dev-tooling export, small
// enough that an unattended autoplay/turbo session doesn't grow memory usage without bound.
const SPIN_LOG_MAX_ENTRIES = 20000;

// How far outside the grid a payline's numbered tag sits - and therefore where its line starts
// and ends, since the line runs tag to tag.
const LINE_TAG_OFFSET = 15;

export class SlotEngine {
  constructor(canvas, config = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    
    // Core game configurations - shallow copy to avoid mutating caller's object
    this.config = {
      reelsCount: 5,
      rowsCount: 3,
      paytable: {},
      reelStrips: [],
      // paylines has no default - every game must supply its own (see core/SlotMath.js).
      wildSymbol: null,
      scatterSymbol: null,
      winEvaluator: checkWins,
      // The "get symbols for the playfield" / "calculate wins" component pair (core/
      // LineMechanic.js) - shared with core/SpinSimulator.js's batch simulation/tuning, so a
      // live spin and a simulated one resolve identically. A future gameplay mechanic (e.g. a
      // cascading line-pay hybrid) plugs in here without any SlotEngine changes.
      mechanic: LineMechanic,
      onStateChange: () => {},
      onFreeSpinsTriggered: () => {},
      onScatterTrigger: (scatterCount) => {},
      onWin: () => {},
      ...config
    };
    
    // Asset references - separate from config to avoid mutating the user's object
    this.spritesheetUrl = config.spritesheetUrl || '';
    this.symbolsConfig = config.symbolsConfig || {};

    // State Variables
    this.state = 'idle'; // idle, spinning, stopping, evaluating, free_spins_intro, expanding, showing_wins, game_over
    this.balance = 1000;
    this.betPerLine = config.betPerLine ?? 1;
    this.linesCount = config.linesCount ?? 10;
    this.totalBet = this.betPerLine * this.linesCount;
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
    this.pendingSpinRequest = false; // queued spin click received while busy (e.g. expanding)

    // Win presentation state
    this.winData = null;
    this.expandingWinData = null;
    this.activeWinLineIndex = -1;
    this.winCycleTimer = 0;
    this.winCycleDuration = 1000; // ms per win line display
    this.winCycleIndex = -1; // -1 means show all wins, 0..N means show specific line win
    
    // Frame counter for debug/logging
    this.frameCount = 0;
    
    // Debug mode flag - enables debug console.log statements
    this.debugMode = false;

    // Visual Effects
    this.particleSystem = new ParticleSystem();
    this.expandedReelsState = []; // Track which reels are currently expanded [false, false, ...]
    this.expansionProgress = 0; // 0..1 for expanding animation
    this.expansionReelsToAnimate = []; // indices of reels to expand

    // Sound engine alias
    this.audio = audio;

    // Per-spin log for real (interactive) play - one entry per resolved spin, each with its
    // own seed (unlike the batch simulateSpins() path, a live spin already generates a fresh
    // seed every time via spin(), so it's genuinely per-spin here). Bounded so an unattended
    // long autoplay/turbo session can't grow this unboundedly; trimmed a single entry at a
    // time once over the cap, so the cost stays O(1) per spin rather than an O(n) shift.
    this.spinLog = [];
    this._pendingExpandingLogEntry = null;

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

  loadAssets(spritesheetUrl = this.spritesheetUrl, symbolsConfig = this.symbolsConfig) {
    this.assetsLoaded = false;
    this.spritesheetUrl = spritesheetUrl;
    this.symbolsConfig = symbolsConfig;

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
      const strip = this.config.reelStrips[r];
      if (!strip) {
        // A silent fallback here used to substitute placeholder card symbols ('jack',
        // 'queen', ...) that don't exist in any current game's paytable - a misconfigured
        // reelsCount/reelStrips mismatch would render broken symbols instead of failing
        // loudly at the actual point of misconfiguration.
        throw new Error(
          `SlotEngine: reelStrips[${r}] is missing - reelsCount (${this.config.reelsCount}) ` +
          `doesn't match reelStrips.length (${this.config.reelStrips.length})`
        );
      }

      // Initialize each reel with random symbols
      const symbols = [];
      for (let i = 0; i < this.config.rowsCount + 3; i++) {
        symbols.push(this.getRandomSymbol(strip));
      }

      this.reels.push({
        // `symbols` and `strip` are NOT redundant, despite both being arrays of symbol
        // names: `strip` is the full, static, correctly-weighted virtual reel (built once
        // by generateReel - more entries for common symbols, fewer for rare ones), the
        // canonical probability data. `symbols` is a small rolling window (rowsCount + 3
        // entries) of what's currently drawn on screen - refilled every frame from `strip`
        // while spinning, set to a specific consecutive slice of `strip` on landing. It has
        // no weighting logic of its own because it doesn't need any - it's a view into
        // `strip`, not a second, independent source of randomness.
        symbols: symbols,           // Array of symbol names (e.g. ['tut', 'jack', 'ace', ...])
        offsetY: 0,                 // Vertical scrolling pixel offset
        speed: 0,                   // Speed in pixels/frame - cosmetic, only used while 'spinning'
        state: 'idle',              // idle, spinning, landing, bounce
        strip: strip,               // The reel strip configuration
        targetStopIndex: 0,         // Index of strip where it should stop
        landStartTime: 0,           // Date.now()-scale timestamp when landing begins (set by spin())
        landElapsedStart: 0,        // Date.now()-scale timestamp when landing actually started
        landDuration: 0,            // ms the landing tween takes; set per-spin (turbo vs normal)
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
    // Debounce resize handler to prevent excessive recalculations
    let resizeTimeout;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(() => this.resize(), 100);
    });
    this.resize();
  }

  resize() {
    const parentRect = this.canvas.parentElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const layout = computeGridLayout(parentRect.width, parentRect.height, dpr, this.config.reelsCount, this.config.rowsCount);

    this.canvas.style.width = `${layout.cssWidth}px`;
    this.canvas.style.height = `${layout.cssHeight}px`;
    this.canvas.width = layout.canvasWidth;
    this.canvas.height = layout.canvasHeight;

    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.scale(dpr, dpr);

    this.symbolWidth = layout.cellSize;
    this.symbolHeight = layout.cellSize;
    this.reelsWidth = layout.reelsWidth;
    this.reelsHeight = layout.reelsHeight;
    this.reelsX = layout.reelsX;
    this.reelsY = layout.reelsY;
  }

  // --- Game Loop ---
  animate() {
    this.update();
    this.render();
    requestAnimationFrame(() => this.animate());
  }

  update() {
    this.frameCount++;
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
    //     visible: [r.symbols[1], r.symbols[2], r.symbols[3]]
    //   }));
    //   console.log(`[STATE] engine.state=${this.state}, spinStart=${this.spinStart}, elapsed=${(now - this.spinStart).toFixed(0)}ms, reels:`, JSON.stringify(reelStates));
    //   if (this.targetGrid) {
    //     console.log(`[STATE] targetGrid:`, JSON.stringify(this.targetGrid));
    //   }
    // }

    // Update Particles
    this.particleSystem.update();

    // Update Reels Spin Physics
    for (let r = 0; r < this.reels.length; r++) {
      const reel = this.reels[r];
      
      if (reel.state === 'spinning') {
        allStopped = false;

        // Acceleration - cosmetic only. Correctness never depends on speed/timing here:
        // landing is scheduled for a precomputed instant below, not detected by watching
        // this physics converge, so it can never overshoot or undershoot the target.
        const maxSpeed = this.turboMode ? 80 : 50;
        if (reel.speed < maxSpeed) {
          reel.speed += 3;
        }

        reel.offsetY += reel.speed;

        // Wrap offset around symbol boundary, feeding random decorative symbols while spinning
        if (reel.offsetY >= this.symbolHeight) {
          const shiftCount = Math.floor(reel.offsetY / this.symbolHeight);
          reel.offsetY = reel.offsetY % this.symbolHeight;

          for (let s = 0; s < shiftCount; s++) {
            reel.symbols.pop();
            reel.symbols.unshift(this.getRandomSymbol(reel.strip));
          }
        }

        // Landing begins at a precomputed instant (set in spin()): reel.landStartTime =
        // spinStart + stopDelay - landDuration. The moment it begins, the final symbols are
        // set once, directly - not fed in incrementally based on distance traveled - so
        // there's nothing left to detect and nothing that can overshoot.
        if (now >= reel.landStartTime) {
          if (this.debugMode) console.log(`[Debug] Reel ${r} entering landing at ${now}`);
          reel.symbols = [
            this.getRandomSymbol(reel.strip),
            this.targetGrid[r][0],
            this.targetGrid[r][1],
            this.targetGrid[r][2],
            this.getRandomSymbol(reel.strip),
            this.getRandomSymbol(reel.strip)
          ];
          reel.offsetY = this.symbolHeight;
          reel.speed = 0;
          reel.state = 'landing';
          reel.landElapsedStart = now;

          // Set engine state to 'stopping' when the first reel starts landing
          if (this.state === 'spinning') {
            this.state = 'stopping';
            this.config.onStateChange(this.state);
          }
        }
      }
      else if (reel.state === 'landing') {
        allStopped = false;

        const elapsed = now - reel.landElapsedStart;
        const progress = Math.min(elapsed / reel.landDuration, 1);
        reel.offsetY = this.symbolHeight * (1 - this.easeOutCubic(progress));

        if (this.debugMode && r === 0 && this.frameCount % 60 === 0) {
          console.log(`[LAND] Reel ${r}: progress=${progress.toFixed(2)}, offsetY=${reel.offsetY.toFixed(1)}`);
        }

        if (progress >= 1) {
          if (this.debugMode) console.log(`[Debug] Reel ${r} landed, bouncing at ${now}`);
          reel.offsetY = 0;
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
            if (this.debugMode) console.log(`[Debug] Reel ${r} settled to idle at ${now}`);
          }
        }
      }
    }

    // Handle transition from spinning to stops complete
    if (this.state === 'stopping' && allStopped) {
      if (this.debugMode) console.log(`[Debug] All reels stopped. Evaluating results at ${now}`);
      this.evaluateSpinResult();
    }

    // Free Spins Expansion Animation
    if (this.state === 'expanding') {
      // Progress one reel at a time, left to right, slower
      const reelExpandDuration = 900; // ms per reel
      
      for (let i = 0; i < this.expansionReelsToAnimate.length; i++) {
        const reelIdx = this.expansionReelsToAnimate[i];
        const reelStartTime = this.expansionReelStartTimes[i];
        const elapsed = now - reelStartTime;
        const reelProgress = Math.min(elapsed / reelExpandDuration, 1);
        
        if (reelProgress >= 1) {
          // This reel is fully expanded
          this.expandedReelsState[reelIdx] = true;
          for (let row = 0; row < this.config.rowsCount; row++) {
            this.reels[reelIdx].symbols[row + 1] = this.expandingSymbol;
          }
        }
      }
      
      // Check if all reels are done
      const lastReelIdx = this.expansionReelsToAnimate[this.expansionReelsToAnimate.length - 1];
      const lastStartTime = this.expansionReelStartTimes[this.expansionReelsToAnimate.length - 1];
      const lastElapsed = now - lastStartTime;
      
      if (lastElapsed / reelExpandDuration >= 1) {
        // All reels expanded, finalize
        this.expansionProgress = 1;
        
        // Trigger expanding win sounds & presentation
        this.state = 'showing_wins';
        this.winCycleTimer = Date.now();
        this.winCycleIndex = -1; // Start showing all expanded wins
        
        const totalPayout = this.expandingWinData.totalPayoutMultiplier;
        const winAmount = totalPayout * this.betPerLine;
        this.balance += winAmount;
        this.freeSpinsAccumulatedWin += winAmount;
        this.lastWin = winAmount;

        // Top up the spin log entry created back in evaluateSpinResult() with the expanding
        // win, which only resolves now that its animation has finished playing out.
        if (this._pendingExpandingLogEntry) {
          applyExpandingWinToSpinLogEntry(this._pendingExpandingLogEntry, {
            expandingSymbol: this.expandingSymbol,
            expandingReels: this.expandingWinData.expandingReels.length,
            expandingWin: winAmount
          });
          this._pendingExpandingLogEntry = null;
        }

        audio.playWin(totalPayout);
        this.spawnWinParticles();
        this.config.onWin({ amount: winAmount, isExpanding: true });

        // Without this, free spins silently stall here forever: expanding wins are the
        // headline feature of free spins, so every free-spin round that includes one would
        // otherwise never advance to the next spin without a manual click.
        this.handleAutoPlay();

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

    // Consume a queued spin request (from a click received while busy, e.g. mid-expansion)
    // now that we've reached a safe state to actually spin.
    if (this.pendingSpinRequest && (this.state === 'idle' || this.state === 'showing_wins')) {
      this.pendingSpinRequest = false;
      this.startNextSpin();
    }
  }

  // Standard ease-out-cubic: fast start, gentle settle. Drives the landing-phase tween
  // as a pure function of elapsed time - there is no "does it match" question anymore,
  // landing is guaranteed correct by construction the instant it begins (see update()).
  easeOutCubic(t) {
    return 1 - Math.pow(1 - t, 3);
  }

  // --- Spin Controllers ---

  // Entry point for the UI's spin/stop button. Safe to call at any time, including
  // while an expansion/win presentation is still animating: a click that arrives
  // mid-animation is queued (see update()) rather than immediately spinning again
  // or silently consuming a free spin while nothing visible happens.
  requestSpin() {
    if (this.state === 'spinning' || this.state === 'stopping') {
      this.stopSpin();
      return;
    }
    if (this.state === 'idle' || this.state === 'showing_wins') {
      this.startNextSpin();
      return;
    }
    this.pendingSpinRequest = true;
  }

  startNextSpin() {
    // Cancel any pending auto-advance so it can't also fire and double-count
    if (this.autoPlayTimer) {
      clearTimeout(this.autoPlayTimer);
      this.autoPlayTimer = null;
    }
    if (this.inFreeSpins) {
      this.spinFreeSpins();
    } else {
      this.spin();
    }
  }

  spin(seed) {
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

    // Initialize expansion timers
    this.expansionReelStartTimes = [];
    for (let i = 0; i < this.config.reelsCount; i++) {
        this.expansionReelStartTimes[i] = Date.now();
    }

    this.config.onStateChange(this.state);

    // Pre-calculate Spin Result (skip if forceWinResult already set targetGrid).
    // The seed is captured on the engine so the exact same outcome can be replayed
    // later via engine.spin(engine.lastSpinSeed) - no separate replay subsystem needed.
    if (!this.forcedTargetGrid) {
      const spinSeed = seed !== undefined ? seed : ((Date.now() ^ (Math.random() * 0xFFFFFFFF)) >>> 0);
      this.lastSpinSeed = spinSeed;
      this.targetGrid = this.config.mechanic.getTargetGrid(this.config.reelStrips, this.config.rowsCount, createSeededRng(spinSeed));
      if (this.debugMode) console.log(`[SPIN] seed=${spinSeed}`);
    }
    this.forcedTargetGrid = false; // Reset flag
    if (this.debugMode) console.log(`[SPIN] targetGrid:`, JSON.stringify(this.targetGrid));
    if (this.debugMode) console.log(`[SPIN] spinDuration=${this.spinDuration}, turbo=${this.turboMode}, symbolHeight=${this.symbolHeight}`);

    // Trigger Spin Sound
    audio.playSpin();

    // Setup spin timers
    this.spinStart = Date.now();

    const stopInterval = this.turboMode ? 100 : this.reelDelay;
    const landDuration = this.turboMode ? 150 : 450;
    for (let r = 0; r < this.reels.length; r++) {
      const reel = this.reels[r];
      reel.state = 'spinning';
      reel.speed = 20;
      const stopDelay = (this.turboMode ? 500 : this.spinDuration) + (r * stopInterval);
      reel.landDuration = landDuration;
      // The reel is guaranteed fully landed by spinStart + stopDelay: landing itself begins
      // landDuration ms before that instant, so it always finishes exactly on time regardless
      // of frame rate or any speed/acceleration constant used while 'spinning'.
      reel.landStartTime = this.spinStart + stopDelay - landDuration;
      if (this.debugMode) console.log(`[SPIN] Reel ${r}: lands ${stopDelay}ms after spin start, strip=${reel.strip.length} symbols`);
    }
  }

  // Cheat method to test features
  forceWinResult(winType) {
    if (this.state !== 'idle' && this.state !== 'showing_wins') return;

    this.targetGrid = [];
    if (winType === 'scatter') {
      // Forces this.config.scatterSymbol into the first, middle, and last reel (middle row) -
      // works for any grid shape a game configures. Falls back to 'book' if scatterSymbol
      // isn't set, preserving this cheat's original book-of-dead-specific behavior for a game
      // that never configured one.
      const scatterSym = this.config.scatterSymbol || 'book';
      const reelsCount = this.config.reelsCount;
      const midRow = Math.floor(this.config.rowsCount / 2);
      const triggerCols = [0, Math.floor(reelsCount / 2), reelsCount - 1];
      for (let col = 0; col < reelsCount; col++) {
        const strip = this.config.reelStrips[col];
        const colSymbols = [];
        for (let row = 0; row < this.config.rowsCount; row++) colSymbols.push(this.getRandomSymbol(strip));
        if (triggerCols.includes(col)) {
          colSymbols[midRow] = scatterSym;
        }
        this.targetGrid.push(colSymbols);
      }
    } else if (winType === 'expanding') {
      // Book-of-dead-specific: assumes a 5-reel layout with an expanding symbol.
      // Only meaningful for games that configure one; fruit machine never calls this.
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
      // Works for any grid shape: force every visible symbol to a single symbol picked
      // from reel 1's own strip, so it's guaranteed to actually exist on every reel.
      const firstLineSymbol = this.getRandomSymbol(this.config.reelStrips[0]);
      for (let col = 0; col < this.config.reelsCount; col++) {
        this.targetGrid.push(Array(this.config.rowsCount).fill(firstLineSymbol));
      }
    }
    
    this.forcedTargetGrid = true;
    this.spin();
  }

  stopSpin() {
    if (this.state !== 'spinning') {
      if (this.debugMode) console.log(`[Debug] stopSpin called but state is ${this.state}`);
      return;
    }
    if (this.debugMode) console.log(`[Debug] stopSpin called. State: ${this.state}`);
    this.state = 'stopping';
    this.config.onStateChange(this.state);
    
    const now = Date.now();
    for (let r = 0; r < this.reels.length; r++) {
      const reel = this.reels[r];
      if (reel.state === 'spinning') {
        // Compress the remaining spin time: this reel begins landing almost immediately,
        // still slightly staggered per reel so an early stop doesn't feel like every reel
        // freezes at once. Reels already 'landing' (or 'bounce') are left alone - their
        // tween is already short and guaranteed-correct, nothing to compress.
        reel.landStartTime = now + (r * 80);
      }
      if (this.debugMode) console.log(`[Debug] Reel ${r} landStartTime compressed to ${reel.landStartTime - this.spinStart}ms after spin start`);
    }
  }

  evaluateSpinResult() {
    this.state = 'evaluating';
    this.config.onStateChange(this.state);

    const results = this.config.mechanic.evaluateWin(this.targetGrid, this.config, this.linesCount);

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

    // Logged now so every resolved spin gets exactly one entry, even ones that return early
    // below (a scatter-triggering spin never reaches the expanding check at all). If this spin
    // does turn out to have a pending expanding win, the entry is retrieved and topped up once
    // that resolves (see the 'expanding' branch in update()) rather than logged a second time.
    const spinLogEntry = this._pushSpinLogEntry(results);

    // Trigger standard win sounds/particle highlights
    if (payoutAmount > 0) {
      this.spawnWinParticles();
      audio.playWin(results.totalLinePayoutMultiplier + (results.scatterWin ? results.scatterWin.payout * 10 : 0));
      this.config.onWin({ amount: payoutAmount, isExpanding: false });
    }

    // Check Scatter Mode / Free Spins Trigger — game code decides everything
    if (results.scatterWin && results.scatterWin.triggerFreeSpins) {
      // Notify game code; it will set state, play animation, and decide what to do
      audio.playScatterTrigger();
      this.config.onScatterTrigger(results.scatterWin.count, this.inFreeSpins);
      return;
    }

    // Handle Expanding Symbol evaluation in Free Spins mode
    if (this.inFreeSpins && this.expandingSymbol) {
      const expandingResults = this.config.mechanic.evaluateExpandingWin(
        this.targetGrid, this.expandingSymbol, this.config, this.linesCount
      );

      if (expandingResults) {
        this.expandingWinData = expandingResults;
        this._pendingExpandingLogEntry = spinLogEntry;
        this.state = 'expanding';
        this.expansionProgress = 0;
        this.expansionReelsToAnimate = expandingResults.expandingReels;
        // Set per-reel start times: each reel starts after the previous one finishes
        this.expansionReelStartTimes = [];
        let currentTime = Date.now();
        for (let i = 0; i < this.expansionReelsToAnimate.length; i++) {
          if (i === 0) {
            this.expansionReelStartTimes[i] = currentTime;
          } else {
            currentTime += 900; // Each reel starts 900ms after the previous one
          }
          this.expansionReelStartTimes[i] = currentTime;
        }
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
    }
    
    // Always handle auto-play for free spins progression
    this.handleAutoPlay();

    this.config.onStateChange(this.state);
  }

  // Records one entry in this.spinLog for the spin that just resolved in evaluateSpinResult()
  // (see that method's own comment for why it's called there instead of after every branch).
  // Its expanding-win fields (if any) are filled in later, once that resolves - see
  // applyExpandingWinToSpinLogEntry's use in update().
  _pushSpinLogEntry(results) {
    const isFreeSpin = this.inFreeSpins;
    const entry = createSpinLogEntry({
      spinIndex: this.spinLog.length + 1,
      phase: isFreeSpin ? 'free' : 'base',
      betPerLine: this.betPerLine,
      linesCount: this.linesCount,
      chargedBet: isFreeSpin ? 0 : this.totalBet,
      scatterBetBase: this.totalBet,
      winData: results,
      scatterSymbol: this.config.scatterSymbol,
      seed: this.lastSpinSeed,
      timestamp: Date.now()
    });
    this.spinLog.push(entry);
    if (this.spinLog.length > SPIN_LOG_MAX_ENTRIES) this.spinLog.shift();
    return entry;
  }

  handleAutoPlay() {
    // Clear any pending auto-play to prevent stacking
    if (this.autoPlayTimer) {
      clearTimeout(this.autoPlayTimer);
      this.autoPlayTimer = null;
    }
    
    if (this.inFreeSpins) {
      // Auto progress free spins
      this.autoPlayTimer = setTimeout(() => {
        this.spinFreeSpins();
      }, this.turboMode ? 800 : 1800);
    } else if (this.autoPlay) {
      this.autoPlayTimer = setTimeout(() => {
        // spin() itself accepts 'idle' or 'showing_wins' as valid starting states - matching
        // that here is essential: after any winning spin the state is 'showing_wins', not
        // 'idle', and an 'idle'-only check would silently stop autoplay on the very first win.
        if (this.autoPlay && (this.state === 'idle' || this.state === 'showing_wins')) {
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

  // Transition to free spins intro state (called by game code after scatter trigger)
  enterFreeSpinsIntro() {
    this.state = 'free_spins_intro';
    this.config.onStateChange(this.state);
  }

  // Transition back to idle state (called by game code after free spins summary)
  returnToIdle() {
    this.state = 'idle';
    this.config.onStateChange(this.state);
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
    drawSpriteSymbol(this.ctx, this.spritesheet, this.symbolsConfig[name], x, y, width, height, blurSpeed);
  }

  renderExpandingAnimation() {
    if (this.state !== 'expanding' || !this.expandingSymbol) return;

    const tile = this.symbolsConfig[this.expandingSymbol];
    if (!tile) return;

    const reelExpandDuration = 900; // ms per reel

    // Draw the expansion overlays on active columns, one at a time
    this.expansionReelsToAnimate.forEach((colIdx, i) => {
      const cx = this.reelsX + (colIdx * this.symbolWidth);
      const reelStartTime = this.expansionReelStartTimes[i];
      const elapsed = Date.now() - reelStartTime;
      const reelProgress = Math.min(elapsed / reelExpandDuration, 1);
      
      if (reelProgress <= 0) return; // Not started yet

      // Expansion grows outwards from the center row (row 1)
      const centerRowY = this.reelsY + (1 * this.symbolHeight);
      
      this.ctx.save();
      this.ctx.globalAlpha = reelProgress * 0.9;
      
      // Calculate animated heights for row 0, 1, 2
      const fullH = this.symbolHeight * 3;
      const animH = fullH * reelProgress;
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
          const scale = 0.5 + (0.5 * reelProgress);
          
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

      const path = this.config.paylines[win.lineIndex];
      this.ctx.save();
      this.ctx.strokeStyle = this.getNeonColorForLine(win.lineIndex);
      this.ctx.lineWidth = 4;
      this.ctx.lineCap = 'round';
      this.ctx.lineJoin = 'round';

      // Shadow glow
      this.ctx.shadowColor = this.ctx.strokeStyle;
      this.ctx.shadowBlur = 12;

      // The tags are where the line begins and ends, not decorations parked beside it, so the
      // stroke runs from one tag's center to the other, through every cell between. Stopping it
      // at the outer cells left the numbers floating unattached to the line they label.
      const lastReel = this.config.reelsCount - 1;
      const startY = this.reelsY + (path[0] * this.symbolHeight) + (this.symbolHeight / 2);
      const endY = this.reelsY + (path[lastReel] * this.symbolHeight) + (this.symbolHeight / 2);
      const leftTagX = this.reelsX - LINE_TAG_OFFSET;
      const rightTagX = this.reelsX + this.reelsWidth + LINE_TAG_OFFSET;

      this.ctx.beginPath();
      this.ctx.moveTo(leftTagX, startY);
      for (let col = 0; col < this.config.reelsCount; col++) {
        const row = path[col];
        const cx = this.reelsX + (col * this.symbolWidth) + (this.symbolWidth / 2);
        const cy = this.reelsY + (row * this.symbolHeight) + (this.symbolHeight / 2);
        this.ctx.lineTo(cx, cy);
      }
      this.ctx.lineTo(rightTagX, endY);
      this.ctx.stroke();

      // Drawn after the stroke, so each tag's opaque disc caps the end it sits on.
      this.drawTag(win.lineIndex + 1, leftTagX, startY, this.ctx.strokeStyle);
      this.drawTag(win.lineIndex + 1, rightTagX, endY, this.ctx.strokeStyle);

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
    const totalWins = (this.expandingWinData ? this.expandingWinData.wins : this.winData.lineWins) || [];
    let spots = [];
    totalWins.forEach(w => spots.push(...w.winningPositions));
    if (this.winData.scatterWin) {
      spots.push(...this.winData.scatterWin.winningPositions);
    }
    const points = spots.map(([col, row]) => ({
      x: this.reelsX + (col * this.symbolWidth) + (this.symbolWidth / 2),
      y: this.reelsY + (row * this.symbolHeight) + (this.symbolHeight / 2),
    }));
    this.particleSystem.spawn(points);
  }

  renderParticles() {
    this.particleSystem.render(this.ctx);
  }

    /**
   * Runs a batch of simulations and returns the results.
   * @param {number} numBaseSpins - The number of base spins to simulate.
   * @param {number} betPerLine - Defaults to this engine's own live betPerLine, so the
   *   simulation models exactly what the running game would actually pay, not a duplicated constant.
   * @param {number} linesCount - Defaults to this engine's own live linesCount, same reasoning.
   * @param {Object} [options]
   * @param {number} [options.seed] - Seeds the run for reproducibility (see createSeededRng);
   *   omit for the legacy Math.random-driven (non-reproducible) behavior.
   * @param {boolean} [options.logSpins=false] - Forwarded to simulateSpins' config.logSpins -
   *   see its own doc.
   * @returns {object} The simulation results.
   */
  runSimulation(numBaseSpins = 100000, betPerLine = this.betPerLine, linesCount = this.linesCount, options = {}) {
    const { seed = null, logSpins = false } = options;
    const rng = seed != null ? createSeededRng(seed) : Math.random;
    return simulateSpins({ ...this.config, logSpins }, numBaseSpins, betPerLine, linesCount, rng);
  }
}
