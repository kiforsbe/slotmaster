// Shared presentation and control layer for every playable slot game.
// Game coordinators keep ownership of maths, bonuses and status copy; this module owns the
// controls and the cabinet's responsive/fullscreen behavior.

function isReady(engine) {
  return engine && (engine.state === 'idle' || engine.state === 'showing_wins');
}

function roundMoney(value) {
  return Math.round(value * 100) / 100;
}

function getButton(id) {
  return typeof document === 'undefined' ? null : document.getElementById(id);
}

function addFullscreenButton() {
  const controls = document.querySelector('.top-controls');
  if (!controls || document.getElementById('btn-fullscreen')) return;

  const button = document.createElement('button');
  button.id = 'btn-fullscreen';
  button.className = 'btn-icon';
  button.type = 'button';
  button.textContent = '⛶ Fullscreen';
  controls.appendChild(button);

  const updateLabel = () => {
    button.textContent = document.fullscreenElement ? '⛶ Exit fullscreen' : '⛶ Fullscreen';
  };
  button.addEventListener('click', async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.querySelector('.cabinet-container')?.requestFullscreen?.();
    } catch (error) {
      // Embedded webviews can expose no fullscreen API. The responsive shell still works there.
      console.warn('SlotGameUI: fullscreen unavailable', error);
    }
    updateLabel();
  });
  document.addEventListener('fullscreenchange', updateLabel);
}

function addMusicButton(getEngine) {
  const soundButton = document.getElementById('btn-mute');
  if (!soundButton || document.getElementById('btn-music')) return;

  const button = document.createElement('button');
  button.id = 'btn-music';
  button.className = 'btn-icon';
  button.type = 'button';
  const initiallyMuted = getEngine()?.audio?.musicMuted ?? true;
  button.textContent = initiallyMuted ? '🎵 Music OFF' : '🎵 Music ON';
  button.classList.toggle('active', initiallyMuted);
  soundButton.insertAdjacentElement('afterend', button);
  button.addEventListener('click', () => {
    const audio = getEngine()?.audio;
    if (!audio?.toggleMusicMute) return;
    const muted = audio.toggleMusicMute();
    button.textContent = muted ? '🎵 Music OFF' : '🎵 Music ON';
    button.classList.toggle('active', muted);
  });
}

export function bindCommonSlotControls({ getEngine, onUpdate, betStep, betMax, linesMax }) {
  if (typeof document === 'undefined') return;
  const refs = {
    spin: getButton('btn-spin'),
    auto: getButton('btn-auto'),
    turbo: getButton('btn-turbo'),
    mute: getButton('btn-mute'),
    betMinus: getButton('bet-minus'),
    betPlus: getButton('bet-plus'),
    linesMinus: getButton('lines-minus'),
    linesPlus: getButton('lines-plus'),
  };

  const interrupt = (event) => {
    // Coordinators still contain legacy handlers for game-specific migration compatibility.
    // Registering this first makes this shared implementation authoritative.
    event.stopImmediatePropagation();
  };
  const update = () => onUpdate?.();
  const currentBet = (engine) => engine.betPerLine ?? engine.betAmount;
  const setBet = (engine, value) => {
    // CoreSlotEngine declares both fields for compatibility; the configured value is the
    // authoritative mode discriminator.
    if (engine.betAmount == null) {
      engine.betPerLine = value;
    } else {
      engine.betAmount = value;
    }
    engine.updateBet?.();
  };

  refs.spin?.addEventListener('click', (event) => {
    interrupt(event);
    const engine = getEngine();
    if (!engine) return;
    if (!isReady(engine)) engine.stopSpin();
    else engine.requestSpin();
  });

  refs.betMinus?.addEventListener('click', (event) => {
    interrupt(event);
    const engine = getEngine();
    if (!isReady(engine)) return;
    const value = roundMoney(currentBet(engine) - betStep);
    if (value >= betStep - 1e-9) setBet(engine, value), update();
  });

  refs.betPlus?.addEventListener('click', (event) => {
    interrupt(event);
    const engine = getEngine();
    if (!isReady(engine)) return;
    const value = roundMoney(currentBet(engine) + betStep);
    const lines = engine.linesCount || 1;
    if (value <= betMax + 1e-9 && engine.balance >= value * lines) setBet(engine, value), update();
  });

  const changeLines = (event, direction) => {
    interrupt(event);
    const engine = getEngine();
    if (!isReady(engine) || !engine.linesCount) return;
    const next = engine.linesCount + direction;
    const bet = currentBet(engine);
    if (next < 1 || next > linesMax || engine.balance < bet * next) return;
    engine.linesCount = next;
    engine.updateBet?.();
    update();
  };
  refs.linesMinus?.addEventListener('click', (event) => changeLines(event, -1));
  refs.linesPlus?.addEventListener('click', (event) => changeLines(event, 1));

  refs.auto?.addEventListener('click', (event) => {
    interrupt(event);
    const engine = getEngine();
    if (!engine) return;
    engine.autoPlay = !engine.autoPlay;
    refs.auto.classList.toggle('active', engine.autoPlay);
    if (engine.autoPlay && engine.state === 'idle') engine.spin();
  });

  refs.turbo?.addEventListener('click', (event) => {
    interrupt(event);
    const engine = getEngine();
    if (!engine) return;
    engine.turboMode = !engine.turboMode;
    refs.turbo.classList.toggle('active', engine.turboMode);
  });

  refs.mute?.addEventListener('click', (event) => {
    interrupt(event);
    const engine = getEngine();
    if (!engine?.audio) return;
    const muted = engine.audio.toggleMute();
    refs.mute.textContent = muted ? '🔇 Sound OFF' : '🔊 Sound ON';
    refs.mute.classList.toggle('active', muted);
  });

  addFullscreenButton();
  addMusicButton(getEngine);
}

export function observeSlotViewport() {
  if (typeof window === 'undefined') return;
  const cabinet = document.querySelector('.cabinet-container');
  if (!cabinet || !window.ResizeObserver) return;
  const updateScale = () => {
    const width = cabinet.clientWidth || window.innerWidth;
    const height = cabinet.clientHeight || window.innerHeight;
    cabinet.style.setProperty('--slot-scale', Math.max(0.55, Math.min(1.25, Math.min(width / 960, height / 740))).toFixed(3));
  };
  new ResizeObserver(updateScale).observe(cabinet);
  updateScale();
}

// Shared state-to-HUD adapter. Games provide only their theme-specific status copy and any
// bonus-round completion callback; spin button behavior and common state transitions live here.
export function updateSlotStateUI({ engine, state, refs, onUpdate, messages = {}, onGameOver }) {
  if (!engine || !refs) return;
  onUpdate?.();

  const spinning = state === 'spinning' || state === 'stopping' || state === 'dropping_in' || state === 'falling';
  if (spinning) {
    refs.spin.textContent = 'STOP';
    refs.spin.className = 'btn-spin spinning';
  } else {
    refs.spin.textContent = 'SPIN';
    refs.spin.className = 'btn-spin';
  }

  const message = typeof messages[state] === 'function' ? messages[state](engine) : messages[state];
  if (message) refs.ticker.textContent = message;
  if (state === 'game_over') onGameOver?.();
}
