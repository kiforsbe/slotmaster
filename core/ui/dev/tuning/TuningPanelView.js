import { showDeveloperPanel } from '../../DeveloperPanels.js';
import { startTuning } from './TuningPanelController.js';
import {
  INTENT_LEVELS, intentToWeight, pctToSpinsPerTrigger, spinsPerTriggerToPct,
  volatilityBandToSigma, weightToIntent,
} from '../../../tuning/Units.js';
import { fmt } from './TuningFormat.js';
import { PENALTY_INTENTS } from './TuningPanelSchema.js';
export function openTuningPanel({ paytable, reelFrequencyTables, tuneConfig, panel }) {
  if (!panel) return;
  let tuneContainer = panel.querySelector('#tune-details');
  if (!tuneContainer) {
    tuneContainer = document.createElement('div');
    tuneContainer.id = 'tune-details';
    tuneContainer.style.marginTop = '20px';
    tuneContainer.style.padding = '15px';
    tuneContainer.style.background = 'rgba(255, 255, 255, 0.1)';
    tuneContainer.style.borderRadius = '12px';
    tuneContainer.style.fontSize = '0.9em';
    panel.appendChild(tuneContainer);

    // Pre-selected default per reel, not a change to tuneFrequencies' own default (which
    // stays -1/"high pay rarer" everywhere unless orderingBiasByReel is passed): splits the
    // reels into thirds by position for a near-miss-shaped starting point - early reels
    // default to favoring high pay more frequent (builds a "you can see it's close" feel),
    // middle reels to the traditional high-pay-rarer direction, late reels to no preference.
    // Still just a default selection - each dropdown can be changed before starting a tune.
    //
    // That near-miss shape is a payline illusion specifically ("premium symbols show up often
    // on the reels you watch land, but rarely align") - meaningless for a cluster-pays cascade
    // game, which has no left-to-right line of sight at all. A cascade tuneConfig (mechanic:
    // CascadeSpinMechanic) defaults every reel to 'No preference' instead.
    const isCascadeMechanic = tuneConfig.mechanic?.name === 'cascade' || tuneConfig.mechanic?.isCascade === true;
    function defaultBiasForReel(r, count) {
      if (isCascadeMechanic) return 0;
      if (count <= 1) return 1;
      const bucket = Math.floor(r * 3 / count);
      return bucket === 0 ? 1 : bucket === 1 ? -1 : 0;
    }

    // Starting weights, in the NORMALIZED denomination the panel defaults to. Ordering and limits
    // start at 'Prefer' and everything else at 'Off', which is the same shape the raw defaults
    // always had (0.5/0.5/0/0/0) - what changes is that the numbers now mean something fixed.
    // A game that configured its own weight keeps it: it lands on whichever named level matches,
    // or on 'Custom' if none does, and Custom is what flips the panel to raw so the game gets
    // exactly what it asked for rather than its number reinterpreted in another denomination.
    const INTENT_DEFAULTS = {
      ordering: 1,
      limit: 1,
      uniformity: 0,
      spacing: tuneConfig.spacingPenaltyWeight ?? 0,
      triggerRate: tuneConfig.triggerRatePenaltyWeight ?? 0,
    };
    const biasSelectorsHtml = Array.from({ length: tuneConfig.reelsCount }, (_, r) => {
      const def = defaultBiasForReel(r, tuneConfig.reelsCount);
      const opt = (value, label) => `<option value="${value}"${def === value ? ' selected' : ''}>${label}</option>`;
      return `
        <div style="display: flex; gap: 6px; align-items: flex-end;">
          <label title="Which direction (if any) this reel's ordering preference pushes higher-paying vs lower-paying symbols - see the explanation below." style="font-size: 0.8em; color: #ccc; flex: 1;">Reel ${r + 1} preference<br>
            <select id="tune-bias-${r}" style="width: 100%; margin-top: 4px;">
              ${opt(1, 'High pay more frequent')}
              ${opt(-1, 'High pay rarer')}
              ${opt(0, 'No preference')}
            </select>
          </label>
          <label title="How strongly this reel's preference is enforced relative to Ordering Penalty Weight - 1 is normal, 0 mutes it without changing the direction dropdown, above 1 pushes harder." style="font-size: 0.8em; color: #ccc; width: 64px;">Strength<br>
            <input id="tune-bias-strength-${r}" type="number" value="1" step="0.1" min="0" max="5" style="width: 100%; margin-top: 4px;">
          </label>
        </div>`;
    }).join('');

    tuneContainer.innerHTML = `
      <!-- 1. WHAT DO YOU WANT - the three things a developer is actually asking for, always
           visible. Everything below this is mechanism and lives behind progressive disclosure. -->
      <div id="tune-section-desire" style="background: rgba(127,191,255,0.07); border: 1px solid rgba(127,191,255,0.25); border-radius: 8px; padding: 10px 12px; margin-bottom: 10px;">
        <div style="font-size: 0.72em; letter-spacing: 0.08em; color: #8fb8ff; text-transform: uppercase; margin-bottom: 8px;">What do you want?</div>
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 12px;">
          <label title="The RTP percent the search tries to hit (e.g. 96 for 96%), and how far either side of it still counts as a hit. Phase 2 stops adjusting once inside that band, balanced against the shaping preferences below." style="font-size: 0.8em; color: #ccc;">Target RTP<br>
            <span style="display: flex; gap: 5px; align-items: center; margin-top: 4px;">
              <input id="tune-target-rtp" type="number" value="96" step="0.5" min="1" style="flex: 1; min-width: 0;">
              <span style="color: #888;">%  ±</span>
              <input id="tune-rtp-tolerance" type="number" value="1.5" step="0.1" min="0.01" style="width: 62px;">
            </span>
          </label>
          <label title="How often free spins should trigger, entered the way it is actually reasoned about - one bonus every N spins - and converted to the percentage the search takes. Only matters if this paytable has a triggerFreeSpins: true symbol. Phase 1 scales that symbol's frequency until the measured rate lands inside the band, before Phase 2 touches anything else. Note the reachable rates form a coarse lattice: a symbol landing only a handful of times on the strip means one whole symbol is a large step, so a target can sit in a gap between two achievable values - Phase 1 reports that as 'lattice-gap' rather than burning its budget on it." style="font-size: 0.8em; color: #ccc;">Free spins about every<br>
            <span style="display: flex; gap: 5px; align-items: center; margin-top: 4px;">
              <input id="tune-target-trigger-spins" type="number" value="${Math.round(pctToSpinsPerTrigger(tuneConfig.targetTriggerRatePct ?? 0.6) ?? 167)}" step="1" min="1" style="flex: 1; min-width: 0;">
              <span style="color: #888;">spins ±</span>
              <input id="tune-trigger-tolerance" type="number" value="0.15" step="0.05" min="0.01" style="width: 62px;">
            </span>
            <span id="tune-trigger-pct-echo" style="display: block; font-size: 0.85em; color: #888; margin-top: 3px;">&nbsp;</span>
          </label>
          <!-- The third thing a developer actually wants, and until now the only one that was
               inexpressible. Named band rather than a raw sigma, converted through TuningUnits so
               the band asked for here and the band reported in the result come from one table. -->
          <label title="How swingy the game should feel, as the standard deviation of the payout per round in bet multiples - the figure the industry quotes as 'volatility'. Low is frequent small wins and shallow swings; High is long dry spells paid for by rare big wins. IMPORTANT CAVEAT: on a cluster-cascade game volatility is dominated by the payout ladder shape and maxStack, NOT by symbol frequencies. Measured on Candy Frenzy, maxStack moves RTP by 255pp per integer step while the whole frequency search is worth about ±10pp, and volatility follows the same pattern. So this target mostly steers CHECK MY CONFIG's structural recommendation and the payout solve. Setting it and pointing the frequency search alone at it will move volatility very little - worth knowing before you spend 150 iterations finding out." style="font-size: 0.8em; color: #ccc;">How swingy should it feel<br>
            <select id="tune-target-volatility" style="width: 100%; margin-top: 4px;">
              <option value="" selected>No preference</option>
              <option value="low">Low — frequent small wins</option>
              <option value="medium">Medium — a mix</option>
              <option value="high">High — rare big wins</option>
            </select>
            <span id="tune-volatility-echo" style="display: block; font-size: 0.85em; color: #888; margin-top: 3px;">&nbsp;</span>
          </label>
        </div>
      </div>

      <!-- 2. HOW THE REELS SHOULD LOOK - shaping preferences and per-reel ordering. Opened
           occasionally: these are design choices, not search mechanics. -->
      <details id="tune-section-shape" open style="margin-bottom: 8px; background: rgba(255,255,255,0.04); border-radius: 8px; padding: 8px 12px;">
        <summary style="font-size: 0.85em; color: #ddd; cursor: pointer; user-select: none;">How the reels should look <span id="tune-summary-shape" style="color: #888; font-size: 0.85em;"></span></summary>
        <div style="margin-top: 10px;">
          <label title="On a CLUSTER-pays game reel index carries no meaning - a cluster forms from grid-adjacent cells, not from a position in a payline - so giving each reel its own free weight per symbol hands the search degrees of freedom nothing in the design asked for and nothing in the loss can justify. That spread IS the over-abundance problem. Measured on Candy Frenzy at 849bc8a: chewy landed at 0.4105 on reel 2 against 0.0056 on reel 3, and those tables paid 74.70% RTP - 27pp WORSE than giving every candy the same frequency (101.48%). 'Same mix' searches one weight per symbol shared across every reel, which makes that spread unrepresentable rather than merely penalized, and cuts Candy Frenzy from 84 search dimensions to 12. 'Same mix, then vary slightly' runs that first and then reopens per-reel weights, bounded to a small deviation around the shared answer, so a deliberate per-reel tilt is still expressible. Line-pay games want 'Different mix' - reel position genuinely does mean something there." style="font-size: 0.8em; color: #ccc;">Should every reel use the same symbol mix?<br>
            <select id="tune-reel-coupling" style="width: 100%; max-width: 420px; margin-top: 4px;">
              <option value="independent"${(tuneConfig.reelCoupling ?? 'independent') === 'independent' ? ' selected' : ''}>Different mix per reel (line-pay games)</option>
              <option value="linked"${tuneConfig.reelCoupling === 'linked' ? ' selected' : ''}>Same mix on every reel</option>
              <option value="linked-then-refine"${tuneConfig.reelCoupling === 'linked-then-refine' ? ' selected' : ''}>Same mix, then vary slightly (cluster games)</option>
            </select>
          </label>
        </div>
        <!-- Named by INTENT rather than by magnitude. "uniformityPenaltyWeight: 5" says nothing
             about what 5 buys; "Insist" says what you want and the now: column says what it
             currently costs. The raw weights still exist and stay authoritative - they moved to
             Advanced, and typing one there sets its dropdown to Custom rather than snapping to a
             named level, because a dropdown that reports something the search is not doing is
             exactly the problem these levels exist to fix. -->
        <table style="width: 100%; border-collapse: collapse; margin-top: 10px; font-size: 0.8em;">
          <thead><tr style="color: #888; font-size: 0.85em; text-transform: uppercase;">
            <th style="text-align: left; padding: 3px 8px 3px 0; font-weight: normal;">The search should</th>
            <th style="text-align: left; padding: 3px 8px 3px 0; font-weight: normal; width: 130px;">How much</th>
            <th style="text-align: left; padding: 3px 0; font-weight: normal;">now</th>
          </tr></thead>
          <tbody>
${PENALTY_INTENTS.map(p => `
            <tr title="${p.title}">
              <td style="padding: 4px 8px 4px 0; color: #ccc;">${p.label}</td>
              <td style="padding: 4px 8px 4px 0;">
                <select id="tune-intent-${p.key}" style="width: 100%;">
                  ${Object.entries(INTENT_LEVELS).map(([name, lvl]) => `<option value="${name}" title="${lvl.hint}">${lvl.label}</option>`).join('')}
                  <option value="custom">Custom…</option>
                </select>
              </td>
              <td id="tune-now-${p.key}" style="padding: 4px 0; color: #9ab; font-size: 0.95em;">—</td>
            </tr>`).join('')}
          </tbody>
        </table>
        <div id="tune-denomination-note" style="font-size: 0.72em; color: #888; margin-top: 6px;"></div>
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px; margin-top: 10px;">
          ${biasSelectorsHtml}
        </div>
        <details style="margin-top: 10px;">
          <summary style="font-size: 0.75em; color: #999; cursor: pointer; user-select: none;">How this search works, and what each option above does ▸</summary>
          <p style="font-size: 0.75em; color: #888; margin: 8px 0 0;">
          Every value symbol on every reel is tuned jointly (one search, not per-reel) via a
          Nelder-Mead simplex search. Each reel has its own ordering preference (above${isCascadeMechanic
            ? `, pre-selected as 'No preference' on every reel - the near-miss shape below only
          makes sense for a payline game's left-to-right line of sight, which a cluster-pays
          cascade grid doesn't have; adjust any of them freely if you want one anyway`
            : `, pre-selected in a near-miss shape - early reels favor high pay more frequent, middle
          reels favor it rarer, late reels no preference - adjust any of them freely`}): "more
          frequent" discourages a higher-paying symbol from being less frequent than a
          lower-paying one on that reel (premium symbols show up often, so lines look close);
          "rarer" is the traditional direction; "no preference" disables it for that reel. It's
          always a soft preference, not an absolute rule - the search will accept a small violation rather
          than push RTP far off target. Each reel's own <strong>Strength</strong> multiplies how hard
          that specific reel's preference is enforced (1 = normal, 0 = same as "no preference" without
          losing the direction dropdown's selection, above 1 = enforced harder) - useful when one
          reel's preference is visibly dominating the tune at the shared Ordering Penalty Weight
          above. A symbol can also carry its own soft <code>min</code>/
          <code>max</code> frequency bounds directly in its FREQUENCY_REELn entry (edit that in
          game.js - there's no input for it here); Frequency Limit Penalty Weight controls how
          strongly those are enforced, same soft-preference semantics. Uniformity Penalty Weight
          (off by default) is a separate, reel-wide soft preference: it discourages any one
          tunable symbol from landing far from a straight-line target across that reel's payout
          tiers - not a flat "everyone equal" target. That line's slope comes entirely from the
          reel's own ordering preference above (its direction and Strength): "No preference"
          keeps the line flat (an equal split); a real preference tilts the line the same way, so
          raising this weight pulls harder toward the tilt ordering already wants instead of
          fighting it with a competing flat preference. Scatter symbols never participate (their
          ideal frequency plays too different a role). Any violation still present at the end is
          listed below.
          </p>
        </details>
      </details>

      <!-- 3. SEARCH SETTINGS - how hard and how carefully to look. Rarely touched. -->
      <details id="tune-section-search" style="margin-bottom: 8px; background: rgba(255,255,255,0.04); border-radius: 8px; padding: 8px 12px;">
        <summary style="font-size: 0.85em; color: #ddd; cursor: pointer; user-select: none;">How hard to look <span id="tune-summary-search" style="color: #888; font-size: 0.85em;"></span></summary>
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 10px; margin-top: 10px;">
          <label title="Which algorithm searches the per-symbol reel weights (Phase 2). CMA-ES (default in this panel) is a population-based search that scales better to many tunable symbols at once and is more tolerant of noisy RTP measurements (e.g. Candy Frenzy's cascade multiplier bonus), at the cost of evaluating a whole population of candidates every generation instead of one or two. Nelder-Mead is a simpler simplex search - cheaper for a small number of tunable symbols, and still tuneFrequencies' own library-level default when this option is omitted entirely." style="font-size: 0.8em; color: #ccc;">Search Algorithm<br>
            <select id="tune-search-algorithm" style="width: 100%; margin-top: 4px;">
              <option value="cmaes" selected>CMA-ES (default)</option>
              <option value="nelderMead">Nelder-Mead</option>
            </select>
          </label>
          <label title="Upper bound on iterations for the joint frequency search (Phase 2). The search may stop earlier if it converges, stalls out after repeated restarts, or is already essentially resolved - see the reason reported after a run." style="font-size: 0.8em; color: #ccc;">Max Iterations<br>
            <input id="tune-max-iterations" type="number" value="150" step="10" min="10" max="1000" style="width: 100%; margin-top: 4px;">
          </label>
          <label title="The full-fidelity spins used to independently validate the strongest finalists before a tune is reported. The search itself explores at one quarter of this budget with common random numbers, then promotes only a few distinct reel strips to this full check - substantially faster without treating a cheap draw as final truth." style="font-size: 0.8em; color: #ccc;">Validation Spins / Trial<br>
            <input id="tune-trial-spins" type="number" value="300000" step="50000" min="10000" style="width: 100%; margin-top: 4px;">
          </label>
          <label title="How many independent full-fidelity trials are averaged for final validation. Search exploration uses one deterministic common-random-number trial for speed; finalists are re-ranked here on fresh seeds, so this is the number that decides whether the reported answer is trustworthy." style="font-size: 0.8em; color: #ccc;">Validation Trials / Finalist<br>
            <input id="tune-trials-per-point" type="number" value="3" step="1" min="1" max="10" style="width: 100%; margin-top: 4px;">
          </label>
          <label title="Virtual reel strip length used to build each candidate's reel strips - defaults to this game's own REEL_LENGTH. Longer reels let low frequencies round to more distinct symbol counts (which is what makes a trigger-rate target reachable when it currently sits in a lattice gap), at the cost of a slower simulation per candidate. Whatever you set here is emitted as REEL_LENGTH in the copyable output, since a result tuned at one length does not reproduce at another." style="font-size: 0.8em; color: #ccc;">Reel Length<br>
            <input id="tune-reel-length" type="number" value="${tuneConfig.reelLength}" step="10" min="30" style="width: 100%; margin-top: 4px;">
          </label>
          <label title="How many spins each point of the Phase 0c knob sweep and the Phase 0d structural grid is measured over. This is the setting that decides whether CHECK MY CONFIG can tell two structural settings apart: its measured noise floor scales as 1/sqrt(this). Measured on Candy Frenzy - 10,000 spins gives a noise floor of ±17.9pp, 150,000 gives ±2.9pp. Ranking knobs by leverage survives a lot of noise (the top knobs measure in the hundreds of pp per unit), but deciding WHICH COMBINATION hits your target does not, which is why Phase 0d refuses to name a winner when the floor is wider than your RTP tolerance and tells you to raise this. Lower is faster: the whole point of CHECK MY CONFIG is that it answers in seconds." style="font-size: 0.8em; color: #ccc;">Diagnosis Spins / Point<br>
            <input id="tune-sensitivity-spins" type="number" value="500000" step="10000" min="1000" style="width: 100%; margin-top: 4px;">
          </label>
          <label title="How each tunable symbol's STARTING frequency is chosen before the search begins. 'Use configured baseline' starts every symbol exactly where FREQUENCY_REELn already had it (default - unchanged behavior). The two random options instead pick a starting value between that symbol's own minFrequency and maxFrequency - only symbols with BOTH bounds set are affected, everything else always starts at its baseline regardless of this setting. Useful for checking whether the search reliably reaches the same answer from a meaningfully different starting shape, or gets stuck depending on where it started." style="font-size: 0.8em; color: #ccc;">Initial Frequency Strategy<br>
            <select id="tune-initial-weight-strategy" style="width: 100%; margin-top: 4px;">
              <option value="provided" selected>Use configured baseline (default)</option>
              <option value="uniform">Random (uniform) within min/max</option>
              <option value="normal">Random (normal) within min/max</option>
            </select>
          </label>
        </div>
      </details>

      <!-- 4. ADVANCED - reached when something has gone wrong, or to reproduce a specific run. -->
      <details id="tune-section-advanced" style="margin-bottom: 12px; background: rgba(255,255,255,0.04); border-radius: 8px; padding: 8px 12px;">
        <summary style="font-size: 0.85em; color: #ddd; cursor: pointer; user-select: none;">Advanced <span id="tune-summary-advanced" style="color: #888; font-size: 0.85em;"></span></summary>
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 10px; margin-top: 10px;">
          <label title="Caps how uncertain a candidate's own averaged RTP is allowed to be before it can count as a genuine hit on Target RTP - measured as the standard error of the mean across its Trials Averaged repeats. A high-variance mechanic (e.g. a cascade bonus whose multiplier can stack repeatedly) can average out to a plausible-looking RTP while its individual trials still disagree wildly - that's a lucky/unlucky sample, not a trustworthy measurement. Raise this (or raise Trial Spins/Trials Averaged instead, now cheap thanks to the Worker pool) if a real search keeps stalling here." style="font-size: 0.8em; color: #ccc;">Max RTP Std Error (%)<br>
            <input id="tune-max-rtp-std-error" type="number" value="1" step="0.1" min="0" style="width: 100%; margin-top: 4px;">
          </label>
          <label title="Adds a candidate's own measurement unreliability (standard error across its Trials Averaged repeats) directly into the search's loss, on top of Max RTP Std Error / a candidate's Best-acceptance margin (which only ever gate whether a result can count as converged or replace the current best AFTER the fact). Raising this gives the search an active incentive to prefer more reliably-reproducible regions of the search space DURING the search itself, not just whichever candidate happens to look best on one noisy average. 0 (default) is off - loss ignores std error entirely." style="font-size: 0.8em; color: #ccc;">Std Error Penalty Weight<br>
            <input id="tune-std-error-weight" type="number" value="0" step="0.1" min="0" style="width: 100%; margin-top: 4px;">
          </label>
          <label title="Base PRNG seed for the whole search. A given seed always explores the same sequence, so a run is reproducible end to end - the copyable output records whichever seed produced it. Change it to explore a different path through the same search space without changing any other setting." style="font-size: 0.8em; color: #ccc;">Search Seed<br>
            <input id="tune-search-seed" type="number" value="12345" step="1" min="0" style="width: 100%; margin-top: 4px;">
          </label>
          <label title="Which denomination the loss weights are expressed in. NORMALIZED re-denominates every penalty into a scale-free fraction, so a weight of 1 is worth roughly one RTP percentage point on any game and any term - which is what makes the named levels above mean anything. RAW uses the penalties' own units, which are incommensurable: ordering is in frequency units, spacing is a violation COUNT. Measured on Candy Frenzy, a raw spacing weight of 0.25 contributes 43.75 to a loss whose RTP error term is 1.76, so the search spends 96% of its effort on spacing while appearing to tune RTP. Raw is the library default and is kept here for reproducing older runs exactly." style="font-size: 0.8em; color: #ccc;">Penalty Denomination<br>
            <select id="tune-penalty-normalization" style="width: 100%; margin-top: 4px;">
              <option value="normalized" selected>Normalized (1 ≈ 1pp of RTP)</option>
              <option value="raw">Raw penalty units</option>
            </select>
          </label>
          <label title="Only used by 'Same mix, then vary slightly'. How far each reel's own weight for a symbol may drift from the shared value the linked stage settled on, as a fraction - 0.25 means +/-25%. It exists to keep the refinement a refinement: without a bound, reopening per-reel weights hands back exactly the freedom the linked stage was there to remove, just from a better starting point. Set it to 0 to pin the refinement to the linked answer entirely." style="font-size: 0.8em; color: #ccc;">Max Reel Deviation<br>
            <input id="tune-max-reel-deviation" type="number" value="${tuneConfig.maxReelDeviation ?? 0.25}" step="0.05" min="0" max="0.95" style="width: 100%; margin-top: 4px;">
          </label>
        </div>
        <!-- The raw weights the intent dropdowns above drive. Authoritative: readTuneOptions reads
             THESE, never the dropdowns, so there is exactly one source of truth for what the
             search was given, and a hand-typed value is never silently overridden by a named
             level that does not match it. -->
        <div style="margin-top: 12px; padding-top: 10px; border-top: 1px solid rgba(255,255,255,0.1);">
          <div style="font-size: 0.72em; color: #888; text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 6px;">Raw penalty weights &mdash; these are what the search actually receives</div>
          <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 10px;">
            ${PENALTY_INTENTS.map(p => `
            <label title="${p.title}" style="font-size: 0.8em; color: #ccc;">${p.label}<br>
              <input id="${p.weightId}" type="number" value="${INTENT_DEFAULTS[p.key]}" step="0.1" min="0" style="width: 100%; margin-top: 4px;">
            </label>`).join('')}
          </div>
        </div>
      </details>
      <!-- Extra answers to compute while checking. Beside the buttons, not with the targets. -->
        <!-- What CHECK MY CONFIG should also work out. They live beside the buttons rather than
             with the targets because they are not things you want - they are extra answers to
             compute while looking, and both are suggestions that change nothing. -->
        <label title="After the frequency search finishes, compute the single multiplier that would put RTP exactly on target if applied to every payout value, and report it (plus a verification measurement and a paste-ready scaled paytable). Nothing is changed for you - this only ever produces a suggestion, exactly like the frequency tables. Worth knowing why this is different from everything else here: frequencies are a poor RTP lever, which is precisely why the search has to torture them into the over-abundance that then breaks reel spacing and cluster behavior. Payout values are an EXACT lever - k = target / measured, verified linear to 5 significant figures. Using it frees the frequency search to do what it is actually good at: ordering, uniformity, spacing and trigger rate." style="display: block; font-size: 0.8em; color: #ccc; margin-top: 10px;">
          <input id="tune-solve-payout-scale" type="checkbox" checked style="vertical-align: middle; margin-right: 6px;">
          Also work out the exact payout multiplier that hits this RTP
          <span style="color: #888;">&mdash; suggestion only, your paytable is never changed</span>
        </label>
        <!-- The other half of the same idea, and the one that answers "what do I actually set
             these to". Phase 0c ranks the structural knobs one at a time; this searches them
             together, because they interact - maxStack caps vertical runs that stackChance has to
             be high enough to produce in the first place, so the best combination is not the best
             of each knob chosen separately. Cheap because the grid is RANKED from Phase 0c's
             already-paid-for ladders and only a handful of cells are ever simulated. -->
        <label title="After checking which knobs matter, search them TOGETHER for one combination of stackChance / maxStack / minStack / minGap that reaches your target RTP at even symbol frequencies - and report it for you to accept or reject. Nothing is applied. Knobs the sweep found no measurable effect for are left out rather than multiplying the search for nothing. Among combinations that hit the target it prefers the SMALLEST change from what you already chose, so the answer is a tweak you can judge rather than a redesign you have to argue with. This matters most when even frequencies pay nowhere near target: the frequency search's only way to close that gap is concentrating symbols, which is exactly the over-abundance complaint - fixing it structurally means the search never has to." style="display: block; font-size: 0.8em; color: #ccc; margin-top: 6px;">
          <input id="tune-tune-structural" type="checkbox" checked style="vertical-align: middle; margin-right: 6px;">
          Also suggest what to set the stacking/spacing settings to
          <span style="color: #888;">&mdash; searched together, not one at a time</span>
        </label>
      <!-- Two buttons, two jobs, no overlap. CHECK MY CONFIG measures the config and searches
           nothing; START TUNING searches and no longer re-runs the check (it used to, silently,
           every time - about 26 seconds of work before any searching began). Same size and shape
           as each other so they read as siblings; only the emphasis differs, because only one of
           them is the thing you came here to do. -->
      <div id="tune-action-row" style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 10px;">
        <button id="tune-diagnose-btn" class="btn-icon tune-action" style="padding: 8px 16px; font-size: 0.85em; background: rgba(127,191,255,0.15); border-color: #7fbfff; color: #cfe6ff;" title="Measures your config and stops: what is broken, what an even symbol distribution pays, which structural knob actually moves RTP, what to set them to, and what the search would really be optimizing. No search is started and nothing is changed. Seconds rather than the minutes a tune takes, and what it tells you will usually change what you type above.">CHECK MY CONFIG</button>
        <button id="tune-start-btn" class="btn-icon tune-action" style="padding: 8px 16px; font-size: 0.85em; background: rgba(255,214,0,0.9); border-color: #ffd600; color: #241c00; font-weight: bold;" title="Runs the frequency search against the targets above. Does NOT re-run CHECK MY CONFIG - that panel stays as you last left it.">START TUNING</button>
        <button id="tune-stop-btn" class="btn-icon tune-action" style="display: none; padding: 8px 16px; font-size: 0.85em; background: rgba(255,90,90,0.2); border-color: #ff8080; color: #ffc9c9;">STOP</button>
      </div>
      <!-- BEFORE YOU TUNE. Config validation, structural headroom, and which knob actually moves
           RTP. All of it is produced without any search, and all of it is a RESULT rather than a
           progress event - in the log it would scroll away under a hundred per-iteration lines
           seconds after appearing, which is exactly where it was first (wrongly) put. -->
      <div id="tune-diagnosis" style="display: none; margin-top: 12px;"></div>
      <!-- "Where am I, what is running, and why" - answered continuously rather than left to be
           reconstructed from the numbers. The stats cards below say how the search is DOING; this
           says what it is DOING, which is the question that was unanswerable while a two-stage
           Phase 2 reported "Step 9" identically in either stage. -->
      <div id="tune-phase-banner" style="display: none; margin-top: 12px; background: rgba(127,191,255,0.09); border-left: 3px solid #7fbfff; border-radius: 6px; padding: 8px 12px;">
        <div style="display: flex; justify-content: space-between; align-items: baseline; gap: 10px; flex-wrap: wrap;">
          <span id="tune-phase-name" style="font-size: 0.9em; font-weight: bold; color: #cfe6ff;">—</span>
          <span id="tune-phase-progress" style="font-size: 0.75em; color: #9ab;"></span>
        </div>
        <div id="tune-phase-strategy" style="font-size: 0.8em; color: #ddd; margin-top: 3px;"></div>
        <div id="tune-phase-why" style="font-size: 0.75em; color: #9ab; margin-top: 3px; font-style: italic;"></div>
      </div>
      <div id="tune-live-stats" style="display: none; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px; margin-top: 12px;">
        <div style="background: rgba(255,255,255,0.06); border-radius: 8px; padding: 10px 14px;">
          <div style="display: flex; justify-content: space-between; align-items: baseline;">
            <span title="Accept/reject is decided on Loss (lower always wins), not RTP alone: Loss = RTP error + (ordering penalty × its weight) + (limit penalty × its weight) + (uniformity penalty × its weight). The bar below shows what's actually contributing to it." style="font-size: 0.7em; color: #999; text-transform: uppercase; letter-spacing: 0.5px; cursor: help; border-bottom: 1px dotted #666;">Current</span>
            <span id="tune-live-stats-current-step" style="font-size: 0.7em; color: #999;"></span>
          </div>
          <div id="tune-live-stats-current" style="font-size: 1.3em; font-weight: bold; margin-top: 2px;">—</div>
          <div style="height: 4px; border-radius: 2px; background: rgba(255,255,255,0.12); margin-top: 8px; overflow: hidden;">
            <div id="tune-live-stats-current-progress-bar" style="height: 100%; width: 0%; background: #7fbfff; transition: width 0.2s;"></div>
          </div>
        </div>
        <div style="background: rgba(255,255,255,0.06); border-radius: 8px; padding: 10px 14px;">
          <span title="Accept/reject is decided on Loss (lower always wins), not RTP alone: Loss = RTP error + (ordering penalty × its weight) + (limit penalty × its weight) + (uniformity penalty × its weight). The bar below shows what's actually contributing to it." style="font-size: 0.7em; color: #999; text-transform: uppercase; letter-spacing: 0.5px; cursor: help; border-bottom: 1px dotted #666;">Best</span>
          <div id="tune-live-stats-best" style="font-size: 1.3em; font-weight: bold; margin-top: 2px;">—</div>
          <div id="tune-live-stats-best-improved" style="font-size: 0.72em; margin-top: 8px; min-height: 1.3em;"></div>
          <!-- Every config that ever became the best, kept rather than overwritten. The search
               keeps whichever candidate has the lowest LOSS, which is a weighted blend - the one
               that best serves what a developer actually cares about is often an earlier one, and
               until now it was discarded the moment something scored better. -->
          <button id="tune-best-log-btn" class="btn-icon" style="display: none; margin-top: 8px; padding: 4px 10px; font-size: 0.7em; background: rgba(255,255,255,0.08); border-color: rgba(255,255,255,0.25); color: #ddd;"></button>
        </div>
        <div style="background: rgba(255,255,255,0.06); border-radius: 8px; padding: 10px 14px;">
          <div style="font-size: 0.7em; color: #999; text-transform: uppercase; letter-spacing: 0.5px;">Violations (best)</div>
          <div id="tune-live-stats-violations" style="font-size: 0.85em; font-weight: 600; margin-top: 6px; line-height: 1.6;">—</div>
        </div>
      </div>
      <div id="tune-best-log" style="display: none; margin-top: 12px;"></div>
      <div id="tune-live-table" style="display: none; margin-top: 12px;"></div>
      <div id="tune-progress-log" style="display: none; margin-top: 12px; max-height: 220px; overflow-y: auto; font-family: monospace; font-size: 1.05em; line-height: 1.5; background: rgba(0,0,0,0.3); padding: 8px; border-radius: 6px;"></div>
      <div id="tune-results"></div>
    `;
    tuneContainer.querySelector('#tune-start-btn').addEventListener('click', () => startTuning({
      paytable, reelFrequencyTables, tuneConfig, tuneContainer,
      originalReelFrequencyTables: reelFrequencyTables,
    }));
    tuneContainer.querySelector('#tune-diagnose-btn').addEventListener('click', () => startTuning({
      paytable, reelFrequencyTables, tuneConfig, tuneContainer,
      originalReelFrequencyTables: reelFrequencyTables,
      // Same entry point, same options, same worker pool - only the engine stops earlier. Running
      // it through a separate path would let the diagnosis and the tune it precedes drift into
      // disagreeing about what the config measures.
      diagnoseOnly: true,
    }));

    // Each collapsed section carries a live summary of its own contents in its <summary> line, so
    // a developer can tell whether opening it is worth it without opening it. Without this,
    // collapsing the panel's settings just hides them - trading one problem (fifteen inputs all
    // shouting at once) for another (no idea what the search is about to do).
    //
    // Wired here, during panel CONSTRUCTION, rather than in startTuning: the panel is built once
    // and lives for the whole session, while startTuning runs per click. Wiring listeners there
    // would both leave the summaries blank until the first tune started and add a duplicate set of
    // listeners on every subsequent START TUNING / CONTINUE.
    const summaryEls = {
      shape: tuneContainer.querySelector('#tune-summary-shape'),
      search: tuneContainer.querySelector('#tune-summary-search'),
      advanced: tuneContainer.querySelector('#tune-summary-advanced'),
    };
    const echoEl = tuneContainer.querySelector('#tune-trigger-pct-echo');
    const el = (id) => tuneContainer.querySelector(id);
    const num = (id, fallback = 0) => {
      const parsed = parseFloat(el(id)?.value);
      return Number.isFinite(parsed) ? parsed : fallback;
    };

    function refreshSectionSummaries() {
      // The echo shows the library's own unit beside the panel's, so the conversion between them
      // is visible rather than something a developer has to take on trust.
      if (echoEl) {
        const pct = spinsPerTriggerToPct(num('#tune-target-trigger-spins'));
        const tol = num('#tune-trigger-tolerance');
        echoEl.textContent = pct > 0
          ? `= ${pct.toFixed(3)}% of spins (band ${Math.max(0, pct - tol).toFixed(2)}–${(pct + tol).toFixed(2)}%)`
          : 'no free-spin target';
      }
      // The band's actual sigma range, shown beside the name - so "Low" is visibly a claim about a
      // measurable quantity, and the caveat about how little the frequency search can move it is
      // attached where the choice is made rather than only in a tooltip.
      const volEchoEl = el('#tune-volatility-echo');
      if (volEchoEl) {
        const chosen = el('#tune-target-volatility')?.value;
        if (!chosen) {
          volEchoEl.textContent = 'reported either way, just not targeted';
        } else {
          const b = volatilityBandToSigma(chosen);
          volEchoEl.textContent = `= σ ${b.min}–${b.max === Infinity ? '∞' : b.max}× bet · mostly a STRUCTURAL lever, not a frequency one`;
        }
      }
      // Only preferences actually turned ON are worth naming. Listing "ordering 0.5, limits 0.5,
      // uniformity 0, trigger 0, spacing 0" would make the two that matter exactly as hard to pick
      // out as they are in the expanded grid, which is the problem this is here to solve.
      // Named by their level when they have one, since that is what the section now shows.
      const active = PENALTY_INTENTS
        .filter(p => num(`#${p.weightId}`) > 0)
        .map(p => {
          const level = el(`#tune-intent-${p.key}`)?.value;
          return `${p.key} ${level && level !== 'custom' ? INTENT_LEVELS[level].label.toLowerCase() : num(`#${p.weightId}`)}`;
        });
      if (summaryEls.shape) {
        // Coupling leads, because it is the one setting in this section that changes what the
        // search can express at all rather than how strongly it prefers something.
        const coupling = { independent: 'per-reel mix', linked: 'same mix', 'linked-then-refine': 'same mix + refine' }[el('#tune-reel-coupling')?.value] ?? 'per-reel mix';
        summaryEls.shape.textContent = `— ${[coupling, ...active].join(' · ')}`;
      }
      if (summaryEls.search) {
        const algo = el('#tune-search-algorithm')?.value === 'nelderMead' ? 'Nelder-Mead' : 'CMA-ES';
        summaryEls.search.textContent = `— ${algo} · ${num('#tune-max-iterations')} iterations · ` +
          `${fmt(num('#tune-trial-spins'))} spins x${num('#tune-trials-per-point')} · reel ${num('#tune-reel-length')}`;
      }
      if (summaryEls.advanced) {
        summaryEls.advanced.textContent = `— seed ${num('#tune-search-seed')} · max std error ${num('#tune-max-rtp-std-error')}% · `
          + `diagnosis ${fmt(num('#tune-sensitivity-spins'))} spins/point`;
      }
    }
    // ---- Intent dropdowns <-> raw weights ----
    // One direction each, and deliberately asymmetric. Picking a level WRITES the weight, because
    // the level is a shorthand for it. Typing a weight only sets the dropdown to 'custom' - it
    // never snaps to the nearest level, because a dropdown reading "Insist" beside a weight of 2.5
    // would report something the search is not doing, which is the exact failure the named levels
    // exist to fix.
    function syncDenominationNote() {
      const anyCustom = PENALTY_INTENTS.some(p => el(`#tune-intent-${p.key}`)?.value === 'custom');
      const modeEl = el('#tune-penalty-normalization');
      // A hand-typed weight forces RAW: the named levels are calibrated against normalized
      // penalties, so reinterpreting someone's own number in a denomination they did not choose
      // would silently change what they asked for.
      if (anyCustom && modeEl && modeEl.value === 'normalized') modeEl.value = 'raw';
      const noteEl = el('#tune-denomination-note');
      if (!noteEl) return;
      noteEl.textContent = modeEl?.value === 'normalized'
        ? 'Levels are calibrated so one step is worth roughly one RTP percentage point. Raw weights are in Advanced.'
        : 'RAW penalty units — a weight here is in each penalty\'s own scale, and those are not comparable to each other or to RTP error. Set every row to a named level to switch back.';
    }
    PENALTY_INTENTS.forEach(p => {
      const select = el(`#tune-intent-${p.key}`);
      const weight = el(`#${p.weightId}`);
      if (!select || !weight) return;
      select.value = weightToIntent(parseFloat(weight.value));
      select.addEventListener('change', () => {
        if (select.value === 'custom') return; // leave the weight alone - "custom" means "what's typed"
        weight.value = String(intentToWeight(select.value));
        syncDenominationNote();
        refreshSectionSummaries();
      });
      weight.addEventListener('input', () => {
        select.value = weightToIntent(parseFloat(weight.value));
        syncDenominationNote();
      });
    });
    el('#tune-penalty-normalization')?.addEventListener('change', syncDenominationNote);
    syncDenominationNote();

    tuneContainer.querySelectorAll('input, select').forEach(control => {
      control.addEventListener('input', refreshSectionSummaries);
      control.addEventListener('change', refreshSectionSummaries);
    });
    refreshSectionSummaries();
  }

  showDeveloperPanel(panel);
  panel.style.maxWidth = '900px';
  panel.style.width = '95%';
}
