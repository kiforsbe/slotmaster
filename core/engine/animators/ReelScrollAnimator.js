// Physical reel-scroll entrance (SlotEngine.js's default today): reels spin up, then land in a
// staggered stop, one after another. A line-pay spin's step sequence is always length 1, so
// playTransition is never actually invoked by CoreSlotEngine - it exists only to satisfy the
// SpinAnimator interface every animator implements.
//
// Reel physics/timing below is a faithful port of SlotEngine.js's spin()/update()/easeOutCubic()
// (formulas kept identical - only the control flow changed, from a continuous engine-owned
// update() loop polled every frame to a self-contained tween loop scoped to one playEntrance
// call). The reel array itself is owned here (not by CoreSlotEngine), built lazily on first use
// so it persists across spins the same way SlotEngine.js's this.reels did.
const SPIN_SPEED_NORMAL_MAX = 50;
const SPIN_SPEED_TURBO_MAX = 80;

function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

export class ReelScrollAnimator {
  constructor(renderer, { spinDuration = 2000, reelDelay = 150 } = {}) {
    this.renderer = renderer;
    this.spinDuration = spinDuration;
    this.reelDelay = reelDelay;
    this.reels = null;
    this.expandedReelsState = [];
  }

  _ensureReels(engine) {
    if (this.reels) return;
    this.reels = [];
    for (let r = 0; r < engine.config.reelsCount; r++) {
      const strip = engine.config.reelStrips[r];
      const symbols = [];
      for (let i = 0; i < engine.config.rowsCount + 3; i++) {
        symbols.push(this._getRandomSymbol(strip));
      }
      this.reels.push({
        symbols, offsetY: 0, speed: 0, state: 'idle', strip,
        landStartTime: 0, landElapsedStart: 0, landDuration: 0,
        bounceProgress: 0, bounceDirection: 1,
      });
    }
    this.expandedReelsState = Array(engine.config.reelsCount).fill(false);
  }

  _getRandomSymbol(strip) {
    return strip[Math.floor(Math.random() * strip.length)];
  }

  // Populates decorative idle reels before any real spin has happened, so the game never shows
  // a blank playfield on load - called once from CoreSlotEngine.init(). _ensureReels already
  // builds reels with 'idle' state/zero offset, matching SlotEngine.js's own eager setupReels()
  // call from its constructor-invoked init().
  showIdle(engine) {
    this._ensureReels(engine);
  }

  playEntrance(engine, step, onDone) {
    this._ensureReels(engine);

    const turbo = engine.turboMode;
    const spinStart = Date.now();
    const stopInterval = turbo ? 100 : this.reelDelay;
    const landDuration = turbo ? 150 : 450;
    const symbolHeight = engine.symbolHeight;
    const targetGrid = step.grid;

    this.reels.forEach((reel, r) => {
      reel.state = 'spinning';
      reel.speed = 20;
      const stopDelay = (turbo ? 500 : this.spinDuration) + (r * stopInterval);
      reel.landDuration = landDuration;
      // The reel is guaranteed fully landed by spinStart + stopDelay - landing itself begins
      // landDuration ms before that instant, so it always finishes exactly on time regardless
      // of frame rate or the acceleration constant below.
      reel.landStartTime = spinStart + stopDelay - landDuration;
    });

    const tick = () => {
      const now = Date.now();
      let allSettled = true;

      this.reels.forEach((reel, r) => {
        if (reel.state === 'spinning') {
          allSettled = false;

          // STOP uses the same landing and bounce stages as a normal spin. Move each reel's
          // scheduled landing to now and shorten only the landing duration, preserving the
          // visible deceleration rather than snapping directly to the result.
          if (engine._stopRequested) {
            reel.landStartTime = now;
            reel.landDuration = turbo ? 80 : 180;
          }

          const maxSpeed = turbo ? SPIN_SPEED_TURBO_MAX : SPIN_SPEED_NORMAL_MAX;
          if (reel.speed < maxSpeed) reel.speed += 3;
          reel.offsetY += reel.speed;

          if (reel.offsetY >= symbolHeight) {
            const shiftCount = Math.floor(reel.offsetY / symbolHeight);
            reel.offsetY = reel.offsetY % symbolHeight;
            for (let s = 0; s < shiftCount; s++) {
              reel.symbols.pop();
              reel.symbols.unshift(this._getRandomSymbol(reel.strip));
            }
          }

          if (now >= reel.landStartTime) {
            reel.symbols = [
              this._getRandomSymbol(reel.strip),
              targetGrid[r][0], targetGrid[r][1], targetGrid[r][2],
              this._getRandomSymbol(reel.strip),
              this._getRandomSymbol(reel.strip),
            ];
            reel.offsetY = symbolHeight;
            reel.speed = 0;
            reel.state = 'landing';
            reel.landElapsedStart = now;
          }
        } else if (reel.state === 'landing') {
          allSettled = false;

          const elapsed = now - reel.landElapsedStart;
          const progress = Math.min(elapsed / reel.landDuration, 1);
          reel.offsetY = symbolHeight * (1 - easeOutCubic(progress));

          if (progress >= 1) {
            reel.offsetY = 0;
            reel.state = 'bounce';
            reel.bounceProgress = 0;
            reel.bounceDirection = 1;
            engine.audioController?.onReelStop(r);
          }
        } else if (reel.state === 'bounce') {
          allSettled = false;

          const bounceMax = symbolHeight * 0.12;
          const speed = bounceMax / 4;
          if (reel.bounceDirection === 1) {
            reel.offsetY += speed;
            if (reel.offsetY >= bounceMax) reel.bounceDirection = -1;
          } else {
            reel.offsetY -= speed;
            if (reel.offsetY <= 0) {
              reel.offsetY = 0;
              reel.state = 'idle';
            }
          }
        }
      });

      if (allSettled) {
        onDone();
        return;
      }
      requestAnimationFrame(tick);
    };

    requestAnimationFrame(tick);
  }

  // Book-of-Dead-style expanding-wild reveal (bookbookbook only) - not part of the SpinAnimator
  // interface every animator implements (playEntrance/playTransition), called directly by
  // CoreSlotEngine.spin() only when a mechanic exposes evaluateExpandingWin and reports a win.
  // Ported from SlotEngine.js's own 'expanding' state handling in update(): reel columns expand
  // one at a time, each taking reelExpandDuration ms, staggered so column i+1 starts the instant
  // column i finishes. this.expansionReelsToAnimate/expansionReelStartTimes are exposed as
  // instance fields so SlotRenderer.drawExpandingAnimation can read the same per-column timing
  // for the aura/symbol-scale overlay while this tween is in progress.
  playExpandingReveal(engine, expandingSymbol, expandingReels, onDone) {
    const reelExpandDuration = 900;
    this.expansionReelsToAnimate = expandingReels;
    this.expansionReelStartTimes = [];
    let currentTime = Date.now();
    for (let i = 0; i < expandingReels.length; i++) {
      if (i > 0) currentTime += reelExpandDuration;
      this.expansionReelStartTimes[i] = currentTime;
    }

    const tick = () => {
      const now = Date.now();
      let allDone = true;

      for (let i = 0; i < expandingReels.length; i++) {
        const reelIdx = expandingReels[i];
        const elapsed = now - this.expansionReelStartTimes[i];
        const progress = Math.min(elapsed / reelExpandDuration, 1);
        if (progress < 1) {
          allDone = false;
        } else {
          // Fully expanded: bake the symbol into this reel's visible window so it stays shown
          // (by drawReelsSymbols, the normal path) once the overlay animation itself ends.
          const reel = this.reels[reelIdx];
          if (reel) {
            for (let row = 0; row < engine.config.rowsCount; row++) {
              reel.symbols[row + 1] = expandingSymbol;
            }
          }
        }
      }

      if (allDone) {
        this.expansionReelsToAnimate = null;
        onDone();
        return;
      }
      requestAnimationFrame(tick);
    };

    requestAnimationFrame(tick);
  }

  playTransition(engine, prevStep, nextStep, onDone) {
    onDone();
  }
}
