# Design: Per-Game Background Music, Ducking, and Compression

Date: 2026-07-28

## Problem

`core/audio/SlotAudio.js` currently has no way to play a game's actual theme
music. The only "BGM" it knows about is a synthesized loop (`startBGM()` /
`stopBGM()`) that plays a hardcoded melody during free spins only. Meanwhile,
each shipped game already has a real theme track checked in under
`games/<name>/assets/music/`. There's also no shared mastering stage: every
sound effect connects straight to `ctx.destination`, so effects and (in the
future) music never gain-stage against each other, and there's no ducking to
keep effects audible over music, or a compressor to keep overall levels
consistent.

## Goals

1. Let each game configure real background-music tracks per game state,
   through `CoreSlotEngine` config — modular enough to support more states
   later, not hardcoded to "free spins only."
2. If a game doesn't configure music (or a given state has no track), no
   music plays for it — a game that sets nothing behaves exactly as today.
3. Basic ducking: sound effects should audibly poke through the music bed
   without the user manually balancing levels.
4. Basic compression: one shared compressor stage keeps output levels
   consistent across synthesized effects and file-based music.
5. Replace the old synthesized `startBGM()`/`stopBGM()` free-spins loop — it
   served the same purpose this feature now covers properly.

## Non-goals

- No per-sound or per-game volume sliders/UI — out of scope, unrelated to
  this feature.
- No crossfade between tracks — hard cut is fine (confirmed with user).
- No fallback-to-main-track logic when a state has no configured track —
  the current track simply keeps playing, uninterrupted (confirmed with
  user).
- Not building out a `freespins` track for any game today — none of the 5
  playable games have one yet. The config shape supports it; only `main` is
  wired for now.

## Config Shape

`CoreSlotEngine`'s config gains an optional `music` field, keyed by game
state name:

```js
music: {
  main: './assets/music/bookbookbook_theme.mp3',
  // freespins: './assets/music/bookbookbook_freespins.mp3', // not yet authored for any game
}
```

Any state key may be omitted. Omitting the whole `music` field means the
engine never touches the music subsystem at all.

## CoreSlotEngine Changes

- Constructor: `this.musicConfig = config.music || null;`
- `init()`: if `this.musicConfig`, call `this.audio.setMusicTracks(this.musicConfig)`
  then `this.audio.setMusicState('main')`.
- `enterFreeSpins()`: call `this.audio.setMusicState('freespins')` (no-op if
  no `freespins` track is configured — current track keeps playing).
- `exitFreeSpins()`: call `this.audio.setMusicState('main')`.
- Remove the existing `this.audio.startBGM()` / `this.audio.stopBGM()` calls
  in these two methods.

## SlotAudio Changes

### Master signal graph

Today, every sound connects a per-note `GainNode` directly to
`ctx.destination`. This changes to a shared bus + single compressor:

```
[per-effect gain nodes] ---> masterBus (GainNode) --\
                                                       +--> compressor (DynamicsCompressorNode) --> ctx.destination
[musicGain (GainNode)]  -----------------------------/
```

- `masterBus`: plain unity-gain `GainNode`, created once in `init()`. Every
  existing `gain.connect(this.ctx.destination)` call site in the file is
  repointed to `masterBus` instead.
- `compressor`: one `DynamicsCompressorNode`, created once in `init()`,
  standard "glue" settings: threshold −24dB, knee 30, ratio 12:1, attack
  0.003s, release 0.25s. `masterBus` and `musicGain` both connect into it;
  it connects to `ctx.destination`.

### Music playback

New state:
- `this.musicTracks = {}` — state name → URL.
- `this.musicState = 'main'` — current desired state.
- `this.musicEl` — the live `HTMLAudioElement`, or `null`.
- `this.musicSource` — its `MediaElementAudioSourceNode`, or `null`.
- `this.musicGain` — `GainNode` created in `init()`, feeds `compressor`,
  base level `this.globalVolume * 0.5`.
- `this.currentMusicUrl` — URL of the track currently loaded, or `null`.

New methods:
- `setMusicTracks(tracks)`: stores `tracks` (or `{}`).
- `setMusicState(state)`: sets `this.musicState`; looks up
  `this.musicTracks[state]`. If there's no URL, return (current track keeps
  playing). If the URL is already the one loaded, return (no restart). Else
  hard-cut to the new track via `_playMusicTrack(url)`.
- `_playMusicTrack(url)`: calls `init()`; stops/disconnects any existing
  music element+source; creates `new Audio(url)` with `loop = true`;
  wraps it with `createMediaElementSource` → `musicGain`; stores
  `currentMusicUrl`; attempts `el.play()` (swallow rejection — autoplay
  policy may block it before the first user gesture; `resume()` retries).
- `_stopMusic()`: pauses and tears down `musicEl`/`musicSource`, clears
  `currentMusicUrl`. (Only called internally by `_playMusicTrack`; there's
  no public "stop music" entry point since games don't need one today.)

### Autoplay-policy integration

`resume()` already runs at the top of every `play*` method to unlock a
suspended `AudioContext` on first user gesture. It gains one more line: if
`this.musicEl` exists, is paused, and `!this.isMuted`, call `.play()` again
(swallow rejection). This means music reliably starts the first time any
game sound plays, with no extra wiring per game.

### Mute integration

`setMute(mute)`: when muting, also `this.musicEl?.pause()`. When unmuting,
also `this.musicEl?.play().catch(() => {})`.

### Ducking

New method:

```js
_duckMusic() {
  if (!this.musicGain || !this.ctx || this.isMuted) return;
  const now = this.ctx.currentTime;
  const base = this.globalVolume * 0.5; // matches musicGain's base level
  const duckedLevel = base * 0.35;
  const attack = 0.05;
  const release = 0.4;
  this.musicGain.gain.cancelScheduledValues(now);
  this.musicGain.gain.setValueAtTime(this.musicGain.gain.value, now);
  this.musicGain.gain.linearRampToValueAtTime(duckedLevel, now + attack);
  this.musicGain.gain.linearRampToValueAtTime(base, now + attack + release);
}
```

Called at the top of every public `play*` method that produces a
player-audible effect: `playSpin`, `playReelStop`, `playWin`,
`playClusterWin`, `playScatterTrigger`, `playExpand`. (Internal helpers like
`_playBellTone` and `playBigWinSubBass`, which those methods call
themselves, do not duck again — avoids double-ducking a single effect.)
Overlapping effects simply re-trigger the ramp (cancel + restart), which
naturally extends the duck for as long as effects keep firing — no explicit
stacking/reference-counting needed.

### Removed

`startBGM()`, `stopBGM()`, and the `bgmNode` / `bgmGain` / `bgmInterval` /
`bgmScheduler` fields are deleted entirely.

## Game Wiring

Add one `music: { main: '...' }` entry to each of the 5 playable games'
`CoreSlotEngine` config blocks, pointing at their existing theme file:

| Game | Track |
|---|---|
| barfruits | `./assets/music/barfruits_theme.mp3` |
| bookbookbook | `./assets/music/bookbookbook_theme.mp3` |
| candyfrenzy | `./assets/music/candyfrenzy_theme.mp3` |
| fruitmachine | `./assets/music/fruitmachine_theme.mp3` |
| mayantumble | `./assets/music/mayan_tumble_theme.mp3` |

(`sugarhigh`, `lemonpop`, `soulfunk` have music assets checked in but no
`game.js` yet — not wired, nothing to wire it into.)

## Testing

No existing automated test suite covers `SlotAudio.js` (it's browser-only,
Web-Audio-API-dependent code with no jsdom audio shims in this repo). Manual
verification: load a game, confirm music starts after first spin, confirm
it survives mute/unmute, confirm effects audibly duck the music bed, confirm
entering/exiting free spins doesn't glitch since no `freespins` track exists
yet (should just keep playing `main` uninterrupted).
