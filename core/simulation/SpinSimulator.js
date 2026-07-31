/**
 * Batch spin execution. This module owns only simulation bookkeeping; tuning lives in
 * core/tuning/FrequencyTuner.js.
 */
import { LineMechanic } from '../engine/mechanics/LineMechanic.js';
import { createRoundAccumulator, recordRound, summarizeRoundStats } from './RoundStatistics.js';
/**
 * A pure functional simulator for the SlotMachine game logic.
 * It models spins without any visual or audio side effects.
 */

/**
 * Simulates multiple spins and returns statistical analysis. Mechanic-agnostic: how one spin
 * actually resolves (draw a target grid and evaluate paylines vs. resolve a full cascade
 * sequence) is delegated to `config.mechanic` (core/LineMechanic.js's default, or
 * core/CascadeSpinMechanic.js for cluster-pays games) - this function only owns what's common
 * to both: the base-spin loop, free-spins triggering/retriggering/award-table lookups, the
 * global free-spins safety cap, and result aggregation (RTP, win distribution, spin log).
 * @param {Object} config - Game configuration with reelStrips, paytable, etc.
 * @param {Object} [config.mechanic] - A spin-resolution mechanic (see core/LineMechanic.js's
 *   `LineMechanic` export for the contract: `createFreeSpinsState(simConfig, rng)` and
 *   `resolveSpin({ simConfig, betPerLine, linesCount, rng, isFreeSpin, freeSpinsState,
 *   spinIndex, chargedBet, logSpins }) -> { spinWin, scatterWin, detailedWins, logEntry }`).
 *   Defaults to `LineMechanic` - every existing line-pay caller keeps working unchanged without
 *   ever passing this. Candy Frenzy (and any future cascade game) passes
 *   `CascadeSpinMechanic` from core/CascadeSpinMechanic.js instead.
 * @param {Object} [config.freeSpinsMode] - Cascade-mechanic-only: the pluggable free-spins
 *   payout mode (core/FreeSpinsModes.js) to simulate, passed straight through to
 *   `mechanic.createFreeSpinsState`. Ignored by LineMechanic.
 * @param {number} [config.freeSpinsCount=10] - Flat number of free spins awarded per trigger,
 *   used whenever the triggering scatter count isn't found in `freeSpinsAwardTable` (or that
 *   table is omitted entirely).
 * @param {Object} [config.freeSpinsAwardTable] - Optional `{ scatterCount: awardedSpins }` map
 *   for the free-spins award granted by a BASE-game trigger, mirroring a real game's own award
 *   schedule (e.g. `{ 3: 10, 4: 15, 5: 20 }`). Falls back to `freeSpinsCount` for any count not
 *   listed.
 * @param {Object} [config.retriggerFreeSpinsAwardTable] - Same shape, for a qualifying scatter
 *   hit landing DURING an active free-spins round (a retrigger). Defaults to
 *   `freeSpinsAwardTable` when omitted. Its mere presence (directly or via that default) is
 *   what enables retrigger simulation at all - if neither table is set, free spins run for
 *   exactly `freeSpinsCount` spins with no retriggers, matching this function's original
 *   behavior exactly.
 * @param {boolean} [config.logSpins=false] - When true, records one entry per simulated spin
 *   (base and free alike) in the returned `spinLog` array - spin index, phase, bet, total win,
 *   and a breakdown of every scatter/line/expanding/cluster win that spin produced. Off by
 *   default since it holds one object per spin in memory for the whole run (relevant at the
 *   default 1,000,000+ spin counts); turn it on for a dev-tooling export (see
 *   ui/dev/SimulationPanel.js's "EXPORT SPIN LOG" button), not for routine RTP measurement.
 * @param {boolean} [config.hasExpandingWild=false] - LineMechanic-only: whether free spins here
 *   include a Book-of-Dead-style expanding-wild bonus (a random non-scatter symbol picked fresh
 *   each free-spins session, expanding to fill any reel it lands on - see checkExpandingWins).
 *   Off by default - without this, free spins pay out exactly like the base game, just at no
 *   cost. Omitting it for a game that doesn't actually have this mechanic isn't just "leaving
 *   a feature off": this used to run unconditionally for ANY game with free spins regardless
 *   of whether its real engine flow ever calls enterFreeSpins with an expanding symbol,
 *   fabricating extra "expanding win" payouts (against a real, randomly-chosen paytable
 *   symbol, so not even a harmless no-op) that inflated RTP for any such game.
 * @param {number} numBaseSpins - Number of base spins to simulate (default 100000)
 * @param {number} betPerLine - Bet per line (default 1). Cascade games (no per-line concept)
 *   pass their flat bet amount here alongside `linesCount: 1`.
 * @param {number} linesCount - Number of active paylines (default 10). Cascade games pass 1.
 * @param {() => number} [rng=Math.random] - Random source for spin outcomes. Pass a seeded
 *   rng (e.g. createSeededRng(seed) from SlotMath.js) for a reproducible run; defaults to
 *   Math.random for today's non-deterministic behavior.
 * @returns {Object} Simulation results including RTP, win distribution, etc.
 */

export function simulateSpins(config, numBaseSpins = 100000, betPerLine = 1, linesCount = 10, rng = Math.random) {
  // Input validation
  if (!config || !config.reelStrips || !config.paytable) {
    throw new Error('Invalid config: reelStrips and paytable required');
  }
  if (numBaseSpins <= 0 || betPerLine <= 0 || linesCount <= 0) {
    throw new Error('All numeric parameters must be positive');
  }

  const results = {
    totalBets: 0,
    totalWins: 0,
    winDistribution: {}, // Populated only when config.collectWinDistribution !== false
    detailedWins: [],     // Populated only when config.collectDetailedWins !== false
    spinLog: [],           // Populated only when config.logSpins is true (see its own doc)
    scatterCounts: 0,
    maxWin: 0,
    minWin: Infinity,
    freeSpinsTriggered: 0,
    totalSimulatedSpins: 0
  };

  const simConfig = { ...config };
  simConfig.linesCount = linesCount;
  simConfig.betPerLine = betPerLine;
  simConfig.totalBet = betPerLine * linesCount;

  const mechanic = simConfig.mechanic || LineMechanic;
  // Candidate measurements need totals, and only some need the bounded round histogram. Keeping
  // the two opt-outs independent preserves the detailed simulation-panel result by default while
  // avoiding needless per-round bookkeeping during millions of RTP-only tuning spins.
  const collectWinDistribution = simConfig.collectWinDistribution !== false;
  const collectDetailedWins = simConfig.collectDetailedWins !== false;
  const collectRoundStats = simConfig.collectRoundStats !== false;

  // Get configuration values with defaults
  const freeSpinsCount = simConfig.freeSpinsCount || 10;
  // Optional { scatterCount: awardedSpins } lookups mirroring a real game's own award
  // schedule (e.g. barfruits' FREQUENCY_REEL-adjacent FREE_SPINS_AWARD = {3:10, 4:15, 5:20}).
  // Absent -> awardFor() falls back to the flat freeSpinsCount above, unchanged from before
  // these existed. retriggerFreeSpinsAwardTable additionally defaults to freeSpinsAwardTable
  // when only one is given, since most games use the same schedule for both; its mere
  // presence is what turns retrigger simulation on at all (see supportsRetrigger below) - a
  // config that sets neither table keeps the exact old behavior (flat freeSpinsCount spins,
  // no retriggers), so this is purely additive for any existing caller.
  const freeSpinsAwardTable = simConfig.freeSpinsAwardTable || null;
  const retriggerFreeSpinsAwardTable = simConfig.retriggerFreeSpinsAwardTable || freeSpinsAwardTable;
  const supportsRetrigger = retriggerFreeSpinsAwardTable != null;
  const awardFor = (table, count) => (table && table[count] != null) ? table[count] : freeSpinsCount;
  // Bounds the TOTAL free spins run across the whole call, not just one chain - a per-chain-only
  // cap still allows worst-case total work of numBaseSpins * cap, which for a candidate/baseline
  // with an extremely high trigger+retrigger rate (very plausible mid-search, before Phase 1 has
  // scaled anything down yet, or simply while a game's frequencies are still being hand-tuned)
  // could take impractically long even though each individual chain is itself bounded. Scaling
  // with numBaseSpins keeps a larger requested simulation proportionally better sampled while
  // still keeping worst-case runtime roughly O(numBaseSpins) regardless of how pathological the
  // configured frequencies are.
  const FREE_SPINS_GLOBAL_CAP = Math.max(numBaseSpins * 20, 50000);
  let totalFreeSpinsRun = 0;
  const logSpins = !!simConfig.logSpins;

  // Runs one spin (base or free) via the active mechanic, then folds its result into `results` -
  // the one piece of bookkeeping every mechanic shares, regardless of how it resolved the grid.
  function runOneSpin(isFreeSpin, freeSpinsState) {
    const chargedBet = isFreeSpin ? 0 : simConfig.totalBet;
    if (!isFreeSpin) results.totalBets += chargedBet;
    results.totalSimulatedSpins++;

    const { spinWin, scatterWin, detailedWins, logEntry } = mechanic.resolveSpin({
      simConfig, betPerLine, linesCount, rng, isFreeSpin, freeSpinsState,
      spinIndex: results.totalSimulatedSpins, chargedBet, logSpins,
    });

    if (scatterWin) {
      results.scatterCounts += scatterWin.count;
      if (scatterWin.triggerFreeSpins) results.freeSpinsTriggered++;
    }

    results.totalWins += spinWin;
    if (spinWin > results.maxWin) results.maxWin = spinWin;
    if (spinWin < results.minWin) results.minWin = spinWin;
    if (collectWinDistribution) {
      results.winDistribution[spinWin] = (results.winDistribution[spinWin] || 0) + 1;
    }
    // Every spin's win joins the round currently open - free spins included, which is the whole
    // point: the bonus they pay belongs to the paid spin that bought it. RTP-only tuning does not
    // need this round-shape data, so avoid touching its accumulator on the hot path.
    if (collectRoundStats) roundWin += spinWin;
    if (collectDetailedWins) detailedWins.forEach(w => results.detailedWins.push(w));
    if (logSpins && logEntry) results.spinLog.push(logEntry);

    return { scatterWin };
  }

  // The round currently being accumulated. Reset by the base-spin loop, added to by every spin.
  let roundWin = 0;
  const roundAcc = collectRoundStats ? createRoundAccumulator() : null;
  const closeRound = () => {
    if (!roundAcc) return;
    const multiple = simConfig.totalBet > 0 ? roundWin / simConfig.totalBet : 0;
    recordRound(roundAcc, multiple);
  };

  // Main simulation loop for base spins
  for (let i = 0; i < numBaseSpins; i++) {
    roundWin = 0;
    const result = runOneSpin(false, null);

    // If free spins were triggered by this base spin, simulate them (unless the global free
    // spins budget is already exhausted - base spins keep running either way, so the base-game
    // RTP/trigger-rate signal stays representative even once free-spin payouts are truncated).
    if (result.scatterWin && result.scatterWin.triggerFreeSpins && totalFreeSpinsRun < FREE_SPINS_GLOBAL_CAP) {
      // Built once per round (e.g. LineMechanic randomizes an expanding symbol,
      // CascadeSpinMechanic inits a free-spins-mode's persistent state) - never rebuilt by a
      // retrigger extending this same round.
      const freeSpinsState = mechanic.createFreeSpinsState(simConfig, rng);

      // A real free-spins round can retrigger itself (another qualifying scatter hit during
      // the bonus adds more spins on top, same as the live engine's retriggerFreeSpins) - the
      // remaining-spins count grows as the loop runs rather than being fixed up front.
      let freeSpinsRemaining = awardFor(freeSpinsAwardTable, result.scatterWin.count);
      let freeSpinsRun = 0;
      while (freeSpinsRun < freeSpinsRemaining && totalFreeSpinsRun < FREE_SPINS_GLOBAL_CAP) {
        const fsResult = runOneSpin(true, freeSpinsState);
        freeSpinsRun++;
        totalFreeSpinsRun++;
        if (supportsRetrigger && fsResult.scatterWin && fsResult.scatterWin.triggerFreeSpins) {
          freeSpinsRemaining += awardFor(retriggerFreeSpinsAwardTable, fsResult.scatterWin.count);
        }
      }
    }
    // After the free-spins chain, so the round carries what the bonus paid. This is exactly the
    // boundary the loop already had; nothing needed restructuring to find it.
    closeRound();
  }

  const rtp = results.totalBets > 0 ? (results.totalWins / results.totalBets) * 100 : 0;

  return {
    rtp: rtp.toFixed(2) + '%',
    rtpRaw: results.totalBets > 0 ? (results.totalWins / results.totalBets) : 0,
    totalSpins: results.totalSimulatedSpins,
    baseSpins: numBaseSpins,
    totalBets: results.totalBets,
    totalWins: results.totalWins,
    maxWin: results.maxWin,
    minWin: results.minWin === Infinity ? 0 : results.minWin,
    scatterCounts: results.scatterCounts,
    freeSpinsTriggered: results.freeSpinsTriggered,
    winDistribution: results.winDistribution,
    detailedWins: results.detailedWins,
    spinLog: results.spinLog,
    // The SHAPE of the payout, per round rather than per spin - see createRoundAccumulator.
    // Always produced: it costs a handful of counters and a fixed 61-bucket histogram, which is
    // cheap enough that making it optional would only add a way to not have the answer.
    roundStats: roundAcc ? summarizeRoundStats(roundAcc) : null,
  };
}

