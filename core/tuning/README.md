# Tuning package

The tuning pipeline never changes a live game. It returns candidate reel tables, measurements,
and diagnostics so a developer can decide what to ship.

- `FrequencyTuner.js` orchestrates validation, baseline diagnosis, structural sensitivity,
  frequency search and optional payout scaling.
- `Optimizers.js` contains the reusable one- and multi-dimensional numerical searches; `CMAES.js`
  is the population optimizer.
- `Payouts.js` owns frequency projection helpers, payout scaling and statistically meaningful
  incumbent acceptance.
- `Validation.js`, `StructuralSensitivity.js`, `StructuralSearch.js`, `Units.js`,
  `PlayerExperience.js` and `TuneLog.js` are independent pure support modules.

Every candidate is measured with deterministic trial seeds. Its standard error comes from
independent trial means—not individual spins—so free-spin and cascade correlations are not
mistaken for extra sample size.
