import test from 'node:test';
import assert from 'node:assert/strict';
import { audio } from '../core/audio/SlotAudio.js';

// No real AudioContext/Audio element exists in Node, so init()/_playMusicTrack() short-circuit
// (same guard every other SlotAudio method already relies on for these tests to run headless).
// These tests only cover the state bookkeeping that doesn't depend on actual playback.

test('setMusicTracks/setMusicState track the requested state without throwing', () => {
  audio.setMusicTracks({ main: 'main.mp3', freespins: 'freespins.mp3' });
  audio.setMusicState('main');
  assert.equal(audio.musicState, 'main');

  audio.setMusicState('freespins');
  assert.equal(audio.musicState, 'freespins');
});

test('setMusicState is a no-op when the requested state has no configured track', () => {
  audio.setMusicTracks({ main: 'main.mp3' });
  audio.setMusicState('main');
  const before = audio.currentMusicUrl;

  audio.setMusicState('bonus'); // not configured
  assert.equal(audio.musicState, 'bonus');
  assert.equal(audio.currentMusicUrl, before);
});

test('setMusicTracks defaults to an empty map when called with nothing', () => {
  audio.setMusicTracks();
  assert.deepEqual(audio.musicTracks, {});
});

test('setDuckingConfig(false) disables ducking; true/undefined/object enable it with the right values', () => {
  audio.setDuckingConfig(false);
  assert.equal(audio.duckingEnabled, false);

  audio.setDuckingConfig(true);
  assert.equal(audio.duckingEnabled, true);
  assert.equal(audio.duckAmount, 0.35);
  assert.equal(audio.duckAttack, 0.05);
  assert.equal(audio.duckRelease, 0.4);

  audio.setDuckingConfig({ amount: 0.5 });
  assert.equal(audio.duckingEnabled, true);
  assert.equal(audio.duckAmount, 0.5);
  // Unspecified fields still fall back to the built-in defaults, not the previous call's values.
  assert.equal(audio.duckAttack, 0.05);
  assert.equal(audio.duckRelease, 0.4);

  audio.setDuckingConfig(undefined);
  assert.equal(audio.duckingEnabled, true);
  assert.equal(audio.duckAmount, 0.35);
});

test('setCompressionConfig(false) disables compression; true/undefined/object enable it with the right values', () => {
  audio.setCompressionConfig(false);
  assert.equal(audio.compressionEnabled, false);

  audio.setCompressionConfig(true);
  assert.equal(audio.compressionEnabled, true);
  assert.deepEqual(audio.compressionSettings, { threshold: -24, knee: 30, ratio: 12, attack: 0.003, release: 0.25 });

  audio.setCompressionConfig({ ratio: 6 });
  assert.equal(audio.compressionEnabled, true);
  assert.equal(audio.compressionSettings.ratio, 6);
  // Unspecified fields still fall back to the built-in defaults, not the previous call's values.
  assert.equal(audio.compressionSettings.threshold, -24);
});
