// Generic browser asset loading for games. JSON descriptors may reference a sprite sheet
// through their `sheet` property; tilemap tiles are exposed as one-frame animations and sprite
// descriptors retain their named frames/animations.

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg']);
const AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac']);

function extensionOf(url) {
  return String(url).split(/[?#]/)[0].split('.').pop().toLowerCase();
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    if (typeof Image === 'undefined') return resolve({ src: url, complete: true });
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Failed to load image: ${url}`));
    image.src = url;
  });
}

async function loadAudio(url, kind, fetchImpl) {
  if (typeof Audio === 'undefined') return Promise.resolve({ src: url, kind });
  const audio = new Audio();
  audio.preload = kind === 'music' ? 'auto' : 'metadata';
  // Resolve relative manifest paths against the page, not against the module URL. This keeps
  // audio loading correct when a game is served from a nested route such as /games/bookbookbook/.
  let sourceUrl = resolveAssetUrl(url);
  const base = typeof document !== 'undefined' ? document.baseURI : '';
  if (base.startsWith('file:') && fetchImpl && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
    try {
      // VS Code can expose files to fetch(), while its media element rejects file:/// URLs.
      // A blob URL bridges those two behaviors without changing HTTP-served games.
      const response = await fetchImpl(url);
      if (response.ok !== false) sourceUrl = URL.createObjectURL(await response.blob());
    } catch {
      // Keep the original source as a fallback; playback will report a useful error if needed.
    }
  }
  audio.src = sourceUrl;
  // Audio decoding is browser/device dependent and can legitimately fail without preventing the
  // game from starting (autoplay policy, unsupported codec, or a transient network issue). The
  // element itself is the asset; SlotAudio handles playback failures when it actually plays it.
  audio.load?.();
  return Promise.resolve(audio);
}

function descriptorType(data) {
  return Array.isArray(data?.tiles) ? 'tilemap' : Array.isArray(data?.frames) ? 'sprite' : 'json';
}

function resolveAssetUrl(url, baseUrl) {
  const base = baseUrl || (typeof document !== 'undefined' ? document.baseURI : globalThis.location?.href);
  if (!base) return url;
  // VS Code's integrated browser can serve relative file assets, but rejects the equivalent
  // absolute file:///... media URL. Keep relative paths relative in that environment and let
  // the webview resolve them itself.
  if (base.startsWith('file:') && !/^[a-z][a-z0-9+.-]*:/i.test(url)) return url;
  // VS Code's integrated browser can expose Windows file URLs as file:///c%3A/...; decode the
  // drive-colon before URL resolution so relative assets keep their normal file path.
  const normalizedBase = base.replace(/^(file:\/\/\/[^/]+)%3A/i, '$1:');
  try { return new URL(url, normalizedBase).href; }
  catch { return url; }
}

function withSheetUrl(url, sheet) {
  const base = typeof document !== 'undefined' ? document.baseURI : globalThis.location?.href;
  if (base?.startsWith('file:') && !/^[a-z][a-z0-9+.-]*:/i.test(url) && !/^[a-z][a-z0-9+.-]*:/i.test(sheet)) {
    const directory = url.slice(0, url.lastIndexOf('/') + 1);
    return `${directory}${sheet}`;
  }
  return resolveAssetUrl(sheet, resolveAssetUrl(url));
}

export function asAnimation(tile) {
  if (!tile) return tile;
  if (Array.isArray(tile.frames)) return tile;
  return { frames: [tile], loop: false, duration: 0 };
}

export class AssetLoader {
  constructor({ fetchImpl, imageLoader = loadImage, audioLoader = loadAudio } = {}) {
    // Browsers require fetch to be called with window as its receiver. Keep injected fetchers
    // untouched for tests/custom runtimes, but bind the platform implementation once here.
    this.fetchImpl = fetchImpl ?? globalThis.fetch?.bind(globalThis);
    this.imageLoader = imageLoader;
    this.audioLoader = audioLoader;
  }

  async load(url, type) {
    const inferred = type || (IMAGE_EXTENSIONS.has(extensionOf(url)) ? 'image'
      : AUDIO_EXTENSIONS.has(extensionOf(url)) ? 'sound' : 'json');
    if (inferred === 'image') return { type: 'image', url, image: await this.imageLoader(url) };
    if (inferred === 'sound' || inferred === 'music') {
      return { type: inferred, url, audio: await this.audioLoader(url, inferred, this.fetchImpl) };
    }

    const response = await this.fetchImpl(url);
    if (!response.ok && response.ok !== undefined) throw new Error(`Failed to load asset: ${url}`);
    const data = await response.json();
    const descriptor = descriptorType(data);
    if (descriptor === 'json') return { type, url, data };

    const sheetUrl = withSheetUrl(url, data.sheet);
    const sheet = await this.imageLoader(sheetUrl);
    if (descriptor === 'tilemap') {
      const tiles = Object.fromEntries(data.tiles.map(tile => [tile.name, asAnimation({
        x: tile.x, y: tile.y, w: tile.w, h: tile.h, name: tile.name,
      })]));
      return { type: 'tilemap', url, sheetUrl, image: sheet, tiles, data };
    }
    const frames = Object.fromEntries(data.frames.map(frame => [frame.name, frame]));
    const animations = Object.fromEntries((data.animations || []).map(animation => [animation.name, {
      ...animation,
      frames: animation.frames.map(frame => ({ ...frame, tile: frames[frame.frame] })),
    }]));
    return { type: 'sprite', url, sheetUrl, image: sheet, frames, animations, data };
  }

  async loadAll(manifest) {
    const entries = Object.entries(manifest || {});
    const loaded = await Promise.all(entries.map(async ([name, spec]) => {
      const value = typeof spec === 'string' ? await this.load(spec) : await this.load(spec.url, spec.type);
      return [name, value];
    }));
    return Object.fromEntries(loaded);
  }
}
