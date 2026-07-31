# Simulation package

`SpinSimulator.js` executes a batch of base/free spins through a game mechanic. It owns only
outcome aggregation; it does not tune reels or manipulate the developer UI.

- `RoundStatistics.js` retains bounded, mergeable round shape data instead of every round.
- `TrialMeasurement.js` allocates deterministic independent seeds, combines trial means and
  standard errors, and turns off per-win collections for tuning candidates.
- `SimulationWorkerPool.js` and `trialWorker.js` run serializable trials off the UI thread. The
  pool is bounded to eight workers and releases every queued promise when terminated.

Use `config.collectDetailedWins` and `config.collectWinDistribution` only for developer reports;
they default to `true` for backward-compatible full simulations.
