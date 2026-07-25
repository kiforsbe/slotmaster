# Tuning Search Robustness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `tuneFrequencies`' Phase 2 search (the RTP/ordering/limits Nelder-Mead simplex
in `core/SpinSimulator.js`) detect when it has stalled and escape - by retrying wider and
under a different search seed, or by giving up early once retrying clearly isn't helping -
instead of silently grinding through its full iteration budget on a target that was never
reachable, and surface exactly why it stopped in both the returned diagnostics and the TUNE
FREQUENCIES UI.

**Architecture:** Replace Phase 2's single `nelderMead()` call with a loop that runs it in
short rounds, tracking three independent "still improving?" signals (RTP error, total
ordering-violation amount, total limit-violation amount). A round that improves none of the
three is a stall: the next round restarts from the best point found so far, with a wider
initial step and a shifted search seed. `nelderMead()` itself is not modified. New diagnostic
fields (`reason`, `restarts`, `rtpRange`, etc.) explain what happened; `SimulationPanel.js`'s
existing "not converged" UI block branches on `reason` instead of a single boolean.

**Tech Stack:** Plain ES modules, `node --test` for the test suite. No new dependencies.

## Global Constraints

- `npm test` (`node --test tests/*.mjs`) must stay green after every task.
- `nelderMead()`'s own signature and behavior are not touched (per the design's non-goals -
  see `docs/superpowers/specs/2026-07-25-tuning-search-robustness-design.md`).
- The existing `diagnostics.rtpPhase.converged` field's meaning (`error <= rtpTolerancePct`)
  does not change - anything already reading it keeps working.
- `tuneFrequencies` must remain fully deterministic: identical options must always produce
  byte-identical `reelFrequencyTables` - this was verified true of the current code and must
  stay true of the new restart/reseed logic too.
- Windows/PowerShell environment. Use `node --test tests/*.mjs` (via the Bash tool, which is
  Git Bash, or PowerShell) to run tests.

---

## File Structure

- Modify: `core/SpinSimulator.js` - `tuneFrequencies`'s Phase 2 section (options destructure
  ~line 518-542, dims-building loop ~line 632-649, and the seed/evaluate/nelderMead-call/
  return-diagnostics region ~line 738-797). JSDoc above the function also gets the four new
  options documented.
- Modify: `core/SimulationPanel.js` - the "Target RTP was NOT reached" block inside
  `openTuneFrequenciesPanel`'s `startTuning` (~line 405-424).
- Modify: `tests/tunefrequencies.test.mjs` - new tests for the fixed/rtpRange diagnostics,
  determinism-under-restart, the infeasible-target stall path, and the
  converged-with-violations path.

---

## Task 1: `fixedSymbols` and `rtpRange` diagnostics

Small, additive groundwork - no change to Phase 2's control flow yet. Establishes two new
diagnostic fields the later tasks build on.

**Files:**
- Modify: `core/SpinSimulator.js`
- Test: `tests/tunefrequencies.test.mjs`

**Interfaces:**
- Produces: `diagnostics.rtpPhase.fixedSymbols: {reel: number, symbol: string}[]` and
  `diagnostics.rtpPhase.rtpRange: {min: number, max: number}`, both consumed by Task 2 (which
  rewrites the surrounding code but keeps these fields) and Task 3 (UI).

- [ ] **Step 1: Write the failing test**

Add to `tests/tunefrequencies.test.mjs` (after the existing "leaves a symbol untouched..."
test, so it can reuse the same fixture pattern):

```js
test('tuneFrequencies diagnostics.rtpPhase reports fixedSymbols and a sane rtpRange', async () => {
  const reelTablesWithFixedBar = [
    { ...FREQUENCY_REEL1, symbols: { ...FREQUENCY_REEL1.symbols, bar: { ...FREQUENCY_REEL1.symbols.bar, fixed: true } } },
    FREQUENCY_REEL2,
    FREQUENCY_REEL3,
  ];
  const { rtp, diagnostics } = await tuneFrequencies(PAYTABLE, reelTablesWithFixedBar, {
    reelsCount: REELS_COUNT, rowsCount: ROWS_COUNT, paylines: PAYLINES, winEvaluator: checkWildLineWins,
    reelSeeds: REEL_SEEDS, betPerLine: BET_PER_LINE, linesCount: LINES_COUNT, reelLength: REEL_LENGTH,
    targetRtp: 96, trialSpins: 6000, trialsPerPoint: 1, maxIterations: 10,
  });
  assert.deepEqual(diagnostics.rtpPhase.fixedSymbols, [{ reel: 0, symbol: 'bar' }]);
  const { min, max } = diagnostics.rtpPhase.rtpRange;
  assert.ok(min <= max, `expected rtpRange.min (${min}) <= rtpRange.max (${max})`);
  assert.ok(min <= rtp && rtp <= max, `expected achieved RTP ${rtp} within explored range [${min}, ${max}]`);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/tunefrequencies.test.mjs`
Expected: FAIL - `diagnostics.rtpPhase.fixedSymbols` is `undefined` (`TypeError` or
`assert.deepEqual` failure).

- [ ] **Step 3: Implement**

In `core/SpinSimulator.js`, find the dims-building block (starts `const dims = []; // [{
reelIndex, symbol }]...`, currently around line 632). Add a `fixedSymbols` accumulator and
push into it:

```js
  const dims = []; // [{ reelIndex, symbol }] - one entry per free parameter
  const fixedSymbols = []; // [{ reel, symbol }] - excluded from the search entirely (fixed: true)
  const valueBudgetByReel = [];
  const tierOfByReel = [];
  const isFixed = (symbolsTable, s) => symbolsTable[s].fixed === true;
  currentReelTables.forEach((reelTable, r) => {
    const symbolsTable = reelTable.symbols;
    const nonScatterSymbols = Object.keys(symbolsTable).filter(s => !triggerSymbols.includes(s) && symbolsTable[s].frequency > 0);
    const nonScatterTotal = nonScatterSymbols.reduce((sum, s) => sum + symbolsTable[s].frequency, 0);
    const fixedShapeSymbols = nonScatterSymbols.filter(s => isFixed(symbolsTable, s));
    const valueSymbols = nonScatterSymbols.filter(s => !isFixed(symbolsTable, s));
    const fixedShapeTotal = fixedShapeSymbols.reduce((sum, s) => sum + symbolsTable[s].frequency, 0);
    const valueBudget = nonScatterTotal - fixedShapeTotal;
    valueBudgetByReel[r] = valueBudget;
    tierOfByReel[r] = computeValueRanks(paytable, valueSymbols);
    fixedShapeSymbols.forEach(s => fixedSymbols.push({ reel: r, symbol: s }));
    if (valueSymbols.length > 0 && valueBudget > 0) {
      valueSymbols.forEach(s => dims.push({ reelIndex: r, symbol: s, min: symbolsTable[s].min, max: symbolsTable[s].max }));
    }
  });
```

(Only the new `const fixedSymbols = [];` line and the `fixedShapeSymbols.forEach(...)` line
are additions - everything else in this block is unchanged.)

Find `function evaluate(x) {` (currently ~line 746, inside the `if (dims.length > 0) {`
block). Add `rtpMin`/`rtpMax` tracking immediately before it and inside it:

```js
    let rtpMin = Infinity, rtpMax = -Infinity;

    function evaluate(x) {
      const reelTables = projectPoint(x);
      const measured = measure(reelTables, nmSeed);
      const { total: orderPenalty, violations: orderingViolations } = orderingPenaltyOf(reelTables);
      const { total: boundsPenalty, violations: limitViolations } = limitPenaltyOf(reelTables);
      const error = Math.abs(measured.rtp - targetRtp);
      if (measured.rtp < rtpMin) rtpMin = measured.rtp;
      if (measured.rtp > rtpMax) rtpMax = measured.rtp;
      return {
        loss: error + orderingPenaltyWeight * orderPenalty + limitPenaltyWeight * boundsPenalty,
        rtp: measured.rtp,
        triggerRate: measured.triggerRate,
        error,
        orderingViolations,
        limitViolations,
        trial: reelTables,
      };
    }
```

Find `currentReelTables = nm.result.trial;` / `rtpPhaseResult = { ...nm.result, iterations:
nm.iterations };` (currently ~line 772-773) and add the two new fields:

```js
    currentReelTables = nm.result.trial;
    rtpPhaseResult = { ...nm.result, iterations: nm.iterations, rtpRange: { min: rtpMin, max: rtpMax }, fixedSymbols };
```

Find the returned `diagnostics.rtpPhase` object (currently ~line 787-795) and add the two
fields there too:

```js
      rtpPhase: rtpPhaseResult ? {
        error: rtpPhaseResult.error,
        converged: rtpPhaseResult.error <= rtpTolerancePct,
        rtp: rtpPhaseResult.rtp,
        triggerRate: rtpPhaseResult.triggerRate,
        iterationsRun: rtpPhaseResult.iterations,
        orderingViolations: rtpPhaseResult.orderingViolations,
        limitViolations: rtpPhaseResult.limitViolations,
        rtpRange: rtpPhaseResult.rtpRange,
        fixedSymbols: rtpPhaseResult.fixedSymbols,
      } : null,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/tunefrequencies.test.mjs`
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `node --test tests/*.mjs`
Expected: All tests PASS (this is purely additive - nothing existing should change behavior).

- [ ] **Step 6: Commit**

```bash
git add core/SpinSimulator.js tests/tunefrequencies.test.mjs
git commit -m "feat: report fixedSymbols and rtpRange in tuneFrequencies diagnostics"
```

---

## Task 2: Phase 2 restart loop with per-component stall tracking

The core of this plan: replace the single `nelderMead()` call with a round-based loop that
detects stalls (across RTP error, ordering-violation total, and limit-violation total
independently) and escapes them by restarting wider and under a shifted seed, or by giving up
early once that isn't helping either.

Note on test scope: the design spec's "per-component stall tracking" test (RTP plateaus early
while ordering keeps improving, so `restarts` shouldn't tick up just from RTP alone) is hard
to force reliably through the full black-box search with real Monte Carlo noise. Rather than a
separate, fragile test chasing that exact timing, the third test below (converged-with-
violations) folds in an equivalent, more robust check: it asserts `stillImproving.ordering ===
false` once a forced ordering conflict has genuinely stopped improving - confirming the
per-component signal is reported correctly without needing to engineer the precise
interleaved-timing scenario.

**Files:**
- Modify: `core/SpinSimulator.js`
- Test: `tests/tunefrequencies.test.mjs`

**Interfaces:**
- Consumes: `fixedSymbols` (from Task 1, now built earlier in the function - unchanged).
- Produces: `diagnostics.rtpPhase.{reason, restarts, iterationsBudget, orderingPenaltyRemaining,
  limitPenaltyRemaining, stillImproving}` - all new fields Task 3's UI reads.
- New `tuneFrequencies` options: `stallWindowIterations` (default 15), `stallWidenFactor`
  (default 3), `maxStallRestarts` (default 4), `earlyAcceptErrorPct` (default 0.01).

- [ ] **Step 1: Write the failing tests**

Add three tests to `tests/tunefrequencies.test.mjs`.

First, an infeasible-target test (also doubles as the determinism regression, since it's the
scenario most likely to actually exercise restarts):

```js
test('tuneFrequencies gives up early and stays deterministic on a genuinely infeasible target', async () => {
  const opts = {
    reelsCount: REELS_COUNT, rowsCount: ROWS_COUNT, paylines: PAYLINES, winEvaluator: checkWildLineWins,
    reelSeeds: REEL_SEEDS, betPerLine: BET_PER_LINE, linesCount: LINES_COUNT, reelLength: REEL_LENGTH,
    // 1000% RTP is unreachable for this paytable no matter how frequencies are shuffled -
    // total weight per reel is conserved and payouts are fixed, so there's a hard ceiling far
    // below 1000%. Mirrors the barfruits case that motivated this (a scatter payout that made
    // 96% unreachable at a 1% trigger rate), but engineered to be reliably infeasible without
    // needing scatter-specific setup.
    targetRtp: 1000, trialSpins: 4000, trialsPerPoint: 1, maxIterations: 100,
    stallWindowIterations: 8, maxStallRestarts: 3,
  };
  const result = await tuneFrequencies(PAYTABLE, REEL_TABLES, opts);
  const rp = result.diagnostics.rtpPhase;
  assert.equal(rp.reason, 'stalled', `expected 'stalled', got '${rp.reason}' (error=${rp.error})`);
  assert.ok(rp.restarts > 0, `expected at least one restart, got ${rp.restarts}`);
  assert.ok(rp.iterationsRun < rp.iterationsBudget,
    `expected to give up before exhausting the ${rp.iterationsBudget}-iteration budget, used ${rp.iterationsRun}`);

  // Determinism: an identical second call reproduces exactly, including restart count -
  // the seed-shifting on restart must still be a pure function of the original searchSeed.
  const result2 = await tuneFrequencies(PAYTABLE, REEL_TABLES, opts);
  assert.deepEqual(result.reelFrequencyTables, result2.reelFrequencyTables);
  assert.equal(result.diagnostics.rtpPhase.restarts, result2.diagnostics.rtpPhase.restarts);
});
```

Second, an early-accept test (fruitmachine's committed `REEL_TABLES` are already tuned close
to 96% - see the comment on the existing "diagnostics expose a per-step error" test):

```js
test('tuneFrequencies stops early once already essentially resolved (reason: converged)', async () => {
  const result = await tuneFrequencies(PAYTABLE, REEL_TABLES, {
    reelsCount: REELS_COUNT, rowsCount: ROWS_COUNT, paylines: PAYLINES, winEvaluator: checkWildLineWins,
    reelSeeds: REEL_SEEDS, betPerLine: BET_PER_LINE, linesCount: LINES_COUNT, reelLength: REEL_LENGTH,
    targetRtp: 96, trialSpins: 30000, trialsPerPoint: 2, maxIterations: 150,
    // Loose on purpose - REEL_TABLES is already close to 96%, but not necessarily within
    // 0.01 points of it. If this doesn't produce 'converged', check the actual measured RTP
    // via a throwaway script and either loosen this further or tighten trialSpins' noise.
    earlyAcceptErrorPct: 3,
  });
  const rp = result.diagnostics.rtpPhase;
  assert.equal(rp.reason, 'converged', `expected 'converged', got '${rp.reason}' (error=${rp.error})`);
  assert.ok(rp.iterationsRun < rp.iterationsBudget,
    `expected to stop early, used ${rp.iterationsRun} of ${rp.iterationsBudget}`);
});
```

Third, a converged-with-violations test (an artificially high `min` on the highest-paying
symbol forces its frequency up, directly conflicting with the default ordering preference
that a higher-paying symbol should be *rarer* - RTP can still be tuned via the other symbols,
but this specific conflict can never fully resolve):

```js
test('tuneFrequencies reports converged-with-violations when RTP is reachable but an ordering conflict is not', async () => {
  const conflictedTables = [
    { ...FREQUENCY_REEL1, symbols: { ...FREQUENCY_REEL1.symbols, bar: { ...FREQUENCY_REEL1.symbols.bar, min: FREQUENCY_REEL1.symbols.cherries.frequency * 5 } } },
    FREQUENCY_REEL2,
    FREQUENCY_REEL3,
  ];
  const result = await tuneFrequencies(PAYTABLE, conflictedTables, {
    reelsCount: REELS_COUNT, rowsCount: ROWS_COUNT, paylines: PAYLINES, winEvaluator: checkWildLineWins,
    reelSeeds: REEL_SEEDS, betPerLine: BET_PER_LINE, linesCount: LINES_COUNT, reelLength: REEL_LENGTH,
    targetRtp: 96, rtpTolerancePct: 3, trialSpins: 8000, trialsPerPoint: 1, maxIterations: 60,
    limitPenaltyWeight: 20, orderingPenaltyWeight: 0.5, stallWindowIterations: 8, maxStallRestarts: 3,
  });
  const rp = result.diagnostics.rtpPhase;
  assert.equal(rp.reason, 'converged-with-violations', `expected 'converged-with-violations', got '${rp.reason}' (error=${rp.error}, orderingPenaltyRemaining=${rp.orderingPenaltyRemaining})`);
  assert.ok(rp.orderingPenaltyRemaining > 0,
    `expected a remaining ordering violation forced by bar's artificially high min, got ${rp.orderingPenaltyRemaining}`);
  assert.equal(rp.stillImproving.ordering, false, 'expected ordering to be reported as no longer improving once genuinely stuck');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/tunefrequencies.test.mjs`
Expected: FAIL - `diagnostics.rtpPhase.reason`, `.restarts`, `.iterationsBudget`,
`.orderingPenaltyRemaining`, `.stillImproving` are all `undefined`.

- [ ] **Step 3: Implement**

In `core/SpinSimulator.js`, add the four new options to the destructure (currently ~line
518-542, right after `searchSeed = 12345,`):

```js
    searchSeed = 12345,
    stallWindowIterations = 15,
    stallWidenFactor = 3,
    maxStallRestarts = 4,
    earlyAcceptErrorPct = 0.01,
    onProgress = null,
```

Replace the region from the `nmSeed`/`evaluate` definition through the `nelderMead()` call
and its result assignment (currently ~line 738-773 - everything from the `// One fixed seed
for the entire Nelder-Mead call...` comment through `rtpPhaseResult = { ...nm.result,
iterations: nm.iterations, rtpRange: ..., fixedSymbols };` added in Task 1) with:

```js
    // Base seed for Phase 2's common-random-numbers comparability - every point evaluated
    // within one round needs to stay directly comparable. A stalled restart shifts this by a
    // large offset per restart (see the round loop below) so it explores under genuinely
    // different Monte Carlo noise, not just a wider step at the same noisy seed - the whole
    // sequence is still a pure function of `searchSeed`, so tuneFrequencies stays
    // deterministic end-to-end (verified by a dedicated regression test).
    const baseNmSeed = searchSeed + 700000;

    let rtpMin = Infinity, rtpMax = -Infinity;

    function makeEvaluate(nmSeed) {
      return function evaluate(x) {
        const reelTables = projectPoint(x);
        const measured = measure(reelTables, nmSeed);
        const { total: orderPenalty, violations: orderingViolations } = orderingPenaltyOf(reelTables);
        const { total: boundsPenalty, violations: limitViolations } = limitPenaltyOf(reelTables);
        const error = Math.abs(measured.rtp - targetRtp);
        if (measured.rtp < rtpMin) rtpMin = measured.rtp;
        if (measured.rtp > rtpMax) rtpMax = measured.rtp;
        return {
          loss: error + orderingPenaltyWeight * orderPenalty + limitPenaltyWeight * boundsPenalty,
          rtp: measured.rtp,
          triggerRate: measured.triggerRate,
          error,
          orderingPenalty: orderPenalty,
          limitPenalty: boundsPenalty,
          orderingViolations,
          limitViolations,
          trial: reelTables,
        };
      };
    }

    // A value only counts as "improved" if it beat its own best-so-far by more than 2%
    // relative - a small, fixed threshold isn't used since RTP error, ordering-penalty
    // totals, and limit-penalty totals live on completely different scales across games.
    function improved(newValue, prevBest) {
      if (prevBest <= 0) return false; // already at zero - nothing left to improve
      return (prevBest - newValue) > prevBest * 0.02;
    }

    // Phase 2 runs nelderMead() in rounds of `stallWindowIterations` iterations rather than
    // one long call. A round that improves none of RTP error, the ordering-violation total,
    // or the limit-violation total (each tracked against its own best-so-far, not blended
    // into one number - this is what lets "RTP is stuck but ordering is still improving" keep
    // the search going instead of restarting) is a stall: the next round restarts from the
    // best point found so far, with a wider step and a shifted seed, rather than continuing
    // to grind at the same spot. After `maxStallRestarts` consecutive stalls, the search gives
    // up early rather than spending the rest of `maxIterations` on a dead end - see the design
    // doc for the barfruits case (a genuinely infeasible target that used to run the full
    // budget with no way to notice or explain that) that motivated this.
    let point = initialPoint;
    let stepSize = initialStepSize;
    let restarts = 0;
    let iterationsUsed = 0;
    let best = null; // best-ever vertex across all rounds, by RTP error
    let bestOrderingPenalty = Infinity;
    let bestLimitPenalty = Infinity;
    let stallStreak = 0;
    let stalledOut = false;
    let stillImproving = { rtp: true, ordering: true, limits: true };

    do {
      const roundIterations = Math.min(stallWindowIterations, maxIterations - iterationsUsed);
      const nmSeed = baseNmSeed + restarts * 1300021;
      const roundStartIterations = iterationsUsed;
      const nm = await nelderMead({
        initialPoint: point,
        initialStepSize: stepSize,
        evaluate: makeEvaluate(nmSeed),
        maxIterations: roundIterations,
        onProgress: onProgress
          ? (i, pt, result, roundBest) => onProgress('shape', roundStartIterations + i, null, result, roundBest)
          : null,
        yieldToEventLoop,
      });
      iterationsUsed += nm.iterations;

      const prevBestError = best ? best.error : Infinity;
      const prevBestOrdering = bestOrderingPenalty;
      const prevBestLimit = bestLimitPenalty;

      if (!best || nm.result.error < best.error) best = nm.result;
      if (nm.result.orderingPenalty < bestOrderingPenalty) bestOrderingPenalty = nm.result.orderingPenalty;
      if (nm.result.limitPenalty < bestLimitPenalty) bestLimitPenalty = nm.result.limitPenalty;

      stillImproving = {
        rtp: improved(best.error, prevBestError),
        ordering: improved(bestOrderingPenalty, prevBestOrdering),
        limits: improved(bestLimitPenalty, prevBestLimit),
      };

      const fullyResolved = best.error <= earlyAcceptErrorPct && bestOrderingPenalty <= 0 && bestLimitPenalty <= 0;
      if (fullyResolved) break;

      if (stillImproving.rtp || stillImproving.ordering || stillImproving.limits) {
        stallStreak = 0;
        point = nm.point;
      } else {
        stallStreak++;
        restarts++;
        point = best.point;
        stepSize *= stallWidenFactor;
        if (stallStreak >= maxStallRestarts) {
          stalledOut = true;
          break;
        }
      }
    } while (iterationsUsed < maxIterations);

    currentReelTables = best.trial;
    const reason = (() => {
      const rtpOk = best.error <= rtpTolerancePct;
      const violationsOk = bestOrderingPenalty <= 0 && bestLimitPenalty <= 0;
      if (rtpOk && violationsOk) return 'converged';
      if (rtpOk) return 'converged-with-violations';
      if (stalledOut) return 'stalled';
      return 'exhausted';
    })();

    rtpPhaseResult = {
      ...best,
      iterations: iterationsUsed,
      restarts,
      reason,
      rtpRange: { min: rtpMin, max: rtpMax },
      orderingPenaltyRemaining: bestOrderingPenalty,
      limitPenaltyRemaining: bestLimitPenalty,
      stillImproving,
      fixedSymbols,
    };
```

(The `do...while` - rather than `while` - is deliberate: it guarantees at least one round
always runs, matching `nelderMead()`'s own existing behavior of always returning a valid
result even when called with `maxIterations: 0`.)

Update the returned `diagnostics.rtpPhase` object (the block Task 1 last touched) to include
the new fields:

```js
      rtpPhase: rtpPhaseResult ? {
        error: rtpPhaseResult.error,
        converged: rtpPhaseResult.error <= rtpTolerancePct,
        reason: rtpPhaseResult.reason,
        rtp: rtpPhaseResult.rtp,
        triggerRate: rtpPhaseResult.triggerRate,
        iterationsRun: rtpPhaseResult.iterations,
        iterationsBudget: maxIterations,
        restarts: rtpPhaseResult.restarts,
        rtpRange: rtpPhaseResult.rtpRange,
        orderingViolations: rtpPhaseResult.orderingViolations,
        orderingPenaltyRemaining: rtpPhaseResult.orderingPenaltyRemaining,
        limitViolations: rtpPhaseResult.limitViolations,
        limitPenaltyRemaining: rtpPhaseResult.limitPenaltyRemaining,
        stillImproving: rtpPhaseResult.stillImproving,
        fixedSymbols: rtpPhaseResult.fixedSymbols,
      } : null,
```

Finally, update the JSDoc above `tuneFrequencies` (the `@param {Object} [options]` list) to
document the four new options, immediately after the existing `@param {number}
[options.searchSeed=12345]` line:

```js
 * @param {number} [options.stallWindowIterations=15] - Phase 2 runs nelderMead() in rounds of
 *   this many iterations, checking after each round whether RTP error, the ordering-violation
 *   total, or the limit-violation total improved by at least 2% relative to its own
 *   best-so-far. A round where none of the three improved is a stall.
 * @param {number} [options.stallWidenFactor=3] - Multiplier applied to the Nelder-Mead initial
 *   step size each time a stall triggers a restart.
 * @param {number} [options.maxStallRestarts=4] - Consecutive stalled rounds before Phase 2
 *   gives up early (rather than spending the rest of maxIterations on a dead end) and reports
 *   `diagnostics.rtpPhase.reason` as `'stalled'` or `'converged-with-violations'`.
 * @param {number} [options.earlyAcceptErrorPct=0.01] - RTP error threshold (in percentage
 *   points) below which Phase 2 stops immediately if ordering/limit violations are also fully
 *   resolved - no reason to spend more budget refining an already-essentially-exact result.
```

Also update the "Strategy" paragraph's Phase 2 description (the numbered list item starting
"2. Jointly tune every reel's value-symbol weights via one Nelder-Mead simplex search...") to
mention the round/restart mechanism - this bullet currently ends "...fixed on one reel and
freely tuned on another." (right before the blank JSDoc line and `@param {Object} paytable`);
append after that sentence, not after the earlier "...not silently corrected." sentence
mid-bullet:

```js
 *     Phase 2 itself runs in short rounds rather than one long search: a round that fails to
 *     improve RTP error, the ordering-violation total, and the limit-violation total (each
 *     tracked independently) restarts from the best point found so far with a wider step and
 *     a different search seed, and gives up early after several such stalls rather than
 *     grinding through the rest of the iteration budget on a target that was never reachable -
 *     see `diagnostics.rtpPhase.reason` for why a given run stopped.
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/tunefrequencies.test.mjs`
Expected: PASS. If the infeasible-target test doesn't produce `reason === 'stalled'`, try
raising `targetRtp` further (e.g. 5000) or lowering `maxStallRestarts`. If the
converged-with-violations test doesn't produce that exact reason, try raising
`FREQUENCY_REEL1.symbols.bar.frequency * 5` to a larger multiple, or raising
`limitPenaltyWeight` further, to make the forced conflict more pronounced.

- [ ] **Step 5: Run the full suite**

Run: `node --test tests/*.mjs`
Expected: All tests PASS, including the pre-existing tuneFrequencies tests (they don't assert
on `reason`, only on `error`/`converged`/`orderingViolations`/etc., which keep their existing
meaning).

- [ ] **Step 6: Commit**

```bash
git add core/SpinSimulator.js tests/tunefrequencies.test.mjs
git commit -m "feat: detect stalls in tuneFrequencies' RTP search and restart wider/reseeded"
```

---

## Task 3: UI reporting for `reason`

Extend the TUNE FREQUENCIES panel's existing "not converged" warning to explain *why* the
search stopped, using the new `reason` field.

**Files:**
- Modify: `core/SimulationPanel.js`

**Interfaces:**
- Consumes: `diagnostics.rtpPhase.{reason, restarts, iterationsRun, iterationsBudget, rtpRange,
  orderingViolations, orderingPenaltyRemaining, limitViolations, limitPenaltyRemaining, error}`
  (all from Task 2).

- [ ] **Step 1: Implement**

There's no existing automated test covering this function's HTML output (it's DOM-string
assembly inside `openTuneFrequenciesPanel`, not currently unit-tested elsewhere in this file
either) - this step is implementation followed by a manual browser check in Step 2, matching
this project's existing test coverage for this specific function.

In `core/SimulationPanel.js`, find the block that reads (currently ~line 405-424):

```js
    const rtpConverged = !!diagnostics.rtpPhase?.converged;
    const scatterConverged = diagnostics.scatterPhase == null || !!diagnostics.scatterPhase.converged;
    appendLog(
      rtpConverged && scatterConverged
        ? `Done. Final RTP=${rtp.toFixed(2)}%  trigger=${triggerRatePct.toFixed(3)}%`
        : `⚠ Did NOT converge. Final RTP=${rtp.toFixed(2)}%  trigger=${triggerRatePct.toFixed(3)}%  (this is the closest attempt found, not a successful tune)`
    );
    console.log('Frequency tuner diagnostics:', diagnostics);

    let html = `<p style="font-size: 0.85em; color: #ccc; margin: 12px 0 8px;">Achieved RTP: <strong>${rtp.toFixed(2)}%</strong> &nbsp;|&nbsp; Free spin trigger rate: <strong>${triggerRatePct.toFixed(3)}%</strong> (1 in ${(100 / triggerRatePct).toFixed(0)})</p>`;

    const targetRtp = options.targetRtp;
    if (!rtpConverged) {
      html += `<p style="font-size: 0.8em; color: #e6b800; background: rgba(230,184,0,0.1); padding: 8px; border-radius: 6px; margin-bottom: 10px;">
                 <strong>⚠ Target RTP (${targetRtp}%) was NOT reached</strong> -
                 the closest attempt found is off by ${diagnostics.rtpPhase.error.toFixed(2)} percentage points.
                 Try raising Max Iterations, or check whether the current frequencies/payouts allow
                 ${targetRtp}% RTP at all - don't treat the RTP shown above as final without checking this.
               </p>`;
    }
```

Replace the `const targetRtp = ...` line and the `if (!rtpConverged) { ... }` block with:

```js
    const targetRtp = options.targetRtp;
    const reason = diagnostics.rtpPhase?.reason;
    if (reason && reason !== 'converged') {
      const rp = diagnostics.rtpPhase;
      const rangeNote = rp.rtpRange
        ? ` RTP ranged from ${rp.rtpRange.min.toFixed(2)}% to ${rp.rtpRange.max.toFixed(2)}% during the search.`
        : '';
      let message;
      if (reason === 'converged-with-violations') {
        const totalViolations = rp.orderingViolations.length + rp.limitViolations.length;
        message = `<strong>⚠ Target RTP (${targetRtp}%) was reached, but ${rp.orderingViolations.length} ordering / ` +
          `${rp.limitViolations.length} limit violation${totalViolations === 1 ? '' : 's'} remain</strong> ` +
          `(totaling ${rp.orderingPenaltyRemaining.toFixed(3)} / ${rp.limitPenaltyRemaining.toFixed(3)}) - the search stopped trying to ` +
          `resolve them further after ${rp.restarts} restart${rp.restarts === 1 ? '' : 's'}.`;
      } else if (reason === 'stalled') {
        message = `<strong>⚠ Target RTP (${targetRtp}%) was NOT reached</strong> - the search gave up after ${rp.restarts} restart${rp.restarts === 1 ? '' : 's'} ` +
          `with no further improvement on RTP, ordering, or limits (used ${rp.iterationsRun} of ${rp.iterationsBudget} iterations). ` +
          `The closest attempt found is off by ${rp.error.toFixed(2)} percentage points. Raising Max Iterations alone is unlikely to help - ` +
          `check whether the current frequencies/payouts allow ${targetRtp}% RTP at all.`;
      } else { // 'exhausted'
        message = `<strong>⚠ Target RTP (${targetRtp}%) was NOT reached</strong> - the closest attempt found is off by ${rp.error.toFixed(2)} ` +
          `percentage points, and the search was still improving when it ran out of iterations (used all ${rp.iterationsBudget}). ` +
          `Try raising Max Iterations.`;
      }
      html += `<p style="font-size: 0.8em; color: #e6b800; background: rgba(230,184,0,0.1); padding: 8px; border-radius: 6px; margin-bottom: 10px;">
                 ${message}${rangeNote}
               </p>`;
    }
```

(`rtpConverged`/`scatterConverged` stay exactly as they were, still used by the `appendLog(...)`
call right above this block - only the detailed HTML block changes.)

- [ ] **Step 2: Manual verification in browser**

Start the dev server (`./serve.ps1`), open `games/barfruits/index.html` (the game whose
TUNE FREQUENCIES panel motivated this whole plan), click TUNE FREQUENCIES, and run a tune.
Confirm:
- A normal converging run still shows the plain "Achieved RTP..." line with no warning block.
- Temporarily setting an unreachable target (e.g. Target RTP 500%) produces the `'stalled'`
  message, not a silent full-budget grind.
- The existing itemized ordering/limit violation lists below the new message still render
  correctly (they're untouched by this change).

- [ ] **Step 3: Run the full suite**

Run: `node --test tests/*.mjs`
Expected: All tests PASS (this task doesn't touch anything the test suite exercises directly).

- [ ] **Step 4: Commit**

```bash
git add core/SimulationPanel.js
git commit -m "feat: explain why TUNE FREQUENCIES stopped (reason) in the panel UI"
```

---

## Task 4: Full-suite verification and original-bug confirmation

**Files:** None modified - verification only.

- [ ] **Step 1: Run the full test suite**

Run: `node --test tests/*.mjs`
Expected: All tests pass. `tests/book-rtp-regression.test.mjs` is a known pre-existing flaky
test (unseeded `Math.random()`) unrelated to this work - if only that one fails, rerun it in
isolation (`node --test tests/book-rtp-regression.test.mjs`) to confirm it passes alone before
treating the suite as green.

- [ ] **Step 2: Confirm the original barfruits complaint is actually fixed**

Reproduce the exact scenario from the original bug report with a throwaway script:

```bash
node -e "
import('./games/barfruits/game.js').then(async (m) => {
  const { tuneFrequencies } = await import('./core/SpinSimulator.js');
  const FREQUENCY_REELS = [m.FREQUENCY_REEL1, m.FREQUENCY_REEL2, m.FREQUENCY_REEL3, m.FREQUENCY_REEL4, m.FREQUENCY_REEL5];
  const result = await tuneFrequencies(m.PAYTABLE, FREQUENCY_REELS, {
    reelsCount: m.REELS_COUNT, rowsCount: m.ROWS_COUNT, paylines: m.PAYLINES,
    scatterSymbol: 'star', reelSeeds: m.REEL_SEEDS, betPerLine: m.BET_PER_LINE,
    linesCount: m.LINES_COUNT, reelLength: m.REEL_LENGTH,
    targetRtp: 96, targetTriggerRatePct: 1, trialSpins: 100000, trialsPerPoint: 2, maxIterations: 150,
  });
  console.log('Final RTP', result.rtp, 'reason', result.diagnostics.rtpPhase.reason,
    'restarts', result.diagnostics.rtpPhase.restarts,
    'iterationsRun', result.diagnostics.rtpPhase.iterationsRun, '/', result.diagnostics.rtpPhase.iterationsBudget);
}).catch(e => { console.error('ERROR', e.stack); process.exit(1); });
"
```

Expected: `reason` is `'stalled'` (this scenario is the barfruits `star` payout at a 1%
trigger rate, confirmed earlier to be genuinely infeasible - scatter alone contributes ~121%
RTP), and `iterationsRun` is noticeably less than `iterationsBudget` (150) - i.e. the search
gave up once it recognized the plateau, rather than grinding through all 150 iterations to
land on ~152% with no explanation, as it did before this plan.

- [ ] **Step 3: Report**

No code changes in this task - if both steps pass, the plan is complete. If Step 2's `reason`
comes out `'exhausted'` instead of `'stalled'`, the stall-detection thresholds
(`stallWindowIterations`/`maxStallRestarts`) may need loosening for this specific case; treat
that as a real finding to bring back, not something to silently patch around.
