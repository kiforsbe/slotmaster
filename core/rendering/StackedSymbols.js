// Resolves which sprite tile to draw for a grid cell that might be part of a tall "stacked"
// symbol (Beach Party's surfer colors: several consecutive tiles of one plain symbol name, e.g.
// "surfer_yellow" x5 in a column, drawn as one continuous piece of art via per-row variant
// tiles "surfer_yellow_1".."surfer_yellow_5" instead of the same square tile repeated). Generic
// and config-driven - a game that never sets `stackedSymbols` always gets the plain symbol name
// back, so this is a no-op for every existing game.
//
// "Full stack" means the true run on the reel strip is exactly `variants.length` long - not
// just the visible column. A shorter run (standalone or partially stacked, and genuinely not a
// full-height cluster) always renders as the plain tile, per the game's own brief: shorter
// stacks look like ordinary repeated symbols, not partial art. But a full-height run that's
// scrolled so part of it sits above/below the visible reel (e.g. the reel stopped with only the
// bottom 3 of a 5-tall stack on screen) still counts as a full stack - it renders with the
// correct variant tiles for its true position in the run, letting the caller's own clip region
// crop the rest naturally, rather than falling back to plain tiles just because the window
// doesn't happen to contain the whole thing.
//
// @param {string[]} gridColumn - one reel's visible symbols, top to bottom.
// @param {number} row - which row in gridColumn to resolve a tile name for.
// @param {Object<string, string[]>|undefined} stackedSymbols - base symbol name -> ordered
//   variant tile names (index 0 = topmost row of the stack).
// @param {string[]} [strip] - the reel's full symbol strip (circular). When omitted, falls back
//   to the old whole-visible-column rule (used for forced/debug grids, which have no strip
//   position to look up).
// @param {number} [stopIndex] - the strip position `gridColumn[0]` was read from, i.e.
//   `strip[stopIndex] === gridColumn[0]`. Required alongside `strip` to look at neighbors.
// @returns {string} the tile name to draw - either a variant tile or the plain symbol name.
export function resolveStackedSymbolTileName(gridColumn, row, stackedSymbols, strip, stopIndex) {
  const symbol = gridColumn[row];
  const variants = stackedSymbols?.[symbol];
  if (!variants || variants.length === 0) return symbol;

  if (!strip || strip.length === 0 || stopIndex == null) {
    if (gridColumn.length < variants.length) return symbol;
    if (!gridColumn.every(cell => cell === symbol)) return symbol;
    return row < variants.length ? variants[row] : symbol;
  }

  const stripLen = strip.length;
  const at = (pos) => strip[((pos % stripLen) + stripLen) % stripLen];
  const centerPos = stopIndex + row;

  let runStart = centerPos;
  while (centerPos - (runStart - 1) < variants.length && at(runStart - 1) === symbol) runStart--;
  let runEnd = centerPos;
  while ((runEnd + 1) - centerPos < variants.length && at(runEnd + 1) === symbol) runEnd++;

  if (runEnd - runStart + 1 !== variants.length) return symbol;
  return variants[centerPos - runStart];
}
