import { resolveFrequencyBounds } from '../../../math/SlotMath.js';
import { exportSpinLogCsv } from '../../../logging/SpinLog.js';
import { spinsPerTriggerToPct, pctToSpinsPerTrigger, INTENT_LEVELS, intentToWeight, weightToIntent, volatilityBandToSigma } from '../../../tuning/Units.js';
import { describePlayerExperience } from '../../../tuning/PlayerExperience.js';
import { createTuneLogEntry, describeTuneEntryQuality, tuneLogToJson, exportTuneLogJson } from '../../../tuning/TuneLog.js';
import { runTuneFrequenciesWithPool } from './TuningRunService.js';
import {
  renderTuneLogHtml, renderTargetChipsHtml,
  renderPlayerExperienceHtml, describePenaltyStateNow, renderLossBudgetHtml,
  renderDiagnosisHtml, formatScaledPaytableForCopy, renderPayoutScaleHtml,
  formatReelFrequencyTablesForCopy,
} from './TuningReports.js';
import { fmt, esc } from './TuningFormat.js';
import { PENALTY_INTENTS } from './TuningPanelSchema.js';
import { renderLiveFrequencyTable } from './TuningLiveView.js';
import { renderFrequencyComparisonTables } from './TuningResultView.js';
export async function startTuning({ paytable, reelFrequencyTables, tuneConfig, tuneContainer, originalReelFrequencyTables = reelFrequencyTables, continuedFrom = null, diagnoseOnly = false }) {
  const startBtn = tuneContainer.querySelector('#tune-start-btn');
  const diagnoseBtn = tuneContainer.querySelector('#tune-diagnose-btn');
  // `stopBtn` is a persistent element (created once in the panel's template, not per-run) - using
  // `.onclick` assignment rather than `addEventListener` is what lets each new startTuning() call
  // simply replace the previous run's handler (and its now-stale AbortController closure) instead
  // of accumulating one listener per START TUNING/CONTINUE click over a long panel session.
  const stopBtn = tuneContainer.querySelector('#tune-stop-btn');
  const abortController = new AbortController();
  stopBtn.onclick = () => {
    stopBtn.disabled = true;
    stopBtn.textContent = 'STOPPING...';
    abortController.abort();
  };
  const logEl = tuneContainer.querySelector('#tune-progress-log');
  const resultsEl = tuneContainer.querySelector('#tune-results');
  const inputs = {
    targetRtp: tuneContainer.querySelector('#tune-target-rtp'),
    rtpTolerancePct: tuneContainer.querySelector('#tune-rtp-tolerance'),
    // Entered as "one bonus every N spins" and converted at the boundary - see core/tuning/Units.js
    // for why the panel and the library deliberately speak different units here.
    targetTriggerSpins: tuneContainer.querySelector('#tune-target-trigger-spins'),
    triggerRateTolerancePct: tuneContainer.querySelector('#tune-trigger-tolerance'),
    searchSeed: tuneContainer.querySelector('#tune-search-seed'),
    reelLength: tuneContainer.querySelector('#tune-reel-length'),
    trialSpins: tuneContainer.querySelector('#tune-trial-spins'),
    trialsPerPoint: tuneContainer.querySelector('#tune-trials-per-point'),
    maxRtpStdError: tuneContainer.querySelector('#tune-max-rtp-std-error'),
    maxIterations: tuneContainer.querySelector('#tune-max-iterations'),
    orderingPenaltyWeight: tuneContainer.querySelector('#tune-ordering-weight'),
    limitPenaltyWeight: tuneContainer.querySelector('#tune-limit-weight'),
    uniformityPenaltyWeight: tuneContainer.querySelector('#tune-uniformity-weight'),
    stdErrorPenaltyWeight: tuneContainer.querySelector('#tune-std-error-weight'),
    triggerRatePenaltyWeight: tuneContainer.querySelector('#tune-trigger-rate-weight'),
    spacingPenaltyWeight: tuneContainer.querySelector('#tune-spacing-weight'),
    initialWeightStrategy: tuneContainer.querySelector('#tune-initial-weight-strategy'),
    searchAlgorithm: tuneContainer.querySelector('#tune-search-algorithm'),
    reelCoupling: tuneContainer.querySelector('#tune-reel-coupling'),
    maxReelDeviation: tuneContainer.querySelector('#tune-max-reel-deviation'),
    penaltyNormalization: tuneContainer.querySelector('#tune-penalty-normalization'),
    targetVolatility: tuneContainer.querySelector('#tune-target-volatility'),
    sensitivitySpins: tuneContainer.querySelector('#tune-sensitivity-spins'),
    solvePayoutScale: tuneContainer.querySelector('#tune-solve-payout-scale'),
    tuneStructural: tuneContainer.querySelector('#tune-tune-structural'),
  };
  const biasSelects = Array.from({ length: tuneConfig.reelsCount }, (_, r) => tuneContainer.querySelector(`#tune-bias-${r}`));
  const biasStrengthInputs = Array.from({ length: tuneConfig.reelsCount }, (_, r) => tuneContainer.querySelector(`#tune-bias-strength-${r}`));

  // Resolved once, up front - these bounds don't change during the run, only frequency does.
  const boundsByReel = reelFrequencyTables.map(reelTableWrapper => {
    const symbolsTable = reelTableWrapper.symbols || reelTableWrapper;
    const bounds = {};
    Object.keys(symbolsTable).forEach(symbol => { bounds[symbol] = resolveFrequencyBounds(reelTableWrapper, symbol); });
    return bounds;
  });
  const liveTableEl = tuneContainer.querySelector('#tune-live-table');
  const liveStatsEl = tuneContainer.querySelector('#tune-live-stats');
  const liveStatsCurrentEl = tuneContainer.querySelector('#tune-live-stats-current');
  const liveStatsCurrentStepEl = tuneContainer.querySelector('#tune-live-stats-current-step');
  const liveStatsCurrentProgressBarEl = tuneContainer.querySelector('#tune-live-stats-current-progress-bar');
  const liveStatsBestEl = tuneContainer.querySelector('#tune-live-stats-best');
  const liveStatsBestImprovedEl = tuneContainer.querySelector('#tune-live-stats-best-improved');
  const liveStatsViolationsEl = tuneContainer.querySelector('#tune-live-stats-violations');
  // Everything Phase 0 produces, accumulated and re-rendered as one panel rather than appended to
  // the log line by line. Held as data (not markup) so a later phase's findings can join an
  // earlier phase's without either having to know how the other is drawn.
  const diagnosisEl = tuneContainer.querySelector('#tune-diagnosis');
  const diagnosis = { validation: [], structuralHeadroom: null, sensitivity: null, structuralRecommendation: null, lossPreview: null };
  // Every candidate the search accepted as its new best, kept rather than overwritten - see
  // core/tuning/TuneLog.js for why the final answer alone is not enough.
  const tuneLog = [];
  const bestLogEl = tuneContainer.querySelector('#tune-best-log');
  const bestLogBtn = tuneContainer.querySelector('#tune-best-log-btn');
  let bestLogOpen = false;
  // Set from the 'input-parameters' progress event at the very start of a run, so the log's
  // exports carry the run's knobs from the first accepted candidate rather than only after the
  // run resolves. `lastDiagnostics` is the fallback for a finished run.
  let liveInputParameters = null;
  const runInputParameters = () => liveInputParameters ?? lastDiagnostics?.inputParameters ?? null;
  const tuneLogMeta = () => ({ game: tuneConfig.gameName ?? null, inputParameters: runInputParameters() });
  const copyToClipboard = async (text, btn) => {
    try { await navigator.clipboard.writeText(text); } catch (err) { /* clipboard blocked - fall through */ }
    const original = btn.textContent;
    btn.textContent = 'COPIED!';
    setTimeout(() => { btn.textContent = original; }, 1500);
  };
  function renderTuneLog() {
    if (!bestLogEl || !bestLogBtn) return;
    bestLogBtn.style.display = tuneLog.length > 0 ? 'inline-block' : 'none';
    bestLogBtn.textContent = `${bestLogOpen ? 'HIDE' : 'VIEW'} ${tuneLog.length} ACCEPTED`;
    bestLogEl.style.display = bestLogOpen && tuneLog.length > 0 ? 'block' : 'none';
    if (!bestLogOpen || tuneLog.length === 0) return;
    bestLogEl.innerHTML = renderTuneLogHtml(tuneLog);
    // Rebuilt markup means fresh elements every time, so handlers are attached here rather than
    // once - and `.onclick` rather than addEventListener so a re-render cannot stack them up.
    // Paste-ready game.js code, through the exact same formatter the end-of-tune output uses -
    // so a config lifted out of the history is indistinguishable in form from the winner, and the
    // only difference is the header saying which entry it is.
    bestLogEl.querySelectorAll('.tune-log-copy-js').forEach(b => {
      b.onclick = () => {
        const e = tuneLog.find(x => x.index === Number(b.dataset.index));
        if (!e) return;
        copyToClipboard(formatReelFrequencyTablesForCopy(e.reelFrequencyTables, {
          inputParameters: runInputParameters() ?? {},
          rtp: e.achieved.rtp,
          triggerRatePct: e.achieved.triggerRatePct,
          tuneLogEntry: e,
        }), b);
      };
    });
    bestLogEl.querySelectorAll('.tune-log-copy').forEach(b => {
      b.onclick = () => {
        const e = tuneLog.find(x => x.index === Number(b.dataset.index));
        if (e) copyToClipboard(tuneLogToJson([e], tuneLogMeta()), b);
      };
    });
    bestLogEl.querySelectorAll('.tune-log-export').forEach(b => {
      b.onclick = () => {
        const e = tuneLog.find(x => x.index === Number(b.dataset.index));
        if (e) exportTuneLogJson([e], tuneLogMeta());
      };
    });
    const copyAll = bestLogEl.querySelector('#tune-log-copy-all');
    if (copyAll) copyAll.onclick = () => copyToClipboard(tuneLogToJson(tuneLog, tuneLogMeta()), copyAll);
    const exportAll = bestLogEl.querySelector('#tune-log-export-all');
    if (exportAll) exportAll.onclick = () => exportTuneLogJson(tuneLog, tuneLogMeta());
  }
  if (bestLogBtn) bestLogBtn.onclick = () => { bestLogOpen = !bestLogOpen; renderTuneLog(); };
  // Set once the run finishes; the log's export header wants the resolved parameters, and they do
  // not exist until then. An export taken mid-run simply carries a null run header rather than a
  // wrong one.
  let lastDiagnostics = null;
  function renderDiagnosis() {
    if (!diagnosisEl) return;
    const html = renderDiagnosisHtml(diagnosis);
    diagnosisEl.innerHTML = html;
    diagnosisEl.style.display = html ? 'block' : 'none';
    // The "now:" column beside each intent dropdown, filled from whatever the last run measured.
    // This is what makes a level a choice about a real quantity rather than an incantation, so it
    // is refreshed with the diagnosis rather than only at the end of a tune.
    const now = describePenaltyStateNow(diagnosis.lossPreview);
    Object.entries(now).forEach(([key, text]) => {
      const cell = tuneContainer.querySelector(`#tune-now-${key}`);
      if (cell) cell.textContent = text;
    });
  }
  const phaseBannerEl = tuneContainer.querySelector('#tune-phase-banner');
  const phaseNameEl = tuneContainer.querySelector('#tune-phase-name');
  const phaseProgressEl = tuneContainer.querySelector('#tune-phase-progress');
  const phaseStrategyEl = tuneContainer.querySelector('#tune-phase-strategy');
  const phaseWhyEl = tuneContainer.querySelector('#tune-phase-why');

  // The strategy currently running in Phase 2, as announced by the engine's 'coupling-stage'
  // events. Held here so every per-iteration line can be tagged with it - without that, a
  // two-stage run logs "Step 9" identically whether it is still sharing one weight per symbol or
  // has already handed over to the bounded per-reel refinement, and the handover is invisible.
  let currentStage = null;
  const STAGE_LABELS = {
    linked: 'same mix', refine: 'vary per reel', independent: 'per-reel mix',
  };

  // One place that answers "where am I / what is running / why", updated by every phase rather
  // than only by Phase 2. `progress` is optional and shows position within the phase when there
  // is one to show.
  function setPhaseBanner({ name, strategy, why, progress }) {
    if (!phaseBannerEl) return;
    phaseBannerEl.style.display = 'block';
    phaseNameEl.textContent = name;
    phaseProgressEl.textContent = progress ?? '';
    phaseStrategyEl.textContent = strategy ?? '';
    phaseWhyEl.textContent = why ?? '';
  }
  // reelIdx -> symbol -> { min, max } actually assigned during the search so far this run -
  // grows as Phase 2 explores, reset fresh on every START TUNING click.
  const testedRangeByReel = reelFrequencyTables.map(() => ({}));

  const options = {
    // Stops the engine after Phases 0a/0b/0c - see diagnoseConfig's own doc for why diagnosis is
    // its own action rather than always the prelude to a search.
    diagnoseOnly,
    signal: abortController.signal,
    reelsCount: tuneConfig.reelsCount,
    rowsCount: tuneConfig.rowsCount,
    paylines: tuneConfig.paylines,
    reelSeeds: tuneConfig.reelSeeds,
    betPerLine: tuneConfig.betPerLine,
    linesCount: tuneConfig.linesCount,
    winEvaluator: tuneConfig.winEvaluator,
    // Explicit override for a cascade game, whose winEvaluator is a per-game closure that
    // can't be identified by its own `.name` (see runTuneFrequenciesWithPool's doc above).
    winEvaluatorName: tuneConfig.winEvaluatorName,
    wildSymbol: tuneConfig.wildSymbol,
    scatterSymbol: tuneConfig.scatterSymbol,
    freeSpinsCount: tuneConfig.freeSpinsCount,
    freeSpinsAwardTable: tuneConfig.freeSpinsAwardTable,
    retriggerFreeSpinsAwardTable: tuneConfig.retriggerFreeSpinsAwardTable,
    hasExpandingWild: tuneConfig.hasExpandingWild,
    // Cascade-mechanic-only (undefined/no-op for a line-pay tuneConfig - see SpinSimulator.js's
    // tuneFrequencies doc): the gameplay mechanic + free-spins mode to measure candidates
    // against, plus the cluster-evaluator "recipe" runTuneFrequenciesWithPool needs since a
    // cascade winEvaluator is a per-game closure, not a reusable named function (see
    // mechanicRegistry.js's own doc).
    mechanic: tuneConfig.mechanic,
    freeSpinsMode: tuneConfig.freeSpinsMode,
    minClusterSize: tuneConfig.minClusterSize,
    scatterTriggerCount: tuneConfig.scatterTriggerCount,
    reelLength: parseInt(inputs.reelLength.value, 10) || tuneConfig.reelLength,
    targetRtp: parseFloat(inputs.targetRtp.value) || 96,
    rtpTolerancePct: parseFloat(inputs.rtpTolerancePct.value) || 1.5,
    // The panel's own unit ("one bonus every N spins") converted back to the percentage
    // tuneFrequencies takes. The library API is untouched; only the presentation differs.
    targetTriggerRatePct: spinsPerTriggerToPct(parseFloat(inputs.targetTriggerSpins.value)) || 0.6,
    triggerRateTolerancePct: parseFloat(inputs.triggerRateTolerancePct.value) || 0.15,
    searchSeed: Number.isFinite(parseInt(inputs.searchSeed.value, 10)) ? parseInt(inputs.searchSeed.value, 10) : 12345,
    trialSpins: parseInt(inputs.trialSpins.value, 10) || 300000,
    trialsPerPoint: parseInt(inputs.trialsPerPoint.value, 10) || 3,
    // CMA-ES/Nelder-Mead only need a stable relative ranking while exploring. The panel spends a
    // quarter of the displayed candidate budget on that search, then independently validates its
    // finalists at the full budget below. This cuts the dominant simulation work substantially
    // without presenting the low-fidelity result as the answer.
    searchTrialSpins: Math.max(10000, Math.round((parseInt(inputs.trialSpins.value, 10) || 300000) / 4)),
    searchTrialsPerPoint: 1,
    // Number.isFinite (not `|| 1`) so an explicit 0 - "no measurement uncertainty at all
    // tolerated" - isn't silently overridden by the fallback the way `0 || 1` would.
    maxRtpStdError: Number.isFinite(parseFloat(inputs.maxRtpStdError.value)) ? parseFloat(inputs.maxRtpStdError.value) : 1,
    maxIterations: parseInt(inputs.maxIterations.value, 10) || 150,
    orderingPenaltyWeight: parseFloat(inputs.orderingPenaltyWeight.value) || 0.5,
    limitPenaltyWeight: parseFloat(inputs.limitPenaltyWeight.value) || 0.5,
    uniformityPenaltyWeight: parseFloat(inputs.uniformityPenaltyWeight.value) || 0,
    stdErrorPenaltyWeight: parseFloat(inputs.stdErrorPenaltyWeight.value) || 0,
    triggerRatePenaltyWeight: parseFloat(inputs.triggerRatePenaltyWeight.value) || 0,
    spacingPenaltyWeight: parseFloat(inputs.spacingPenaltyWeight.value) || 0,
    initialWeightStrategy: inputs.initialWeightStrategy.value,
    searchAlgorithm: inputs.searchAlgorithm.value,
    // The interactive tool must never present the optimizer's luckiest training draw as a
    // finished tune. Library callers can opt out for batch/backwards-compatible use, but panel
    // results are always ranked on fresh holdout trials.
    finalValidation: true,
    reelCoupling: inputs.reelCoupling.value,
    // Which denomination the weights above are in. The panel defaults to normalized (the library
    // to raw), because the named levels in the shape section are only meaningful against
    // normalized penalties - see core/simulation/SpinSimulator.js's own penaltyNormalization doc.
    penaltyNormalization: inputs.penaltyNormalization.value,
    // Empty string means "No preference", which must reach the engine as null rather than as a
    // band nothing satisfies - the penalty is inert with no target, whatever its weight.
    targetVolatility: inputs.targetVolatility.value || null,
    // On only when a band was actually chosen. 'Prefer'-strength: volatility is genuinely hard to
    // move from frequencies alone (see the control's own tooltip), so a heavier default would buy
    // a worse RTP for a volatility that barely shifted.
    volatilityPenaltyWeight: inputs.targetVolatility.value ? 1 : 0,
    // On in the panel, off in the library. ~30 extra measurements is right for a developer who
    // just clicked TUNE and wrong for every programmatic caller that never asked for it.
    // Only for a DIAGNOSIS. This used to be unconditionally true, so every START TUNING silently
    // re-ran the whole Phase 0c sweep and Phase 0d grid - about 26 seconds of work you may have
    // just done deliberately - before any searching began. The two buttons now do two jobs with no
    // overlap, and the diagnosis panel simply stays on screen from the last check.
    measureSensitivity: diagnoseOnly,
    // Explicit rather than the library's implicit trialSpins/4. How carefully candidates are
    // measured and how carefully the structural KNOBS are measured are different questions:
    // one wants a converged RTP, the other wants a ranking, and tying them together means you
    // cannot make the diagnosis fast without also making the tune untrustworthy.
    sensitivitySpins: parseInt(inputs.sensitivitySpins.value, 10) || 50000,
    // A checkbox, so `.checked` rather than `.value` - and gated on `!diagnoseOnly` because the
    // solve runs AFTER the search, off the final frequencies. A diagnosis has no final
    // frequencies; the exact scale from HERE is already in the sensitivity report's routes.
    solvePayoutScale: !diagnoseOnly && inputs.solvePayoutScale.checked,
    // Unlike the payout solve, this one runs for a DIAGNOSIS too - it needs no search result, only
    // Phase 0c's ladders, and "here is a combination that hits your target" is precisely the sort
    // of answer that should change the settings you hand a search rather than arriving after one.
    tuneStructural: (diagnoseOnly && inputs.tuneStructural.checked) ? { respectDesignIntent: true } : false,
    winEvaluatorFactory: tuneConfig.winEvaluatorFactory ?? null,
    // Number.isFinite rather than `|| 0.25`, so an explicit 0 - "pin the refinement to the linked
    // answer entirely" - survives instead of being silently replaced by the default.
    maxReelDeviation: Number.isFinite(parseFloat(inputs.maxReelDeviation.value))
      ? parseFloat(inputs.maxReelDeviation.value) : 0.25,
    // Direction (dropdown, -1/1/0) times this reel's own Strength input (default 1) - a
    // strength of 0 mutes the preference the same way "No preference" does, without losing
    // the dropdown's own selection; above 1 enforces it harder than the shared Ordering
    // Penalty Weight alone would. tuneFrequencies already supports any magnitude here, not
    // just -1/0/1 (see its own orderingBiasByReel doc) - this just exposes that per reel.
    orderingBiasByReel: biasSelects.map((el, r) => {
      const rawStrength = parseFloat(biasStrengthInputs[r].value);
      return parseInt(el.value, 10) * (Number.isFinite(rawStrength) ? rawStrength : 1);
    }),
  };

  // Every control in the panel, not a hand-maintained list. `inputs` only ever held the ones
  // readTuneOptions reads, so anything added beside them stayed live mid-run - the intent
  // dropdowns did exactly that, and changing one during a search silently rewrote the raw weight
  // the run was already using. Buttons are excluded (STOP has to stay clickable) and so is the
  // readonly output textarea, which must stay selectable to be copied from.
  const formControls = () => Array.from(tuneContainer.querySelectorAll('input, select'))
    .filter(el => el.type !== 'button' && el.id !== 'tune-paytable-output');
  formControls().forEach(el => { el.disabled = true; });
  biasSelects.forEach(el => { el.disabled = true; });
  biasStrengthInputs.forEach(el => { el.disabled = true; });
  startBtn.disabled = true;
  if (diagnoseBtn) diagnoseBtn.disabled = true;
  startBtn.textContent = diagnoseOnly ? 'CHECKING...' : 'TUNING...';
  if (diagnoseOnly && diagnoseBtn) diagnoseBtn.textContent = 'CHECKING...';
  stopBtn.style.display = 'inline-block';
  stopBtn.disabled = false;
  stopBtn.textContent = 'STOP';
  resultsEl.innerHTML = '';
  logEl.style.display = 'block';
  logEl.innerHTML = '';
  // A diagnosis measures no candidates, so the per-candidate stats cards have nothing to show and
  // would sit at "—" for the whole run, reading as a search that never got going.
  liveStatsEl.style.display = diagnoseOnly ? 'none' : 'grid';
  liveStatsCurrentEl.textContent = '—';
  liveStatsCurrentStepEl.textContent = '';
  liveStatsCurrentProgressBarEl.style.width = '0%';
  liveStatsBestEl.textContent = '—';
  liveStatsBestImprovedEl.innerHTML = '';
  tuneLog.length = 0;
  bestLogOpen = false;
  renderTuneLog();
  liveStatsViolationsEl.textContent = '—';
  // Hidden for a diagnosis: it renders the per-reel frequencies with "current"/"best" gauges, and
  // a diagnosis produces neither. Left visible it says a tune happened when none did.
  liveTableEl.style.display = diagnoseOnly ? 'none' : 'block';
  liveTableEl.innerHTML = renderLiveFrequencyTable(reelFrequencyTables, boundsByReel, testedRangeByReel, null, null, paytable);

  // `style` is applied to the row element rather than accepting markup in `line`: log text is
  // built from config values (symbol names straight out of a game's paytable), and there is no
  // reason to route developer-authored strings through innerHTML to colour a line.
  const appendLog = (line, style = null) => {
    const row = document.createElement('div');
    row.textContent = line;
    if (style) Object.assign(row.style, style);
    logEl.appendChild(row);
    logEl.scrollTop = logEl.scrollHeight;
  };

  // Printed before anything else on a continued run so the user can immediately compare it
  // against the previous round's own "Achieved RTP" line, instead of having to trust that the
  // reel tables underneath actually carried over - the search DOES start from this exact
  // baseline (see startTuning's own continueBtn handler below, and tuneFrequencies' initialPoint
  // construction), but a fresh Nelder-Mead search fans out an exploratory initial simplex around
  // it immediately, so the very next log lines' `current:` values can look nothing like this
  // number even though `best:` stays anchored here until an actual improvement is found - without
  // this line that fan-out alone reads as "it reset," especially on a high-variance mechanic
  // where `current` swings wildly step to step (see varianceText's own doc further below).
  if (continuedFrom) {
    appendLog(`Continuing from previous result: RTP=${continuedFrom.rtp.toFixed(2)}%${continuedFrom.varianceText}  trigger=${continuedFrom.triggerRatePct.toFixed(3)}%`);
  }

  // A 'busy' event (see tuneFrequencies' own doc) can fire more than once for the same
  // shrink/widen-probe - identified by `key` (iteration+operation) - as it progresses. Updating
  // the same row in place instead of appending a new one each time is what keeps this from
  // turning into a wall of near-duplicate lines for one slow step.
  let lastBusyRow = null, lastBusyKey = null;
  // Tracks the previous progress event's best-so-far, so each new one can be compared against
  // it to say WHAT actually moved (RTP error, measurement reliability, ordering/limit/uniformity
  // violations), by how much, and at which step - rather than just "here's a number again".
  // `previousBestCandidateRef` is what actually detects "did best just change" (by object
  // identity - see its own comment further below); `lastBestChangeStep`/`lastBestChangeSummary`
  // are what's actually rendered, and deliberately only get overwritten when it does, so the
  // displayed summary persists across every other tick instead of blanking out. All reset fresh
  // on every START TUNING click, same as every other per-run tracker above.
  let previousBestSnapshot = null;
  let previousBestCandidateRef = null;
  let lastBestChangeStep = null;
  let lastBestChangeSummary = [];
  const appendOrUpdateBusyLog = (key, line) => {
    if (lastBusyRow && lastBusyKey === key) {
      lastBusyRow.textContent = line;
    } else {
      lastBusyRow = document.createElement('div');
      lastBusyRow.textContent = line;
      logEl.appendChild(lastBusyRow);
      lastBusyKey = key;
    }
    logEl.scrollTop = logEl.scrollHeight;
  };

  try {
    const initialWeightStrategyLabels = {
      provided: 'configured baseline', uniform: 'random, uniform', normal: 'random, normal',
    };
    // Shared by the 'initial' preview event and every 'shape' iteration - folds the just-tried
    // candidate's trial reel tables into the running tested-range tracker (the best-ever
    // `bestTrial` was already tested in some earlier step, so it never needs to widen the
    // tracked range itself) and re-renders the live gauges. `bestTrial` is `null` for the
    // 'initial' preview (nothing has been measured yet, so there's no best to show).
    const updateLiveTable = (trial, bestTrial, bestOrderingViolations = [], bestLimitViolations = []) => {
      trial.forEach((reelTableWrapper, reelIdx) => {
        const symbolsTable = reelTableWrapper.symbols || reelTableWrapper;
        const range = testedRangeByReel[reelIdx];
        Object.keys(symbolsTable).forEach(symbol => {
          const freq = symbolsTable[symbol].frequency;
          const prev = range[symbol];
          range[symbol] = prev ? { min: Math.min(prev.min, freq), max: Math.max(prev.max, freq) } : { min: freq, max: freq };
        });
      });
      liveTableEl.innerHTML = renderLiveFrequencyTable(reelFrequencyTables, boundsByReel, testedRangeByReel, trial, bestTrial, paytable, bestOrderingViolations, bestLimitViolations);
    };

    const { reelFrequencyTables: tunedReelTables, rtp, triggerRatePct, scaledPaytable, diagnostics } = await runTuneFrequenciesWithPool(paytable, reelFrequencyTables, options,
      (phase, i, mult, r, best) => {
        // Every reported RTP is shown WITH its own measurement uncertainty attached, always -
        // never a bare number on its own. With only 1 trial there's no repeat measurement to
        // compute variance FROM at all (not "zero variance" - genuinely no information), so
        // that's said explicitly rather than printing a misleading "±0.00%". Otherwise this is
        // always the candidate's std dev across its trialsPerPoint repeats plus the raw
        // min-max range, regardless of how small or large it happens to be - a consistently
        // present figure is what lets a large one actually stand out, instead of only
        // appearing sometimes and inviting the assumption that "no figure" means "no problem".
        // Defined up front (not just where it's first used) so the 'restart' handler below can
        // use it too.
        const varianceLabelFor = (candidate) => {
          if (options.trialsPerPoint <= 1) return ' (1 trial - variance unknown)';
          if (candidate.trialRtpStdDev == null) return '';
          return ` (±${candidate.trialRtpStdDev.toFixed(2)}% std dev, ${candidate.trialRtpMin.toFixed(1)}-${candidate.trialRtpMax.toFixed(1)}% range)`;
        };

        // Phase 2 ('shape') candidates are accepted/rejected on a BLENDED loss - RTP error plus
        // weighted ordering/limit/uniformity penalties (see tuneFrequencies' own `makeEvaluate`)
        // - not on RTP alone. Without surfacing that breakdown, a candidate with great RTP and a
        // tiny std dev can appear to be silently ignored when it's actually losing on ordering or
        // limit penalty, which is invisible if only RTP/std-dev are shown. `null` for a Phase 1
        // ('scatter') candidate - gradientDescent1D's result shape has no penalty fields at all
        // (see its own doc), it's judged on trigger-rate error alone.
        // Always shows RAW penalty × weight = contribution explicitly (never just the weighted
        // number alone) - the "Violations (best)" panel further below reports the same
        // orderingPenalty/limitPenalty/uniformityPenalty fields RAW (unweighted, matching the
        // final results' own "N violations remain (totaling X)" convention), so without spelling
        // out the multiplication here too, the same underlying value showing up as two different
        // numbers in two panels reads as a bug (or as the weight silently acting like some kind
        // of cap) rather than the same figure viewed two different ways.
        const lossBreakdownFor = (candidate) => {
          if (candidate.orderingPenalty == null) return null;
          const parts = [`RTP err ${candidate.error.toFixed(4)}`];
          if (options.orderingPenaltyWeight > 0) parts.push(`ordering ${candidate.orderingPenalty.toFixed(4)}×${options.orderingPenaltyWeight}=${(candidate.orderingPenalty * options.orderingPenaltyWeight).toFixed(4)}`);
          if (options.limitPenaltyWeight > 0) parts.push(`limit ${candidate.limitPenalty.toFixed(4)}×${options.limitPenaltyWeight}=${(candidate.limitPenalty * options.limitPenaltyWeight).toFixed(4)}`);
          if (options.uniformityPenaltyWeight > 0) parts.push(`uniformity ${candidate.uniformityPenalty.toFixed(4)}×${options.uniformityPenaltyWeight}=${(candidate.uniformityPenalty * options.uniformityPenaltyWeight).toFixed(4)}`);
          if (options.stdErrorPenaltyWeight > 0) parts.push(`std error ${(candidate.trialRtpStdError ?? 0).toFixed(4)}×${options.stdErrorPenaltyWeight}=${((candidate.trialRtpStdError ?? 0) * options.stdErrorPenaltyWeight).toFixed(4)}`);
          if (options.triggerRatePenaltyWeight > 0) parts.push(`trigger rate ${(candidate.triggerRatePenalty ?? 0).toFixed(4)}×${options.triggerRatePenaltyWeight}=${((candidate.triggerRatePenalty ?? 0) * options.triggerRatePenaltyWeight).toFixed(4)}`);
          if (options.spacingPenaltyWeight > 0) parts.push(`spacing ${(candidate.spacingPenalty ?? 0).toFixed(0)}×${options.spacingPenaltyWeight}=${((candidate.spacingPenalty ?? 0) * options.spacingPenaltyWeight).toFixed(4)}`);
          return `loss ${candidate.loss.toFixed(4)} (${parts.join(', ')})`;
        };

        // Structured version of the same breakdown, for the tune-live-stats boxes' visual
        // proportional bar below (which term is actually dragging loss up, at a glance, rather
        // than only readable by parsing the text breakdown's numbers). `null` for a Phase 1
        // candidate, same as lossBreakdownFor.
        const lossComponentsFor = (candidate) => {
          if (candidate.orderingPenalty == null) return null;
          const components = [
            { label: 'RTP error', raw: candidate.error, weight: 1, color: '#7fbfff' },
          ];
          if (options.orderingPenaltyWeight > 0) components.push({ label: 'ordering', raw: candidate.orderingPenalty, weight: options.orderingPenaltyWeight, color: '#e6b800' });
          if (options.limitPenaltyWeight > 0) components.push({ label: 'limit', raw: candidate.limitPenalty, weight: options.limitPenaltyWeight, color: '#ff8080' });
          if (options.uniformityPenaltyWeight > 0) components.push({ label: 'uniformity', raw: candidate.uniformityPenalty, weight: options.uniformityPenaltyWeight, color: '#c58fff' });
          if (options.stdErrorPenaltyWeight > 0) components.push({ label: 'std error', raw: candidate.trialRtpStdError ?? 0, weight: options.stdErrorPenaltyWeight, color: '#5fd4c4' });
          if (options.triggerRatePenaltyWeight > 0) components.push({ label: 'trigger rate', raw: candidate.triggerRatePenalty ?? 0, weight: options.triggerRatePenaltyWeight, color: '#ff9f5f' });
          if (options.spacingPenaltyWeight > 0) components.push({ label: 'spacing', raw: candidate.spacingPenalty ?? 0, weight: options.spacingPenaltyWeight, color: '#9fd45f' });
          components.forEach(c => { c.contribution = c.raw * c.weight; });
          return components;
        };

        // What actually decides accept/reject - shown as its own clearly labeled, normal-weight
        // line (never a muted footnote the way it used to be) plus a proportional stacked bar of
        // what's contributing to it, so "why is loss what it is" is answerable by looking, not by
        // parsing a dense inline formula. Segment widths are proportional to each term's actual
        // CONTRIBUTION (raw × weight), not its raw magnitude - matching what `loss` itself sums.
        const lossVisualFor = (candidate) => {
          const components = lossComponentsFor(candidate);
          if (!components) return '';
          const total = candidate.loss;
          const bar = components.map(c => {
            const pct = total > 1e-9 ? (c.contribution / total) * 100 : (c.label === 'RTP error' ? 100 : 0);
            const title = `${c.label}: ${c.raw.toFixed(4)}${c.weight !== 1 ? ` × ${c.weight} weight` : ''} = ${c.contribution.toFixed(4)}`;
            return pct > 0 ? `<div title="${title}" style="width: ${pct}%; background: ${c.color}; height: 100%;"></div>` : '';
          }).join('');
          const nonZero = components.filter(c => c.contribution > 1e-9);
          const summary = nonZero.length > 0
            ? nonZero.map(c => `${c.label} ${c.contribution.toFixed(3)}`).join(' + ')
            : 'no penalties';
          return `<div style="margin-top: 6px;">
                     <span style="font-size: 0.68em; color: #ddd; font-weight: 600;">Loss ${total.toFixed(4)}</span>
                     <span style="font-size: 0.58em; color: #888;"> = ${summary}</span>
                     <div style="display: flex; height: 5px; border-radius: 2px; overflow: hidden; margin-top: 3px; background: rgba(255,255,255,0.08);">${bar}</div>
                   </div>`;
        };

        // Fired once, before Phase 1 even runs, with Phase 2's actual starting point (reflecting
        // Initial Frequency Strategy) - without this the live table stayed frozen on the raw
        // baseline all through Phase 1's scatter rounds, making the strategy look like it
        // hadn't taken effect until well after the fact.
        if (phase === 'initial') {
          // The starting point only means something if a search is about to use it.
          if (diagnoseOnly) return;
          appendLog(`Starting point selected (${initialWeightStrategyLabels[options.initialWeightStrategy] || options.initialWeightStrategy})`);
          setPhaseBanner({
            name: 'Phase 0 · Checking the ground',
            strategy: 'measuring what this config pays before changing anything',
            why: 'a target the current structure cannot reach is not a search problem, and it is cheaper to find out now',
          });
          if (r.trial) updateLiveTable(r.trial, null);
          return;
        }
        // The resolved knobs, arriving before any work starts. Nothing is drawn from them - they
        // exist so that anything exported WHILE the run is still going (the tune log's COPY JS and
        // JSON buttons, which are live) carries the parameters that produced it. Waiting for the
        // run to resolve meant a mid-run copy emitted a header of `undefined`s.
        if (phase === 'input-parameters') {
          liveInputParameters = r;
          return;
        }
        // Phase 0a: static config checks, before a single spin is simulated. Rendered first and
        // loudest because an 'error' finding describes a config no amount of tuning can
        // compensate for - the run is about to be refused, and the suggestion is the whole point.
        if (phase === 'validation') {
          diagnosis.validation = r.findings;
          renderDiagnosis();
          const bySeverity = { error: [], warning: [], note: [] };
          r.findings.forEach(f => (bySeverity[f.severity] ?? bySeverity.note).push(f));
          if (bySeverity.error.length > 0) {
            setPhaseBanner({
              name: `Config has ${bySeverity.error.length} error${bySeverity.error.length === 1 ? '' : 's'}`,
              strategy: 'the tune will not start - these describe a config no amount of searching can compensate for',
              why: 'fix them in game.js and run again, or pass skipValidation to tune anyway',
            });
          }
          return;
        }
        // Phase 0c: which structural knob actually moves RTP. The single most useful thing the
        // tuner can say, and it needs no search at all - so it is reported in full before Phase 1
        // starts, not buried in the final diagnostics.
        if (phase === 'sensitivity') {
          if (r.event === 'point') {
            // One line per measurement would be ~30 lines of noise before anything useful; a
            // single updating line keeps the wait explained without burying the report that follows.
            appendOrUpdateBusyLog('sensitivity', `… measuring ${r.knob} = ${r.value} (${r.rtp.toFixed(1)}%)…`);
            setPhaseBanner({
              name: 'Phase 0c · Which knob matters',
              strategy: `sweeping ${r.knob} across its plausible range at even symbol frequencies`,
              why: 'frequencies are the weakest lever this tuner has - this measures the ones that are not, before spending any budget on a search',
              progress: `${r.knob} ${r.value}`,
            });
          } else if (r.event === 'complete') {
            diagnosis.sensitivity = r;
            renderDiagnosis();
            // One line in the log, pointing at the panel - so someone reading the log knows the
            // report exists and where it went, without the report itself scrolling away.
            const top = r.knobs?.find(k => !k.flat && !k.measurementUnreliable);
            appendLog(top
              ? `✓ Sensitivity swept - highest leverage: ${top.knob} (${top.elasticityRtpPerUnit.toFixed(1)}pp per unit). Full report above.`
              : '✓ Sensitivity swept - see the report above.');
          }
          return;
        }
        if (phase === 'loss-preview') {
          diagnosis.lossPreview = r;
          renderDiagnosis();
          appendLog(r.rtpIsDominant
            ? `✓ Loss budget: RTP error is the largest term (${r.terms[0].contribution.toFixed(2)} of ${r.total.toFixed(2)}).`
            : `⚠ Loss budget: ${r.terms[0].label} outweighs RTP error — the search will trade RTP away for it. See the panel above.`);
          return;
        }
        if (phase === 'structural') {
          if (r.event === 'point') {
            const shown = Object.entries(r.knobs).map(([k, v]) => `${k}=${v}`).join(' ');
            appendOrUpdateBusyLog('structural', `… trying ${shown} (${r.rtp.toFixed(1)}%)…`);
            setPhaseBanner({
              name: 'Phase 0d · What to set them to',
              strategy: `measuring the combinations Phase 0c's ladders rank closest to target`,
              why: 'the structural knobs interact - maxStack does nothing if stackChance is too low to make runs for it to cap - so the best combination is not the best of each knob picked separately',
              progress: shown,
            });
          } else if (r.event === 'complete') {
            diagnosis.structuralRecommendation = r;
            renderDiagnosis();
            appendLog(r.reachedTarget
              ? `✓ Structural recommendation found (${r.measuredRtp.toFixed(2)}% measured, ${r.measurementsUsed} combinations tried). See the panel above.`
              : `⚠ No structural combination reached target - closest ${r.measuredRtp != null ? `${r.measuredRtp.toFixed(2)}%` : 'n/a'}. See the panel above.`);
          }
          return;
        }
        // Phase 2's strategy handover. The engine announces which search is about to run, what it
        // is allowed to move, and why - so a two-stage run reads as two deliberate stages rather
        // than as one long list of steps whose meaning silently changed partway through.
        if (phase === 'coupling-stage') {
          const stageName = { linked: 'Same mix on every reel', refine: 'Vary slightly per reel', independent: 'Independent per reel' }[r.stage] ?? r.stage;
          if (r.event === 'start') {
            currentStage = r.stage;
            const phaseLabel = r.onlyStage ? 'Phase 2' : (r.stage === 'linked' ? 'Phase 2a' : 'Phase 2b');
            // Phrased per stage rather than from one template: "84 weights (of 12 possible)" is
            // what a shared template produced for the refinement, and it reads as nonsense because
            // `comparedTo` means opposite things in the two directions - a reduction going in, and
            // the thing being reopened coming out.
            const scope = r.stage === 'linked' && r.comparedTo != null
              ? `${r.dimensions} shared weights, one per symbol, in place of ${r.comparedTo} per-reel ones`
              : r.stage === 'refine'
              ? `all ${r.dimensions} per-reel weights, reopened from the ${r.comparedTo} shared ones`
              : `${r.dimensions} weight${r.dimensions === 1 ? '' : 's'}`;
            appendLog(`▶ ${phaseLabel} - ${stageName}: searching ${scope}, up to ${r.iterationBudget} iterations. ${r.strategy}.`);
            setPhaseBanner({
              name: `${phaseLabel} · ${stageName}`,
              strategy: `${r.strategy} — ${r.dimensions} free weight${r.dimensions === 1 ? '' : 's'}, up to ${r.iterationBudget} iterations`,
              why: r.why,
              progress: `targeting RTP ${options.targetRtp}% ±${options.rtpTolerancePct}`,
            });
          } else if (r.event === 'skipped') {
            appendLog(`⤼ Phase 2b - ${stageName} skipped: ${r.why}`);
          } else if (r.event === 'end') {
            if (r.accepted != null) {
              // The comparison that decides whether the reels stay on one mix. Both figures are
              // measured under one common seed (see tuneFrequencies) so the difference is real
              // rather than two Monte Carlo draws being read against each other.
              appendLog(`${r.accepted ? '✓' : '✗'} Phase 2b - per-reel refinement ${r.accepted ? 'ACCEPTED' : 'REJECTED'}: shared ${r.linkedRtp.toFixed(2)}% (loss ${r.linkedLoss.toFixed(4)}) vs per-reel ${r.refinedRtp.toFixed(2)}% (loss ${r.refinedLoss.toFixed(4)}). ${r.why}.`);
            } else {
              appendLog(`■ ${stageName} finished after ${r.iterationsUsed} iterations at RTP ${r.rtp.toFixed(2)}% (error ${r.error.toFixed(4)}) - ${r.reason}.`);
            }
          }
          return;
        }
        // Phase 0: this game's own minGap spacing cannot be honored at this reel length, and
        // generateReel fails at it SILENTLY (best-effort, then gives up). Logged loudly and
        // first, before any tuning output, because no amount of tuning or penalty weighting can
        // fix it - the arithmetic simply doesn't allow it.
        // Phase 0b: what an EVEN symbol distribution actually pays. This is the number that says
        // whether the search is about to be forced into producing over-abundant symbols: if even
        // frequencies fall far short of target, concentrating symbols is the only route the
        // frequency search has, and the lopsided reels that come out are the optimizer doing its
        // job rather than misbehaving. The fix in that case is a structural one (on a cluster
        // game, usually how readily symbols stack), not a tuning weight.
        if (phase === 'headroom') {
          // Also lands in the diagnosis panel, where it sits beside the sensitivity sweep that
          // answers the question it raises ("what do I change instead of frequencies?").
          diagnosis.structuralHeadroom = r;
          renderDiagnosis();
          const noisy = options.trialSpins < 50000 || options.trialsPerPoint < 2;
          const caveat = noisy
            ? ` (single measurement at ${options.trialSpins.toLocaleString()} spins × ${options.trialsPerPoint} trial${options.trialsPerPoint === 1 ? '' : 's'} - treat as a rough read; raise Trial Spins for a number worth acting on)`
            : '';
          if (r.reachableWithEvenFrequencies) {
            appendLog(`✓ Structural headroom: an even symbol distribution already pays ${r.uniformRtp.toFixed(2)}% against a ${r.targetRtp}% target - no skew needed to reach it${caveat}.`);
          } else if (r.uniformRtp < r.targetRtp) {
            // The problematic direction: frequencies are all the main search can move, so the only
            // way it can make up the shortfall is by concentrating symbols.
            appendLog(`⚠ Structural headroom: an even symbol distribution pays only ${r.uniformRtp.toFixed(2)}% against a ${r.targetRtp}% target - ${r.shortfallFactor.toFixed(2)}× short${caveat}.`);
            appendLog(`   … frequencies are the only thing the main search can move, so it will have to CONCENTRATE symbols by roughly that factor to make up the difference. Expect over-abundant symbols and broken reel spacing - that is the search compensating, not malfunctioning.`);
            appendLog(`   … to fix it properly, change how wins FORM rather than how often symbols appear: on a cluster game raise stackChance / minStack (measured on Candy Frenzy: stackChance 0.10 pays 9.7% at even frequencies, 0.50 pays 94.5%), or scale the paytable's payout multipliers - RTP is exactly proportional to them.`);
          } else {
            // Overshooting is the comfortable direction - there is no pressure to concentrate
            // anything, so it must not be reported with the shortfall warning's advice.
            appendLog(`ℹ Structural headroom: an even symbol distribution pays ${r.uniformRtp.toFixed(2)}%, ABOVE the ${r.targetRtp}% target${caveat}.`);
            appendLog(`   … that is the comfortable direction - the search has room to come down and no reason to concentrate symbols to reach RTP. If it still produces over-abundant symbols, look at the ordering/uniformity weights rather than at RTP pressure.`);
          }
          return;
        }
        if (phase === 'feasibility') {
          appendLog(`⚠ REEL CONSTRAINTS CANNOT BE SATISFIED - ${r.infeasible.length} symbol/reel pair${r.infeasible.length === 1 ? '' : 's'} need more room than a ${r.reelLength}-position strip has:`);
          r.infeasible.slice(0, 8).forEach(v => {
            appendLog(`   • reel ${v.reel + 1} "${v.symbol}" needs ${v.runs} separate runs but minGap ${v.minGap} allows at most ${v.ceiling} (frequency ${v.frequency.toFixed(4)})`);
          });
          if (r.infeasible.length > 8) appendLog(`   • …and ${r.infeasible.length - 8} more`);
          appendLog(`   … generateReel spaces symbols BEST-EFFORT and silently gives up when it runs out of room, so these reels will clump more than the config asks - on a cluster-pays game that directly inflates cluster wins and RTP.`);
          appendLog(`   … tuning cannot fix this. Either lower minGap, raise Reel Length, or bring that symbol's frequency down (a symbol needing N runs requires reelLength >= N x minGap).`);
          return;
        }
        // Phase 1b: the shared multiplier couldn't land inside the target band (all reels step
        // together, so the trigger rate can only move in whole-lockstep jumps), and the search is
        // now walking ONE trigger symbol at a time across individual reels to fill the gap
        // between two of those jumps. Logged per step because the per-reel counts are the
        // interesting part - this is where an uneven distribution gets introduced.
        if (phase === 'scatter-refine') {
          appendLog(`   ↳ Phase 1b refine ${i + 1}: per-reel trigger counts [${r.counts.join(', ')}] → trigger ${r.triggerRate.toFixed(3)}% (target ${r.target}% ±${r.tolerance}, off by ${r.error.toFixed(3)}pp)`);
          return;
        }
        // Fired once, at the Phase 1 -> Phase 2 handover. Phase 1 finishing SHORT of the target
        // trigger rate is a normal outcome rather than a malfunction - the reachable trigger
        // rates form a coarse lattice, so the target can simply not exist (see bisect1D in
        // core/simulation/SpinSimulator.js) - but without saying so here the log runs straight on into
        // Phase 2's steps and reads as the phase quietly giving up. It also matters that this is
        // FINAL: Phase 2 excludes trigger symbols from its search entirely, so nothing later in
        // the run will revisit it.
        if (phase === 'scatter-complete') {
          const pct = (v) => v == null ? '?' : `${v.toFixed(3)}%`;
          if (r.converged) {
            appendLog(`✓ Phase 1 done - trigger rate ${pct(r.triggerRate)} (target ${pct(r.target)} ±${r.tolerance}, multiplier ×${mult.toFixed(4)})${r.refinedPerReelCounts ? `, with per-reel trigger counts [${r.refinedPerReelCounts.join(', ')}] - a shared multiplier alone could not land in the band` : ''}. Moving on to Phase 2: per-symbol reel weights.`);
          } else {
            // NB: deliberately does NOT claim the trigger rate is settled. Phase 2 never tunes a
            // trigger symbol's own frequency, which makes the trigger rate final for a line-pay
            // game - but NOT for a cascade mechanic, where the other symbols' weights control
            // cascade depth and every cascade refills the grid with fresh chances to draw the
            // scatter. Measured on Candy Frenzy, reweighting candies alone (bonus frequency held
            // byte-identical, each reel's candy budget preserved) moves the trigger rate from
            // 0.75% to 2.04%. Claiming finality here would be actively misleading on exactly the
            // game where this matters most.
            const why = r.reason === 'lattice-gap' && r.bracket
              ? `No multiplier can hit it. Scatter counts are whole positions on a reel strip, so only certain trigger rates exist at all - the two nearest are ${pct(r.bracket.loMetric)} (×${r.bracket.loParam.toFixed(3)}) and ${pct(r.bracket.hiMetric)} (×${r.bracket.hiParam.toFixed(3)}), with nothing in between.`
              : r.reason === 'unreachable-low'
              ? `Even the highest allowed multiplier (×8) only reaches ${pct(r.bracket?.hiMetric)} - the target is above everything reachable.`
              : r.reason === 'unreachable-high'
              ? `Even the lowest allowed multiplier (×0.05) still measures ${pct(r.bracket?.loMetric)} - the target is below everything reachable.`
              : r.reason === 'stopped'
              ? `Stopped by request before it finished.`
              : `Ran out of iterations before landing in the target band.`;
            appendLog(`⚠ Phase 1 stopped at trigger rate ${pct(r.triggerRate)}, ${r.error.toFixed(3)}pp off the ${pct(r.target)} ±${r.tolerance} target (multiplier ×${mult.toFixed(4)}). ${why}`);
            if (r.reason !== 'exhausted' && r.reason !== 'stopped') {
              appendLog(`   … to change this: widen Trigger Rate Tolerance, pick a target that exists (see the two nearest above), or raise the game's reel strip length so the reachable rates sit closer together. More tuning iterations will not help.`);
            }
          }
          return;
        }
        // A stalled round restarting with a wider step is otherwise invisible here - the next
        // 'shape' log line looks identical whether or not a restart just happened underneath it.
        // Separately from the stall itself, `candidateAccepted` (tuneFrequencies' own doc, next
        // to where beatsIncumbent is called) says whether the round that just stalled actually
        // became the new overall best - a round can produce a great-looking result and still
        // lose to a noisier prior incumbent if its improvement doesn't clear the combined
        // measurement-noise margin (see `bestAcceptanceZ`'s own doc), which otherwise looks
        // identical to "nothing changed" from here.
        if (phase === 'restart') {
          appendLog(`⚠ Round stalled - restarting with a wider step (stepSize=${r.stepSize.toFixed(4)}, stall ${r.stallStreak}/${r.maxStallRestarts} in a row, ${r.restarts} restart${r.restarts === 1 ? '' : 's'} total${r.willStopNow ? ' - giving up after this' : ''})`);
          if (r.candidateAccepted === false && r.roundResult) {
            appendLog(`   … this round's own best (RTP=${r.roundResult.rtp.toFixed(2)}%${varianceLabelFor(r.roundResult)}) was NOT accepted as the new overall best - its improvement wasn't large enough to clear the combined measurement-noise margin against the current best (raise Max RTP Std Error if this much uncertainty is acceptable, or raise Trial Spins/Trials Averaged to shrink it instead)`);
          }
          return;
        }
        // Explains an otherwise-silent, unusually long gap between two ordinary progress lines
        // (a Nelder-Mead simplex shrink re-evaluating every vertex, a CMA-ES generation
        // evaluating its whole population, or a gradient-descent plateau-widening retry). Only
        // fires again while that same operation is still running, throttled server-side to at
        // most once every busyReportIntervalMs - updating the same row in place (rather than
        // appending a new one per update) keeps a slow step from turning into a wall of
        // near-duplicate lines.
        if (phase === 'busy') {
          const label = r.sourcePhase === 'scatter' ? `Scatter frequency ${i + 1}` : `Step ${i + 1}`;
          const message = r.operation === 'shrink'
            ? (r.verticesEvaluated != null
              ? `still working - simplex shrinking (${r.verticesEvaluated}/${r.verticesToEvaluate} candidates evaluated)...`
              : `still working - simplex shrinking, re-evaluating ${r.verticesToEvaluate} candidates...`)
            : r.operation === 'generation'
            ? (r.verticesEvaluated != null
              ? `still working - evaluating this generation's population (${r.verticesEvaluated}/${r.verticesToEvaluate} candidates evaluated)...`
              : `still working - evaluating this generation's population (${r.verticesToEvaluate} candidates)...`)
            : r.operation === 'bracket'
            ? `still working - measuring the ${r.endpoint === 'max' ? 'highest' : 'lowest'} allowed multiplier to bracket the target...`
            : (r.probeAttempt != null
              ? `still working - widening probe to find a measurable slope (attempt ${r.probeAttempt}/8)...`
              : `still working - widening probe to find a measurable slope...`);
          appendOrUpdateBusyLog(`${i}-${r.operation}`, `… [${label}] ${message}`);
          return;
        }
        // Every Phase 2 line carries the stage that produced it. "Step 9" alone is ambiguous in a
        // two-stage run - it could be the shared-weight search or the per-reel refinement, and
        // those mean opposite things about what the numbers below are free to do.
        const stageSuffix = (phase === 'shape' && (r.stage ?? currentStage))
          ? ` [${STAGE_LABELS[r.stage ?? currentStage] ?? (r.stage ?? currentStage)}]` : '';
        const label = phase === 'scatter' ? `Scatter frequency ${i + 1}` : `Step ${i + 1}${stageSuffix}`;
        const multLabel = mult == null ? '' : `  mult=${mult.toFixed(3)}`;
        if (phase === 'scatter') {
          setPhaseBanner({
            name: 'Phase 1 · Free-spin trigger rate',
            strategy: 'scaling the trigger symbol by one shared multiplier, bisecting toward the target',
            why: 'trigger rate is a coarse step function of that multiplier, so bisection cannot overshoot the way a slope-based search does',
            progress: `targeting ${options.targetTriggerRatePct}% ±${options.triggerRateTolerancePct} · measurement ${i + 1}`,
          });
        } else if (phase === 'shape' && phaseProgressEl) {
          phaseProgressEl.textContent = `iteration ${i + 1} · targeting RTP ${options.targetRtp}% ±${options.rtpTolerancePct}`;
        }

        // `r` (Phase 1/'scatter') or `r.attempted` (Phase 2/'shape') is what THIS iteration's
        // own work actually just tried - for 'scatter', gradientDescent1D always reports a
        // freshly-measured candidate every iteration, so `r` itself already is that. For
        // 'shape', `r` is nelderMead's `vertices[0]` - the simplex's best *entering* this
        // iteration, which stays unchanged across a run of iterations that each try something
        // new but fail to beat it; `r.attempted` is the thing actually tried (see nelderMead's
        // own onProgress doc), `null` only when nothing needed trying (already converged).
        // Showing both `current` (what just happened) and `best` (the running best-ever) side
        // by side is what makes a "no improvement" streak read as active search instead of a
        // silent freeze.
        // Everything below describes a measured candidate against the running best. A phase that
        // carries neither - an informational event like 'headroom' or 'feasibility', or any phase
        // added to the engine later before a handler exists here - has nothing to render, and
        // must not take the whole tune down trying. (It did exactly that: 'headroom' was emitted
        // with best=null and fell through to `best.result`, aborting the run with a TypeError.)
        if (!best) return;

        const current = phase === 'scatter' ? r : r.attempted;
        const currentLossBreakdown = current ? lossBreakdownFor(current) : null;
        const currentLabel = current
          ? `current: RTP=${current.rtp.toFixed(2)}%${varianceLabelFor(current)}  trigger=${current.triggerRate.toFixed(3)}%  err=${current.error.toFixed(4)}${currentLossBreakdown ? `  ${currentLossBreakdown}` : ''}`
          : `current: (already converged - nothing new to try this step)`;

        // gradientDescent1D's own `best` is shaped `{mult, error, result, trial}` (rtp/
        // triggerRate/trialRtp* live under `.result`), while nelderMead's is a full vertex
        // object with them directly on top - normalized here so this one line works for both
        // phases.
        const bestCandidate = best.result ?? best;
        const bestLossBreakdown = lossBreakdownFor(bestCandidate);
        const bestLabel = `best: RTP=${bestCandidate.rtp.toFixed(2)}%${varianceLabelFor(bestCandidate)}  trigger=${bestCandidate.triggerRate.toFixed(3)}%  err=${best.error.toFixed(4)}${bestLossBreakdown ? `  ${bestLossBreakdown}` : ''}`;

        appendLog(`[${label}]${multLabel}  ${currentLabel}  |  ${bestLabel}`);

        // Phase 2 only (lossBreakdownFor is null for a Phase 1/'scatter' candidate, which has no
        // penalty terms to blame) - explains a "why didn't that obviously-good RTP become best"
        // moment by naming whichever penalty term actually cost it, comparing loss component by
        // component against best rather than leaving the reader to do that arithmetic themselves.
        // Computed once and shown BOTH in the log (full numbers) and in the tune-live-stats
        // box below (short form) - the log alone isn't enough since it scrolls out of view on a
        // long run, and this is exactly the kind of "why" a user watching the live stats wants
        // without having to scroll back through it.
        let notPromotedReason = null;
        if (current && current.orderingPenalty != null && current.loss > bestCandidate.loss + 1e-9) {
          const terms = [
            { label: 'RTP error', delta: current.error - bestCandidate.error },
            { label: 'ordering penalty', delta: (current.orderingPenalty - bestCandidate.orderingPenalty) * options.orderingPenaltyWeight },
            { label: 'limit penalty', delta: (current.limitPenalty - bestCandidate.limitPenalty) * options.limitPenaltyWeight },
            { label: 'uniformity penalty', delta: (current.uniformityPenalty - bestCandidate.uniformityPenalty) * options.uniformityPenaltyWeight },
            { label: 'std error penalty', delta: ((current.trialRtpStdError ?? 0) - (bestCandidate.trialRtpStdError ?? 0)) * options.stdErrorPenaltyWeight },
            { label: 'trigger rate penalty', delta: ((current.triggerRatePenalty ?? 0) - (bestCandidate.triggerRatePenalty ?? 0)) * options.triggerRatePenaltyWeight },
            { label: 'spacing penalty', delta: ((current.spacingPenalty ?? 0) - (bestCandidate.spacingPenalty ?? 0)) * options.spacingPenaltyWeight },
          ];
          notPromotedReason = terms.reduce((a, b) => (b.delta > a.delta ? b : a));
          appendLog(`   … not promoted to best - ${notPromotedReason.label} is worse by ${notPromotedReason.delta.toFixed(4)} (loss ${current.loss.toFixed(4)} vs best's ${bestCandidate.loss.toFixed(4)})`);
        }

        // Prominent current/best RTP readout above the live per-symbol table - the log/table
        // below both require reading down a scrolling list or a wide grid to find "where is
        // this run actually at right now", which is the single number a user checking in on a
        // long, slow run (many spins, many symbols) wants first. Same reliability coloring as
        // the final "Achieved RTP" headline (SimulationPanel.js's own results rendering further
        // down): gray when trialsPerPoint is 1 (no variance information exists), red when the
        // candidate's own standard error exceeds Max RTP Std Error (a "converged"-looking number
        // that isn't actually trustworthy), green otherwise.
        const statColor = (candidate) => {
          if (options.trialsPerPoint <= 1) return '#888';
          return (candidate.trialRtpStdError ?? 0) > options.maxRtpStdError ? '#ff8080' : '#7fd97f';
        };
        // The std dev/range figure is the whole point of this box (see maxRtpStdError's own
        // doc for why a "converged"-looking average can still be untrustworthy) - sized and
        // colored to match the headline RTP itself, not tucked away as a muted footnote, so a
        // high-variance reading is as hard to miss as the number it's qualifying. Loss - not
        // RTP - is what actually decides accept/reject (see beatsIncumbent/makeEvaluate's own
        // docs), so it gets its own clearly labeled line plus a proportional bar (lossVisualFor)
        // rather than being buried as a small aside to the RTP figure.
        const statHtml = (candidate, extraLine) => {
          const color = statColor(candidate);
          const varianceText = varianceLabelFor(candidate).trim();
          let html = `<span style="color: ${color};">${candidate.rtp.toFixed(2)}%</span>`;
          if (varianceText) html += `<span style="display: block; font-size: 0.62em; font-weight: 600; color: ${color}; margin-top: 4px; opacity: 0.9;">${varianceText}</span>`;
          html += lossVisualFor(candidate);
          if (extraLine) html += extraLine;
          return html;
        };
        // Current gets an explicit accept/reject verdict every step it carries a real Phase 2
        // candidate (never for the "already converged, nothing tried" case, nor for Phase 1
        // which has no promotion concept at all) - amber "not promoted" naming the losing term
        // (mirrors the log line above), or green "new best" confirmation otherwise, so the
        // question "did that just become the best, and if not why" never requires reading the log.
        const currentVerdict = (current && current.orderingPenalty != null)
          ? (notPromotedReason
            ? `<span style="display: block; font-size: 0.62em; color: #ffb347; margin-top: 6px; font-weight: 600;">⚠ not promoted - ${notPromotedReason.label} worse by ${notPromotedReason.delta.toFixed(4)}</span>`
            : `<span style="display: block; font-size: 0.62em; color: #7fd97f; margin-top: 6px; font-weight: 600;">✓ new best</span>`)
          : '';
        liveStatsCurrentEl.innerHTML = current ? statHtml(current, currentVerdict) : '—';
        liveStatsBestEl.innerHTML = statHtml(bestCandidate);

        // Progress indicator on Current - "where am I in the budget" for a long, slow run. `i`
        // is the absolute iteration/generation count tuneFrequencies already reports (0-based);
        // `options.maxIterations` is the shared budget ceiling both Phase 1 and Phase 2 are
        // configured with, so it's a reasonable approximation of "how deep in" even though the
        // two phases count against it somewhat independently.
        const stepTotal = options.maxIterations;
        const stepNum = Math.min(i + 1, stepTotal);
        liveStatsCurrentStepEl.textContent = `Step ${stepNum} / ${stepTotal}`;
        liveStatsCurrentProgressBarEl.style.width = `${Math.min(100, (stepNum / stepTotal) * 100)}%`;

        // What changed in Best the last time it actually updated, along which axis(es) - RTP
        // error, measurement reliability (std error), or the ordering/limit/uniformity violation
        // penalties already carried on the same candidate object evaluate() returns - by how
        // much, and at which step. Compared by reference (`bestCandidate !== previousBestCandidateRef`),
        // not by re-deriving "did anything change" from the snapshot values themselves: nelderMead/
        // cmaes/gradientDescent1D all only ever reassign their own `best` to a NEW object when a
        // candidate genuinely beat it (see each one's own doc), so reference equality is exactly
        // "did best just update" with no epsilon-guessing needed for that part. This deliberately
        // only recomputes and overwrites the displayed summary WHEN best actually changes - every
        // other tick leaves the previous summary on screen untouched, rather than blanking it out
        // just because nothing new happened this particular step.
        const bestChanged = bestCandidate !== previousBestCandidateRef;
        if (bestChanged) {
          const EPSILON = 1e-9;
          const bestSnapshot = {
            error: best.error,
            stdError: bestCandidate.trialRtpStdError ?? 0,
            orderingPenalty: bestCandidate.orderingPenalty ?? 0,
            limitPenalty: bestCandidate.limitPenalty ?? 0,
            uniformityPenalty: bestCandidate.uniformityPenalty ?? 0,
          };
          const changes = [];
          const compare = (fieldLabel, key, gateOn = true) => {
            if (!gateOn || !previousBestSnapshot) return;
            const delta = previousBestSnapshot[key] - bestSnapshot[key]; // positive = got better (decreased)
            if (Math.abs(delta) < EPSILON) return;
            changes.push({ label: fieldLabel, delta, improved: delta > 0 });
          };
          compare('RTP error', 'error');
          compare('variance', 'stdError');
          compare('ordering', 'orderingPenalty');
          compare('limits', 'limitPenalty');
          compare('uniformity', 'uniformityPenalty', options.uniformityPenaltyWeight > 0);
          lastBestChangeStep = i + 1;
          lastBestChangeSummary = changes;
          previousBestSnapshot = bestSnapshot;
          previousBestCandidateRef = bestCandidate;
          // Recorded HERE rather than in the engine: this is already the one place that knows a
          // new candidate was genuinely accepted (rather than merely evaluated), and the engine
          // has no business keeping a UI history.
          if (bestCandidate.trial) {
            tuneLog.push(createTuneLogEntry({
              index: tuneLog.length + 1,
              step: i + 1,
              stage: currentStage,
              candidate: bestCandidate,
              options,
              reelFrequencyTables: bestCandidate.trial,
            }));
            renderTuneLog();
          }
        }
        const changeListHtml = lastBestChangeSummary.map(c =>
          `<span style="color: ${c.improved ? '#7fd97f' : '#ff8080'};">${c.improved ? '▲' : '▼'} ${c.label} ${c.improved ? 'improved' : 'worsened'} by ${Math.abs(c.delta).toFixed(4)}</span>`
        ).join('<br>');
        const stepLabelHtml = lastBestChangeStep != null
          ? `<span style="display: block; font-size: 0.6em; color: #777; margin-top: ${changeListHtml ? 4 : 0}px;">last accepted at Step ${lastBestChangeStep}</span>`
          : '';
        liveStatsBestImprovedEl.innerHTML = changeListHtml + stepLabelHtml;

        // Live ordering/limit/uniformity readout for the running BEST candidate - the same
        // figures the final results' "N ordering/limit violations remain" paragraphs and
        // "Uniformity penalty remaining" line report, surfaced live instead of only after the
        // run ends. `null` for a Phase 1/'scatter' candidate (see lossBreakdownFor's own doc -
        // no penalty fields exist yet), which leaves the box showing whatever Phase 2 last set,
        // or its initial '—' before Phase 2 has run at all.
        if (bestCandidate.orderingViolations != null) {
          const orderingCount = bestCandidate.orderingViolations.length;
          const limitCount = bestCandidate.limitViolations.length;
          // Raw totals (matching the final results' own "N violations remain (totaling X)"
          // convention) PLUS the weight actually applied and the resulting contribution to
          // `loss` spelled out explicitly - a raw penalty total staying the same size regardless
          // of what Ordering/Limit/Uniformity Penalty Weight is set to is correct (the weight
          // never changes the violation itself, only how much the search cares about it), but
          // showing only the raw number next to a "Weight" input reads as the weight not doing
          // anything - or worse, as if it were some kind of cap on the raw total instead of a
          // multiplier on its contribution to loss.
          const withContribution = (rawTotal, weight) => weight > 0
            ? ` (total ${rawTotal.toFixed(3)} × ${weight} weight = ${(rawTotal * weight).toFixed(3)} loss contribution)`
            : ` (total ${rawTotal.toFixed(3)}, weight is 0 - not counted in loss at all)`;
          const lines = [
            `<span style="color: ${orderingCount > 0 ? '#ff8080' : '#7fd97f'};">${orderingCount} ordering violation${orderingCount === 1 ? '' : 's'}</span>${orderingCount > 0 ? withContribution(bestCandidate.orderingPenalty, options.orderingPenaltyWeight) : ''}`,
            `<span style="color: ${limitCount > 0 ? '#ff8080' : '#7fd97f'};">${limitCount} limit violation${limitCount === 1 ? '' : 's'}</span>${limitCount > 0 ? withContribution(bestCandidate.limitPenalty, options.limitPenaltyWeight) : ''}`,
          ];
          if (options.uniformityPenaltyWeight > 0) {
            lines.push(`<span style="color: #999;">uniformity penalty${withContribution(bestCandidate.uniformityPenalty, options.uniformityPenaltyWeight)}</span>`);
          }
          if (options.stdErrorPenaltyWeight > 0) {
            lines.push(`<span style="color: #999;">std error penalty${withContribution(bestCandidate.trialRtpStdError ?? 0, options.stdErrorPenaltyWeight)}</span>`);
          }
          if (options.triggerRatePenaltyWeight > 0) {
            lines.push(`<span style="color: #999;">trigger rate penalty${withContribution(bestCandidate.triggerRatePenalty ?? 0, options.triggerRatePenaltyWeight)}</span>`);
          }
          liveStatsViolationsEl.innerHTML = lines.join('<br>');
        }

        // Only Phase 2 ('shape') carries a full live candidate reel table (r.trial) - Phase 1
        // ('scatter') only ever scales trigger symbols, which are excluded from Phase 2's
        // search entirely, so every value symbol's frequency is still exactly its baseline
        // value during Phase 1 anyway; nothing to update yet.
        if (phase === 'shape' && r.trial) {
          // r.attempted.trial (see nelderMead's own onProgress doc) is the candidate THIS
          // step's own reflect/expand/contract/shrink actually produced - falls back to r.trial
          // (the simplex's best entering this step) only when nothing needed trying (already
          // converged). best.trial is the overall best-ever candidate found so far - same
          // current/best distinction as the log line above, now shown per symbol too.
          const currentTrial = r.attempted?.trial ?? r.trial;
          updateLiveTable(currentTrial, best.trial, bestCandidate.orderingViolations, bestCandidate.limitViolations);
        }
      }
    );

    // Every reported RTP carries its own measurement uncertainty ALONGSIDE it, always - never
    // a bare percentage on its own. A number like "96.02%" reads as precise and trustworthy by
    // itself even when it's actually the average of trials that individually swung between,
    // say, 20% and 190% - showing the std dev (and raw trial range) right next to it, every
    // time, is what makes that impossible to miss. `finalStdDev == null` only when trialsPerPoint
    // is 1 - no repeat measurement was ever taken, so there's genuinely no variance to report,
    // said explicitly rather than omitted (omitting it would read as "no problem", not
    // "unknown").
    // A diagnosis produced no candidate, so there is no RTP, no convergence and no reel tables to
    // render or copy. It stops here, with the diagnosis panel above already populated - which is
    // the entire output of this action.
    if (diagnoseOnly) {
      appendLog('✓ Config checked. Nothing was tuned and nothing changed - see the report above, then adjust the settings and START TUNING.');
      setPhaseBanner({
        name: 'Config checked',
        strategy: 'no search was run and no frequencies were changed',
        why: 'use the report above to decide what to change before spending a tune on it',
      });
      console.log('Frequency tuner diagnosis:', diagnostics);
      return;
    }

    const finalTrialMin = diagnostics.rtpPhase?.trialRtpMin;
    const finalTrialMax = diagnostics.rtpPhase?.trialRtpMax;
    const finalStdDev = diagnostics.rtpPhase?.trialRtpStdDev;
    const finalStdError = diagnostics.rtpPhase?.trialRtpStdError;
    const hasVarianceData = options.trialsPerPoint > 1 && finalStdDev != null;
    const isUnreliable = hasVarianceData && finalStdError > options.maxRtpStdError;
    const varianceText = options.trialsPerPoint <= 1
      ? ' (1 trial - variance unknown)'
      : (hasVarianceData ? ` (±${finalStdDev.toFixed(2)}% std dev, ${finalTrialMin.toFixed(1)}-${finalTrialMax.toFixed(1)}% range)` : '');

    const rtpConverged = !!diagnostics.rtpPhase?.converged;
    const scatterConverged = diagnostics.scatterPhase == null || !!diagnostics.scatterPhase.converged;
    appendLog(
      diagnostics.rtpPhase?.reason === 'stopped'
        ? `⏹ Stopped by user. Final RTP=${rtp.toFixed(2)}%${varianceText}  trigger=${triggerRatePct.toFixed(3)}%  (whatever the search had found so far, not a completed tune)`
        : rtpConverged && scatterConverged
        ? `Done. Final RTP=${rtp.toFixed(2)}%${varianceText}  trigger=${triggerRatePct.toFixed(3)}%`
        : `⚠ Did NOT converge. Final RTP=${rtp.toFixed(2)}%${varianceText}  trigger=${triggerRatePct.toFixed(3)}%  (this is the closest attempt found, not a successful tune)`
    );
    const finalValidation = diagnostics.rtpPhase?.finalValidation;
    if (finalValidation?.enabled) {
      appendLog(
        `✓ Finalist holdout: re-ranked ${finalValidation.finalistsConsidered} reel set${finalValidation.finalistsConsidered === 1 ? '' : 's'} on ${finalValidation.trialsPerCandidate} fresh trial${finalValidation.trialsPerCandidate === 1 ? '' : 's'} × ${finalValidation.spinsPerTrial.toLocaleString()} spins.`,
        '#7fd97f',
      );
    }
    console.log('Frequency tuner diagnostics:', diagnostics);

    // Colored inline with the headline number itself (green/low-contrast when trustworthy, red
    // when it exceeds Max RTP Std Error, gray when unknown) rather than only in a separate
    // banner further down - the point is that the variance figure travels WITH the RTP number
    // everywhere it's shown, not just in one dedicated spot a reader might skip past.
    const varianceColor = options.trialsPerPoint <= 1 ? '#888' : (isUnreliable ? '#ff8080' : '#7fd97f');
    // Now that the run has resolved, exports can carry the parameters that produced it.
    lastDiagnostics = diagnostics;
    renderTuneLog();

    // "Did I get what I asked for?" first, then "what does that actually feel like?", then the
    // numbers. The diagnostics, the per-iteration table and the log are all still below - their
    // job is reassurance during the wait, not the answer afterwards.
    const roundStats = diagnostics.rtpPhase?.roundStats ?? null;
    const experience = describePlayerExperience(roundStats, {
      bet: (tuneConfig.betPerLine ?? 1) * (tuneConfig.linesCount ?? 1),
      rtp, triggerRate: triggerRatePct, sessionSpins: 500,
    });
    let html = renderTargetChipsHtml({
      rtp, targetRtp: options.targetRtp, rtpTolerancePct: options.rtpTolerancePct,
      triggerRatePct, targetTriggerRatePct: options.targetTriggerRatePct,
      triggerRateTolerancePct: options.triggerRateTolerancePct,
      volatilityClass: experience.volatilityClass,
      targetVolatility: options.targetVolatility ?? null,
    });
    html += renderPlayerExperienceHtml(experience);
    html += `<p style="font-size: 0.85em; color: #ccc; margin: 12px 0 8px;">Achieved RTP: <strong>${rtp.toFixed(2)}%</strong><span style="color: ${varianceColor};">${varianceText}</span> &nbsp;|&nbsp; Free spin trigger rate: <strong>${triggerRatePct.toFixed(3)}%</strong> (1 in ${(100 / triggerRatePct).toFixed(0)})</p>`;

    // Directly under the achieved RTP, because it is a statement ABOUT that number: "this is what
    // the frequencies pay, and here is the exact multiplier that would put it on target". Empty
    // string when the box was unticked, so this line costs nothing when unused.
    html += renderPayoutScaleHtml(diagnostics.payoutScale, { targetRtp: options.targetRtp });

    // A trigger-rate target that no multiplier can reach is a fundamentally different problem
    // from one the search merely ran out of budget on, and it has a different fix - the trigger
    // rate moves in coarse jumps because generateReel rounds each symbol's share to a whole
    // number of strip positions (see bisect1D's own doc in core/tuning/Optimizers.js), so the
    // reachable rates form a sparse lattice and the target can simply fall between two of them.
    // Spelling out the closest achievable rates either side turns an otherwise baffling
    // "did not converge" into an actionable choice: widen the tolerance, move the target onto a
    // value that exists, or lengthen the reel strip to make the lattice finer.
    // Repeated here as well as in the live log because it is the one finding that invalidates
    // everything below it: if the reels physically cannot honor their own spacing config, the
    // measured RTP describes strips that clump more than the game intends, and no weight or
    // iteration count changes that. A dev reading only the summary must still see it.
    const infeasible = diagnostics.reelFeasibility ?? [];
    if (infeasible.length > 0) {
      const rows = infeasible.slice(0, 6).map(v =>
        `<li>reel ${v.reel + 1} <strong>${v.symbol}</strong> — needs ${v.runs} runs, minGap ${v.minGap} allows ${v.ceiling} (freq ${v.frequency.toFixed(4)})</li>`).join('');
      html += `<p style="font-size: 0.8em; color: #ff8080; margin: 8px 0; padding: 8px; background: #2a2a2a; border-left: 3px solid #ff8080;">`
        + `<strong>Reel spacing constraints cannot be satisfied</strong> — ${infeasible.length} symbol/reel pair${infeasible.length === 1 ? '' : 's'} need more room than this strip has. `
        + `generateReel spaces best-effort and <em>silently gives up</em> when it runs out, so these reels clump more than configured — which on a cluster-pays game inflates cluster wins and RTP.`
        + `<ul style="margin: 6px 0 6px 16px; padding: 0;">${rows}</ul>`
        + (infeasible.length > 6 ? `<span style="color:#999;">…and ${infeasible.length - 6} more. </span>` : '')
        + `A symbol needing N runs requires reelLength ≥ N × minGap. Lower minGap, raise Reel Length, or bring that symbol's frequency down — tuning cannot fix it.`
        + `</p>`;
    }

    // Phase 2 can move the trigger rate even though it never tunes a trigger symbol - on a
    // cascade mechanic the other symbols' weights drive cascade depth, and every cascade refills
    // the grid with fresh chances to draw the scatter. If Trigger Rate Penalty Weight is 0 the
    // search had no way to see that happening, so a run can end with a perfectly good RTP and a
    // trigger rate that drifted far off target with nothing flagging it. Surfaced whenever the
    // final rate is out of band and Phase 1 had actually got it in band - i.e. specifically the
    // case where Phase 2 undid Phase 1's work.
    const drift = diagnostics.triggerRateDrift;
    if (drift && !drift.finalWithinTolerance && Math.abs(drift.delta) > drift.tolerance) {
      const phase1WasFine = Math.abs(drift.afterPhase1 - drift.target) <= drift.tolerance;
      html += `<p style="font-size: 0.8em; color: #ff8080; margin: 8px 0; padding: 8px; background: #2a2a2a; border-left: 3px solid #ff8080;">`
        + `<strong>Phase 2 moved the trigger rate off target</strong> - ${drift.afterPhase1.toFixed(3)}% after Phase 1 → <strong>${drift.final.toFixed(3)}%</strong> now (target ${drift.target}% ±${drift.tolerance}, drift ${drift.delta >= 0 ? '+' : ''}${drift.delta.toFixed(3)}pp).`
        + (phase1WasFine ? ' Phase 1 had it inside the band; tuning the other symbols\' weights pushed it back out.' : '')
        + (drift.penaltyWeight > 0
          ? ` Trigger Rate Penalty Weight is ${drift.penaltyWeight} - raise it to make the search defend the trigger rate harder against RTP.`
          : ` <em>Trigger Rate Penalty Weight is 0, so the search could not see this at all.</em> On a cascade game the symbol weights control cascade depth, and every cascade refills the grid with fresh chances to draw the scatter - set that weight above 0 so the trigger rate is part of what the search optimizes.`)
        + `</p>`;
    }

    const sp = diagnostics.scatterPhase;
    if (sp && !sp.converged && sp.reason !== 'stopped') {
      const b = sp.bracket;
      const detail = sp.reason === 'lattice-gap' && b
        ? `The closest achievable rates are <strong>${b.loMetric.toFixed(3)}%</strong> (at multiplier ${b.loParam.toFixed(3)}) and <strong>${b.hiMetric.toFixed(3)}%</strong> (at ${b.hiParam.toFixed(3)}) - nothing in between exists, because scatter counts are whole positions on the reel strip.`
        : sp.reason === 'unreachable-low'
        ? `Even the highest allowed multiplier only reaches <strong>${b?.hiMetric?.toFixed(3) ?? '?'}%</strong>.`
        : sp.reason === 'unreachable-high'
        ? `Even the lowest allowed multiplier still measures <strong>${b?.loMetric?.toFixed(3) ?? '?'}%</strong>.`
        : `The search used its whole iteration budget without landing in the target band.`;
      const fixable = sp.reason === 'exhausted';
      html += `<p style="font-size: 0.8em; color: ${fixable ? '#e6b800' : '#ff8080'}; margin: 8px 0; padding: 8px; background: #2a2a2a; border-left: 3px solid ${fixable ? '#e6b800' : '#ff8080'};">`
        + `<strong>Trigger rate target not met</strong> (${sp.reason}) - closest reachable was ${sp.triggerRate != null ? sp.triggerRate.toFixed(3) : '?'}%, off by ${sp.error.toFixed(3)}pp. ${detail}`
        + (fixable ? '' : ` <em>More tuning iterations cannot fix this</em> - raise the reel strip length for a finer lattice, widen the trigger rate tolerance, or pick a target that is actually reachable.`)
        + `</p>`;
    }

    // Flags a measurement that's plausible-looking but not actually trustworthy - a
    // high-variance mechanic (e.g. a cascade bonus whose multiplier can stack repeatedly,
    // producing rare huge wins) can report a "converged" RTP that's really just whichever way
    // that particular trialsPerPoint sample happened to land, not a reliable read of what the
    // frequencies pay out over a much larger run (this is exactly what a real re-run of RUN
    // SIMULATION would then contradict). Independent of `reason` above - `reason` already
    // factors Max RTP Std Error into whether a candidate counts as 'converged' at all (see
    // tuneFrequencies' own `maxRtpStdError` doc), but this banner spells out WHY (the headline
    // above already carries the actual std dev/range figures) rather than leaving
    // "stalled"/"exhausted" unexplained.
    if (hasVarianceData) {
      html += isUnreliable
        ? `<p style="font-size: 0.8em; color: #ff8080; background: rgba(255,90,90,0.12); padding: 8px; border-radius: 6px; margin-bottom: 10px;">
             <strong>⚠ High measurement variance</strong> (standard error <strong>${finalStdError.toFixed(2)}%</strong>, above the Max RTP Std Error
             setting of ${options.maxRtpStdError}%) - the ${rtp.toFixed(2)}% reported above may just be a lucky/unlucky sample, not a trustworthy
             estimate (this is exactly why it wasn't accepted as a genuine "converged" hit above, regardless of how close the average landed to
             Target RTP). Raise Trial Spins and/or Trials Per Point (now parallelized across a Worker pool, so this is far cheaper than it used to
             be), or raise Max RTP Std Error if this much uncertainty is actually acceptable for this game, and re-tune.
           </p>`
        : `<p style="font-size: 0.75em; color: #888; margin: 0 0 10px;">Standard error ${finalStdError.toFixed(2)}%, within the Max RTP Std Error setting of ${options.maxRtpStdError}% - a reasonably trustworthy measurement.</p>`;
    }

    // Only shown when the user actually asked for uniformity to be enforced - it's a soft
    // steer, never a pass/fail state, so this is informational only (see uniformityPenaltyWeight's
    // own doc for why it never gates the reason banner above/below).
    if (options.uniformityPenaltyWeight > 0 && diagnostics.rtpPhase) {
      html += `<p style="font-size: 0.78em; color: #999; margin: 0 0 10px;">Uniformity penalty remaining: <strong>${diagnostics.rtpPhase.uniformityPenaltyRemaining.toFixed(3)}</strong> (lower means the tunable symbols on each reel ended up closer to an equal split of that reel's budget).</p>`;
    }

    const targetRtp = options.targetRtp;
    const reason = diagnostics.rtpPhase?.reason;
    // Its own distinct, neutral-toned block (not the generic amber warning below) - stopping was
    // an explicit user action, not the search failing to converge, so it shouldn't read like a
    // problem the way 'stalled'/'exhausted' do. Still shows the closest RTP found and how far
    // into the iteration budget the stop landed, same information a caller would want either way.
    if (reason === 'stopped') {
      const rp = diagnostics.rtpPhase;
      html += `<p style="font-size: 0.8em; color: #7fbfff; background: rgba(127,191,255,0.1); padding: 8px; border-radius: 6px; margin-bottom: 10px;">
                 <strong>⏹ Stopped by user</strong> - the closest attempt found is off by ${rp.error.toFixed(2)} percentage points from
                 Target RTP (${targetRtp}%) (used ${rp.iterationsRun} of ${rp.iterationsBudget} iterations before stopping). This is
                 whatever the search had found so far, not a completed tune - CONTINUE TUNING FROM THIS RESULT below picks up right
                 from here if you want to keep going.
               </p>`;
    } else if (reason && reason !== 'converged') {
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

    const violations = diagnostics.rtpPhase?.orderingViolations ?? [];
    if (violations.length > 0) {
      const rows = violations.map(v => {
        const higher = paytable[v.higherPaySymbol]?.friendlyName || v.higherPaySymbol;
        const lower = paytable[v.lowerPaySymbol]?.friendlyName || v.lowerPaySymbol;
        // bias -1 (default) wants higher rarer than lower, so a violation means higher ended
        // up more frequent; bias +1 wants higher no less frequent than lower, so a violation
        // means lower ended up more frequent instead - phrase whichever one actually happened.
        return v.bias < 0
          ? `Reel ${v.reel + 1}: ${higher} is ${v.amount.toFixed(3)} more frequent than ${lower}`
          : `Reel ${v.reel + 1}: ${lower} is ${v.amount.toFixed(3)} more frequent than ${higher} (reel prefers ${higher} more frequent)`;
      });
      html += `<p style="font-size: 0.8em; color: #e6b800; background: rgba(230,184,0,0.1); padding: 8px; border-radius: 6px; margin-bottom: 10px;">
                 <strong>⚠ ${violations.length} ordering violation${violations.length > 1 ? 's' : ''} remain</strong> (accepted to keep RTP close to target):<br>
                 ${rows.join('<br>')}
               </p>`;
    }

    const limitViolations = diagnostics.rtpPhase?.limitViolations ?? [];
    if (limitViolations.length > 0) {
      const rows = limitViolations.map(v => {
        const name = paytable[v.symbol]?.friendlyName || v.symbol;
        return `Reel ${v.reel + 1}: ${name} is ${v.amount.toFixed(3)} past its ${v.bound} limit (${v.limit})`;
      });
      html += `<p style="font-size: 0.8em; color: #e6b800; background: rgba(230,184,0,0.1); padding: 8px; border-radius: 6px; margin-bottom: 10px;">
                 <strong>⚠ ${limitViolations.length} frequency limit violation${limitViolations.length > 1 ? 's' : ''} remain</strong> (accepted to keep RTP close to target):<br>
                 ${rows.join('<br>')}
               </p>`;
    }

    html += renderFrequencyComparisonTables({ reelFrequencyTables, tunedReelTables, paytable });
    html += `<p style="font-size: 0.75em; color: #888; margin-top: 10px;">This is a suggestion only - apply it by replacing FREQUENCY_REEL1/2/3 in game.js and reloading, so REEL_STRIPS regenerates from the new weights. Or keep refining it right here without leaving the panel, using the buttons up top:</p>`;

    html += `<div style="margin-top: 12px;">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
                  <span style="font-size: 0.7em; color: #999; text-transform: uppercase;">Copy-paste ready FREQUENCY_REEL tables${scaledPaytable ? ' + scaled payouts' : ''}</span>
                  <button id="tune-copy-btn" class="btn-icon btn-sim-btn" style="padding: 4px 10px; font-size: 0.75em;">COPY</button>
                </div>
                <textarea id="tune-paytable-output" readonly style="width: 100%; height: 200px; box-sizing: border-box; font-family: monospace; font-size: 0.75em; background: rgba(0,0,0,0.4); color: #ddd; border: 1px solid rgba(255,255,255,0.15); border-radius: 6px; padding: 8px; resize: vertical;"></textarea>
              </div>`;

    resultsEl.innerHTML = html;

    // CONTINUE TUNING / RESET live on #tune-action-row (next to START TUNING, set up once in
    // openTuningPanel) rather than inside #tune-results itself, so they sit on the same
    // line as the button that kicked this run off instead of appearing far below a page of
    // results - built as real elements (not embedded in the `html` string above) since this row
    // persists across runs and needs its previous run's buttons cleared out first.
    const actionRow = tuneContainer.querySelector('#tune-action-row');
    actionRow.querySelectorAll('.tune-result-action').forEach(el => el.remove());

    // Re-runs startTuning with this result as the new baseline (whatever's currently in the
    // form - Target RTP, Trial Spins, etc. - carries over untouched, since none of that is
    // rebuilt here) - lets the user iteratively refine across multiple runs without leaving
    // the panel to copy-paste back into game.js and reload each time.
    const continueBtn = document.createElement('button');
    continueBtn.id = 'tune-continue-btn';
    continueBtn.className = 'btn-icon tune-result-action';
    continueBtn.style.cssText = 'padding: 8px 16px; font-size: 0.85em; background: rgba(255,255,255,0.08); border-color: rgba(255,255,255,0.25); color: #ddd;';
    continueBtn.textContent = 'CONTINUE TUNING FROM THIS RESULT';
    continueBtn.addEventListener('click', () => {
      startTuning({
        paytable, reelFrequencyTables: tunedReelTables, tuneConfig, tuneContainer, originalReelFrequencyTables,
        continuedFrom: { rtp, varianceText, triggerRatePct },
      });
    });
    actionRow.appendChild(continueBtn);

    // Only rendered once a run has actually diverged from the original baseline - lets the user
    // back out of a chain of continued runs without reloading.
    if (reelFrequencyTables !== originalReelFrequencyTables) {
      const resetBtn = document.createElement('button');
      resetBtn.id = 'tune-reset-btn';
      resetBtn.className = 'btn-icon tune-result-action';
      resetBtn.style.cssText = 'padding: 8px 16px; font-size: 0.85em; background: rgba(255,255,255,0.05); border-color: rgba(255,255,255,0.18); color: #aaa;';
      resetBtn.textContent = 'RESET TO ORIGINAL BASELINE';
      resetBtn.addEventListener('click', () => {
        startTuning({ paytable, reelFrequencyTables: originalReelFrequencyTables, tuneConfig, tuneContainer, originalReelFrequencyTables });
      });
      actionRow.appendChild(resetBtn);
    }

    const paytableOutput = resultsEl.querySelector('#tune-paytable-output');
    // Phase 0d's recommendation is applied to the EMITTED output only, and only on request - see
    // formatReelFrequencyTablesForCopy. Held as state here so the button can toggle it.
    let structuralApplied = false;
    const refreshCopyOutput = () => { paytableOutput.value = buildCopyOutput(); };
    const buildCopyOutput = () => formatReelFrequencyTablesForCopy(tunedReelTables, {
      inputParameters: diagnostics.inputParameters,
      rtp,
      triggerRatePct,
      structuralDefaults: structuralApplied ? (diagnostics.structuralRecommendation?.knobs ?? null) : null,
      // Both, not just the table: the scaled ladders are the pasteable artifact, and
      // `payoutScale` is what lets the emitted header say where the number came from and
      // whether measurement actually confirmed it.
      scaledPaytable,
      payoutScale: diagnostics.payoutScale,
    });
    refreshCopyOutput();

    // The recommendation's APPLY button lives on the diagnosis panel (rendered during Phase 0d,
    // long before this output existed), so it is revealed and wired here - the first moment there
    // is something to apply it TO. Toggleable, because a developer who applies it and then wants
    // the as-searched output back should not have to re-run anything to get it.
    const structuralApplyBtn = tuneContainer.querySelector('#tune-structural-apply');
    if (structuralApplyBtn && diagnostics.structuralRecommendation?.changed
        && Object.keys(diagnostics.structuralRecommendation.changed).length > 0) {
      structuralApplyBtn.style.display = 'inline-block';
      structuralApplyBtn.onclick = () => {
        structuralApplied = !structuralApplied;
        structuralApplyBtn.textContent = structuralApplied ? 'APPLIED — CLICK TO UNDO' : 'APPLY TO THE OUTPUT BELOW';
        refreshCopyOutput();
      };
    }

    const copyBtn = resultsEl.querySelector('#tune-copy-btn');
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(paytableOutput.value);
      } catch (err) {
        paytableOutput.select();
      }
      const original = copyBtn.textContent;
      copyBtn.textContent = 'COPIED!';
      setTimeout(() => { copyBtn.textContent = original; }, 1500);
    });
  } catch (error) {
    console.error('Frequency tuning failed:', error);
    appendLog(`Error: ${error.message}`);
  } finally {
    formControls().forEach(el => { el.disabled = false; });
    biasSelects.forEach(el => { el.disabled = false; });
    biasStrengthInputs.forEach(el => { el.disabled = false; });
    startBtn.disabled = false;
    startBtn.textContent = 'START TUNING';
    if (diagnoseBtn) { diagnoseBtn.disabled = false; diagnoseBtn.textContent = 'CHECK MY CONFIG'; }
    stopBtn.style.display = 'none';
  }
}
