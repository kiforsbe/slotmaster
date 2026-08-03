// Resolves which sprite tile to draw for a grid cell that might be part of a tall "stacked"
// symbol (Beach Party's surfer colors: several consecutive tiles of one plain symbol name, e.g.
// "surfer_yellow" x5 in a column, drawn as one continuous piece of art via per-row variant
// tiles "surfer_yellow_1".."surfer_yellow_5" instead of the same square tile repeated). Generic
// and config-driven - a game that never sets `stackedSymbols` always gets the plain symbol name
// back, so this is a no-op for every existing game.
//
// "Full stack" means the entire visible column is one stacked-eligible symbol - a run shorter
// than the column height (standalone or partially stacked) always renders as the plain tile,
// per the game's own brief: shorter stacks look like ordinary repeated symbols, not partial art.
//
// @param {string[]} gridColumn - one reel's visible symbols, top to bottom.
// @param {number} row - which row in gridColumn to resolve a tile name for.
// @param {Object<string, string[]>|undefined} stackedSymbols - base symbol name -> ordered
//   variant tile names (index 0 = topmost row of the stack).
// @returns {string} the tile name to draw - either a variant tile or the plain symbol name.
export function resolveStackedSymbolTileName(gridColumn, row, stackedSymbols) {
  const symbol = gridColumn[row];
  const variants = stackedSymbols?.[symbol];
  if (!variants || variants.length === 0) return symbol;
  if (gridColumn.length < variants.length) return symbol;
  if (!gridColumn.every(cell => cell === symbol)) return symbol;
  return row < variants.length ? variants[row] : symbol;
}
