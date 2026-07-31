import test from 'node:test';
import assert from 'node:assert/strict';
import { AssetLoader, SpriteAnimation, SpriteAnimationPlayback, asAnimation } from '../core/assets/AssetLoader.js';
import { drawSpriteSymbol } from '../core/rendering/SpriteDrawer.js';

function fakeFetch(payload) {
  return async () => ({ ok: true, json: async () => payload });
}

test('AssetLoader loads images, sounds, music, and JSON descriptors generically', async () => {
  const calls = [];
  const loader = new AssetLoader({
    fetchImpl: fakeFetch({ value: 7 }),
    imageLoader: async url => ({ url }),
    audioLoader: async (url, kind) => ({ url, kind }),
  });
  const assets = await loader.loadAll({
    image: 'art.png', sound: 'hit.ogg', music: { url: 'theme.mp3', type: 'music' }, json: 'data.json',
  });
  assert.deepEqual(assets.image.image, { url: 'art.png' });
  assert.deepEqual(assets.sound.audio, { url: 'hit.ogg', kind: 'sound' });
  assert.deepEqual(assets.music.audio, { url: 'theme.mp3', kind: 'music' });
  assert.deepEqual(assets.json.data, { value: 7 });
  assert.equal(calls.length, 0);
});

test('AssetLoader binds the platform fetch receiver', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = function (url) {
    assert.equal(this, globalThis);
    return Promise.resolve({ ok: true, json: async () => ({ url }) });
  };
  try {
    const asset = await new AssetLoader().load('data.json');
    assert.equal(asset.data.url, 'data.json');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('tilemap descriptors become named one-frame animations and load their sheet', async () => {
  const loader = new AssetLoader({
    fetchImpl: fakeFetch({ sheet: 'mayan.png', tiles: [{ name: 'gold', x: 1, y: 2, w: 3, h: 4 }] }),
    imageLoader: async url => ({ url }),
  });
  const asset = await loader.load('games/mayantumble/assets/mayan/mayan.tiles.json');
  assert.equal(asset.type, 'tilemap');
  assert.ok(asset.tiles.gold instanceof SpriteAnimation);
  assert.deepEqual(asset.tiles.gold.frameAt(), { x: 1, y: 2, w: 3, h: 4, name: 'gold' });
  assert.match(asset.sheetUrl, /mayan\.png$/);
});

test('asset URLs preserve VS Code integrated-browser Windows file paths', async () => {
  const originalDocument = globalThis.document;
  globalThis.document = { baseURI: 'file:///c%3A/Users/test/game/index.html' };
  try {
    const loader = new AssetLoader({
      fetchImpl: fakeFetch({ sheet: './sprites/sheet.png', tiles: [] }),
      imageLoader: async url => ({ url }),
    });
    const asset = await loader.load('./assets/theme/theme.tiles.json', 'tilemap');
    assert.equal(asset.sheetUrl, './assets/theme/./sprites/sheet.png');
  } finally {
    globalThis.document = originalDocument;
  }
});

test('sprite descriptors preserve named frames and animation frame timing', async () => {
  const loader = new AssetLoader({
    fetchImpl: fakeFetch({
      sheet: 'stone.png', frames: [{ name: 'a', x: 0, y: 0, w: 8, h: 8 }],
      animations: [{ name: 'explode', loop: true, frames: [{ frame: 'a', duration: 100 }] }],
    }),
    imageLoader: async url => ({ url }),
  });
  const asset = await loader.load('sprites/stone.json');
  assert.equal(asset.animations.explode.frames[0].tile.name, 'a');
  assert.equal(asset.animations.explode.frames[0].duration, 100);
});

test('renderer accepts a tile as a single-frame animation', () => {
  const calls = [];
  const ctx = { save() {}, restore() {}, drawImage(...args) { calls.push(args); } };
  drawSpriteSymbol(ctx, {}, asAnimation({ x: 4, y: 5, w: 6, h: 7 }), 1, 2, 8, 9);
  assert.deepEqual(calls[0].slice(1), [4, 5, 6, 7, 1, 2, 8, 9]);
});

test('renderer honors descriptor frame durations from an animation start time', () => {
  const calls = [];
  const ctx = { save() {}, restore() {}, drawImage(...args) { calls.push(args); } };
  const originalNow = Date.now;
  Date.now = () => 150;
  try {
    drawSpriteSymbol(ctx, {}, {
      startTime: 0,
      frames: [
        { duration: 100, tile: { x: 1, y: 0, w: 8, h: 8 } },
        { duration: 200, tile: { x: 9, y: 0, w: 8, h: 8 } },
      ],
    }, 0, 0, 8, 8);
  } finally {
    Date.now = originalNow;
  }
  assert.equal(calls[0][1], 9, '150ms should still be in the second 200ms frame');
});

test('sprite assets expose native playback instances with authored timing', () => {
  const definition = new SpriteAnimation({ loop: false, frames: [
    { duration: 100, tile: { name: 'first' } },
    { duration: 200, tile: { name: 'last' } },
  ] });
  const playback = definition.play(0);
  assert.ok(playback instanceof SpriteAnimationPlayback);
  assert.equal(definition.startTime, undefined, 'the shared definition has no playback state');
  assert.equal(playback.frameAt(50).name, 'first');
  assert.equal(playback.frameAt(150).name, 'last');
  assert.equal(playback.frameAt(999).name, 'last');
});
