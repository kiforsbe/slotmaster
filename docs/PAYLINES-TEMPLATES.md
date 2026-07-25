# Existing paylines setups

## 3x3 playfield
```js
// Payline definitions - 3 reels x 3 rows: the three horizontal rows, plus the two true
// diagonals (not V-shapes - see docs/superpowers/specs design doc).
export const PAYLINES = [
  [1, 1, 1], // Line 1: Middle Row
  [2, 2, 2], // Line 2: Bottom Row
  [0, 0, 0], // Line 3: Top Row
  [2, 1, 0], // Line 4: Diagonal, bottom-left to upper-right
  [0, 1, 2], // Line 5: Diagonal, upper-left to bottom-right
];
```

## 5x3 playfield (variant 1)
```js
// Payline definitions - previously lived in core/SlotMath.js as a shared default;
// each game now owns its own paylines so the core stays grid-shape-agnostic.
const PAYLINES = [
  [1, 1, 1, 1, 1], // Line 1: Horizontal Middle Row
  [0, 0, 0, 0, 0], // Line 2: Horizontal Top Row
  [2, 2, 2, 2, 2], // Line 3: Horizontal Bottom Row
  [0, 1, 2, 1, 0], // Line 4: V-Shape
  [2, 1, 0, 1, 2], // Line 5: Inverted V-Shape
  [0, 0, 1, 2, 2], // Line 6: Step Down-Up
  [2, 2, 1, 0, 0], // Line 7: Step Up-Down
  [1, 2, 2, 2, 1], // Line 8: U-Shape Bottom
  [1, 0, 0, 0, 1], // Line 9: U-Shape Top
  [0, 1, 0, 1, 0]  // Line 10: Zigzag
];
```

## 5x4 playfield
```js
// Payline definitions - 5 reels x 4 rows, 20 fixed lines (a standard count for this grid
// size - not all-ways/megaways). Straight rows, then progressively deeper V/inverted-V,
// W/M, step, and zigzag shapes so the extra 4th row actually gets used, not just tacked on.
export const PAYLINES = [
  [0, 0, 0, 0, 0], // Line 1: Row 1 (Top)
  [1, 1, 1, 1, 1], // Line 2: Row 2 (Upper-Middle)
  [2, 2, 2, 2, 2], // Line 3: Row 3 (Lower-Middle)
  [3, 3, 3, 3, 3], // Line 4: Row 4 (Bottom)
  [0, 1, 3, 1, 0], // Line 5: Deep V (Top-Bottom-Top)
  [3, 2, 0, 2, 3], // Line 6: Deep Inverted V (Bottom-Top-Bottom)
  [1, 2, 3, 2, 1], // Line 7: Shallow V (Rows 2-4)
  [2, 1, 0, 1, 2], // Line 8: Shallow Inverted V (Rows 1-3)
  [0, 3, 0, 3, 0], // Line 9: W-Shape (Top/Bottom)
  [3, 0, 3, 0, 3], // Line 10: M-Shape (Bottom/Top)
  [1, 2, 1, 2, 1], // Line 11: W-Shape (Middle Rows)
  [2, 1, 2, 1, 2], // Line 12: M-Shape (Middle Rows)
  [0, 0, 1, 2, 3], // Line 13: Step Down (Top to Bottom)
  [3, 3, 2, 1, 0], // Line 14: Step Up (Bottom to Top)
  [0, 1, 1, 2, 3], // Line 15: Step Down, Delayed
  [3, 2, 2, 1, 0], // Line 16: Step Up, Delayed
  [0, 1, 0, 1, 0], // Line 17: Zigzag (Top Rows)
  [3, 2, 3, 2, 3], // Line 18: Zigzag (Bottom Rows)
  [0, 1, 2, 3, 3], // Line 19: Descending Run
  [3, 2, 1, 0, 0], // Line 20: Ascending Run
];
```