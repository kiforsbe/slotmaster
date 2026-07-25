# slotmaster

Browser-based slot machine games. Plain ES modules, no build step, no bundler —
open `index.html` (via a local server, see below) and play.

## Running it

ES modules need to be served over HTTP (`file://` won't work). On Windows:

```powershell
./serve.ps1
```

This starts a static server (`npx serve`) on a random free port and prints the
URL to open.

## Running the tests

```bash
npm test
```

Runs every `tests/*.mjs` file under Node's built-in test runner. No browser
required — the math/simulation modules are plain functions, tested directly.

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the `core/` module API reference and how
a new game hooks into it.

## Project layout

```
core/    Shared engine code, used by every game
games/   One folder per game (game.js, index.html, game.css)
tests/   node --test suite for core/
docs/    Design specs and implementation plans (docs/superpowers/)
```

- **`core/SlotEngine.js`** — rendering/animation and input handling for the live game.
- **`core/SlotMath.js`** — pure math: building reel strips (`generateReel`), evaluating
  spins (`checkWildLineWins`, `checkWins`).
- **`core/SpinSimulator.js`** — runs many simulated spins to measure RTP/trigger rate, and
  `tuneFrequencies`, which automatically adjusts a game's reel frequencies to hit a target RTP.
- **`core/SimulationPanel.js`** — the in-browser RUN SIMULATION / TUNE FREQUENCIES UI (a debug
  panel included in each game's `index.html`), plus the formatter that turns a tuned result
  back into pasteable `FREQUENCY_REELn` source.
- **`core/SlotAudio.js`** — sound effects.

Each game (`games/<name>/game.js`) owns its own `PAYTABLE`, paylines, and per-reel frequency
tables, and wires them into the shared `core/` modules. See each game's own README for its
specific mechanics.

## Reel frequency tables

Every game defines one frequency table per reel (`FREQUENCY_REEL1`, `FREQUENCY_REEL2`, ...),
passed to `generateReel` (`core/SlotMath.js`) to build that reel's physical strip. All tables
share one shape:

```js
export const FREQUENCY_REEL1 = {
  defaults: { minGap: 2 },       // optional reel-wide fallback constraints
  symbols: {
    bar: { frequency: 24.5 },
    star: { frequency: 6.3, min: 2, max: 6, maxStack: 1, minGap: 3 },
  },
};
```

`frequency` is the only required field — everything else is optional and defaults to "no
constraint." A table with no `.symbols` key (a bare `{ symbol: { frequency } }` map) is also
accepted as a legacy flat shape; it just can't express reel-level `defaults`.

**`minGap`** — minimum circular distance enforced between two occurrences of the *same*
symbol on the built strip (self-spacing only, not relative to other symbols). Resolved as:
per-symbol `minGap` → this reel's `defaults.minGap` → built-in fallback. The built-in fallback
is `1` (unconstrained) for a normal symbol, but `3` for any symbol with
`PAYTABLE[symbol].triggerFreeSpins === true` (the free-spins scatter) — so a scatter symbol
gets sensible spacing automatically, without a game needing to configure it. That `3` is
itself just `generateReel`'s `defaultTriggerMinGap` parameter, overridable per call.

**`maxStack`** — maximum run length of consecutive identical occurrences of that symbol
allowed on the built strip (also circular — a run can wrap from the end of the strip back to
the start). Resolved the same way: per-symbol `maxStack` → this reel's `defaults.maxStack` →
built-in fallback of `Infinity` (unconstrained). There's no free-spins-aware default for this
one — a game opts in explicitly per symbol or per reel.

Both constraints are best-effort: if a reel is too dense to fully satisfy one (e.g. asking for
`minGap: 10` when a symbol appears 50 times on a 100-long strip), `generateReel` gets as close
as it can rather than throwing or looping forever.

**`fixed: true`** on a symbol excludes it from `tuneFrequencies`' automatic search on that
reel — its frequency is left exactly as written. Used for symbols whose frequency shouldn't be
touched by auto-tuning (e.g. a wild that's deliberately rare).

**`min`/`max`** on a symbol are soft bounds `tuneFrequencies` tries to keep that symbol's
tuned frequency within, on that reel — a discouraged-but-not-forbidden preference, not a hard
clamp.

### `triggerFreeSpins`, not `type: 'scatter'`

Whether a symbol triggers free spins is read from `PAYTABLE[symbol].triggerFreeSpins === true`
— not from `PAYTABLE[symbol].type`. This is what drives both the `minGap` default above and
`tuneFrequencies`' free-spins-trigger-rate tuning phase. `type: 'scatter'` still exists as a
paytable field, but it's now only about win evaluation (see `paymode` below) — a symbol can be
`triggerFreeSpins: true` without being `type: 'scatter'`, or vice versa.

### `paymode` default

A paytable symbol's `paymode` controls whether it pays per active payline (`'line'`) or
independent of lines (`'any'`, e.g. scatter pays). If omitted, it defaults to `'any'` for a
symbol with `type: 'scatter'`, and `'line'` for everything else — so most symbols never need
to write it explicitly, only a symbol that wants to override that default.

### Tuning: `orderingBiasByReel`

`tuneFrequencies` (`core/SpinSimulator.js`) always defaults to `-1` for every reel unless
`orderingBiasByReel` is passed explicitly — i.e. "a higher-paying symbol should not be more
frequent than a lower-paying one," same as before this option existed. The TUNE FREQUENCIES
panel (`core/SimulationPanel.js`) pre-selects a different value per reel in its UI dropdowns
only (early reels default to `1`, middle reels to `-1`, late reels to `0`) as a starting point
for a "near miss" feel — premium symbols showing up often on the reels a player sees land, but
rarely on the ones that would complete the line. That's a UI convenience, not a change to
`tuneFrequencies`' own default; calling it directly without `orderingBiasByReel` still behaves
exactly as before.
