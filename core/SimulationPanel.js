// Shared RUN SIMULATION / TUNE FREQUENCIES dev-tooling UI, built on top of
// core/SpinSimulator.js's pure simulateSpins/tuneFrequencies functions.
// Every game's game.js calls into this instead of maintaining its own copy.
import { resolveFrequencyBounds } from './SlotMath.js';
import { exportSpinLogCsv } from './SpinLog.js';
import { tuneFrequencies } from './SpinSimulator.js';
import { createSimulationWorkerPool } from './SimulationWorkerPool.js';
import { spinsPerTriggerToPct, pctToSpinsPerTrigger, INTENT_LEVELS, intentToWeight, weightToIntent, volatilityBandToSigma } from './TuningUnits.js';
import { describePlayerExperience } from './PlayerExperience.js';
import { createTuneLogEntry, describeTuneEntryQuality, tuneLogToJson, exportTuneLogJson } from './TuneLog.js';

const fmt = (n) => n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });

// Escapes text destined for an innerHTML string. Most of what goes through the diagnosis panel is
// numbers and internal knob names, but validation messages carry symbol names straight out of a
// game's own paytable - developer-authored strings that have no business being parsed as markup.
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * The pre-tune diagnosis - config validation, structural headroom, and which knob actually moves
 * RTP - rendered as a real UI panel.
 *
 * This is a RESULT, not a progress event, which is why it does not belong in the scrolling log:
 * it is the single most useful thing the tuner produces, it needs no search to produce it, and in
 * a log it scrolls away under a hundred per-iteration lines seconds after appearing. It gets its
 * own persistent section that stays readable for the whole run.
 *
 * Pure: takes plain data, returns an HTML string, touches no DOM. Testable in node --test the same
 * way `formatReelFrequencyTablesForCopy` is.
 *
 * The shape is deliberate. Knobs come in leverage order, each with a bar so the ranking registers
 * before a single number is read, and each with its own ladder so the SHAPE of the response is
 * visible too - "maxStack 6 pays 2205%" matters more than any elasticity average. A knob inside
 * the noise floor says "no measurable effect" rather than printing a small number, because a small
 * number beside a large one reads as a weak-but-real lever, and that is the exact mistake this
 * report exists to prevent.
 */
/**
 * The five soft constraints, each phrased as what it WANTS rather than what it penalizes, and
 * paired with the raw weight input that remains authoritative.
 *
 * `lossKey` ties each row to its term in the loss preview, which is what fills the "now:" column.
 * That column is the point of the exercise: "Insist" is a choice about a real, currently-measured
 * quantity, where "uniformityPenaltyWeight: 5" is an incantation.
 */
const PENALTY_INTENTS = [
  {
    key: 'ordering', lossKey: 'ordering', weightId: 'tune-ordering-weight', label: 'Respect payout ordering',
    title: "How hard the search works to keep each reel's payout-ordering preference (set per reel below) satisfied. A higher-paying symbol should not be more frequent than a lower-paying one - or the reverse, if that reel's preference is 'more frequent'. Always a soft preference: the search will accept a small violation rather than push RTP far off target.",
  },
  {
    key: 'limit', lossKey: 'limits', weightId: 'tune-limit-weight', label: 'Respect per-symbol frequency limits',
    title: "How hard the search works to keep each symbol inside its own minFrequency/maxFrequency, which are set in that symbol's FREQUENCY_REELn entry in game.js rather than here.",
  },
  {
    key: 'uniformity', lossKey: 'uniformity', weightId: 'tune-uniformity-weight', label: 'Keep symbols evenly spread',
    title: "How hard the search works to keep every tunable symbol near a straight-line target across that reel's payout tiers. The line is flat when the reel's ordering preference is 'No preference', and tilts to match that preference otherwise - so this never fights ordering with a competing flat target.",
  },
  {
    key: 'spacing', lossKey: 'spacing', weightId: 'tune-spacing-weight', label: 'Honor reel spacing',
    title: "How hard the search works to keep the GENERATED STRIP honoring each symbol's minGap and maxStack. generateReel enforces both best-effort - on a strip too dense to space a symbol out it silently gives up - so without this the search sees no cost in pushing a frequency past what the strip can represent. On a cluster-pays game that clumping is exactly what inflates cluster wins and RTP. Note this cannot always reach zero: a game already over the ceiling at baseline starts non-zero, and the point is to stop the search making it much worse.",
  },
  {
    key: 'triggerRate', lossKey: 'triggerRate', weightId: 'tune-trigger-rate-weight', label: 'Hold the free-spin trigger rate',
    title: "How hard the search works to keep the trigger rate inside its target band. Phase 2 never tunes trigger symbols directly, so on a line-pay game this cannot move and can stay Off. On a CASCADE game it moves a lot: the other symbols' weights control how readily clusters form, which controls cascade depth, and every cascade refills the grid with fresh chances to draw the scatter. Measured on Candy Frenzy, reweighting only the candies swings the trigger rate from 0.75% to 2.04%.",
  },
];

/**
 * The accepted-best history, as a browsable list. Pure - returns HTML.
 *
 * Ordered newest first, because the last accepted candidate is the one the run is about to hand
 * back and therefore the one most likely to be under scrutiny. Each row leads with its verdict, so
 * "is any of this any good" is answerable by scanning one column rather than reading eight numbers
 * per entry.
 */
export function renderTuneLogHtml(entries) {
  if (!entries?.length) return '';
  const rows = [...entries].reverse().map(e => {
    const q = describeTuneEntryQuality(e);
    const shape = e.shape
      ? `${e.shape.volatilityIndex.toFixed(1)}x ${esc(e.shape.volatilityBand)} · hit ${(e.shape.hitRate * 100).toFixed(0)}% · max ${e.shape.maxWin.toFixed(0)}x · top1% ${(e.shape.top1PctShare * 100).toFixed(0)}%`
      : 'shape not measured';
    return `<tr style="border-bottom: 1px solid rgba(255,255,255,0.06);">
        <td style="padding: 5px 8px 5px 0; white-space: nowrap; color: #888; font-size: 0.9em;">#${e.index}<br><span style="font-size: 0.85em;">step ${e.step}${e.stage ? ` · ${esc(e.stage)}` : ''}</span></td>
        <td style="padding: 5px 8px 5px 0; white-space: nowrap;">
          <span style="color: ${e.achieved.withinRtpTolerance ? '#7fd97f' : '#e6b800'}; font-weight: bold;">${e.achieved.rtp != null ? `${e.achieved.rtp.toFixed(2)}%` : '—'}</span>
          <span style="color: #777; font-size: 0.85em;"> ±${e.measurement.trialRtpStdError.toFixed(2)}</span><br>
          <span style="color: ${e.achieved.withinTriggerTolerance ? '#9ab' : '#e6b800'}; font-size: 0.85em;">${e.achieved.spinsPerTrigger != null ? `1 in ${Math.round(e.achieved.spinsPerTrigger)}` : 'no bonus'}</span>
        </td>
        <td style="padding: 5px 8px 5px 0; color: #9ab; font-size: 0.85em;">${shape}</td>
        <td style="padding: 5px 8px 5px 0; white-space: nowrap; color: #aaa; font-size: 0.85em;">loss ${e.loss.total != null ? e.loss.total.toFixed(4) : '—'}</td>
        <td style="padding: 5px 8px 5px 0; font-size: 0.85em; color: ${q.ok ? '#7fd97f' : '#e6b800'};">${q.ok ? '✓' : '⚠'} ${esc(q.verdict)}</td>
        <td style="padding: 5px 0; white-space: nowrap;">
          <button class="btn-icon tune-log-copy" data-index="${e.index}" style="padding: 3px 8px; font-size: 0.7em; background: rgba(255,255,255,0.08); border-color: rgba(255,255,255,0.2); color: #ddd;">COPY</button>
          <button class="btn-icon tune-log-export" data-index="${e.index}" style="padding: 3px 8px; font-size: 0.7em; background: rgba(255,255,255,0.08); border-color: rgba(255,255,255,0.2); color: #ddd;">JSON</button>
        </td>
      </tr>`;
  }).join('');

  return `<div style="background: rgba(255,255,255,0.05); border-left: 3px solid #c58fff; border-radius: 6px; padding: 10px 14px;">
      <div style="display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 8px;">
        <span style="font-size: 0.72em; letter-spacing: 0.08em; text-transform: uppercase; color: #c58fff;">Every config that became the best (${entries.length})</span>
        <span style="display: flex; gap: 6px;">
          <button id="tune-log-copy-all" class="btn-icon" style="padding: 4px 10px; font-size: 0.7em; background: rgba(255,255,255,0.08); border-color: rgba(255,255,255,0.25); color: #ddd;">COPY ALL</button>
          <button id="tune-log-export-all" class="btn-icon" style="padding: 4px 10px; font-size: 0.7em; background: rgba(255,255,255,0.08); border-color: rgba(255,255,255,0.25); color: #ddd;">EXPORT ALL JSON</button>
        </span>
      </div>
      <div style="font-size: 0.75em; color: #888; margin-bottom: 8px;">
        The search keeps whichever candidate has the lowest <em>loss</em> &mdash; a weighted blend. An earlier
        entry here may suit you better; each carries its own error bar, payout shape and violations so you can tell.
      </div>
      <div style="max-height: 260px; overflow-y: auto;">
        <table style="width: 100%; border-collapse: collapse; font-size: 0.85em;">${rows}</table>
      </div>
    </div>`;
}

/**
 * "Did I get what I asked for?", answered in one glance before any of the detail.
 *
 * Each chip pairs an ACHIEVED value with the target from *What do you want*, so the comparison is
 * made for the reader rather than left to them. Pure - returns HTML.
 */
export function renderTargetChipsHtml({ rtp, targetRtp, rtpTolerancePct, triggerRatePct, targetTriggerRatePct, triggerRateTolerancePct, volatilityClass, targetVolatility }) {
  const chip = (label, value, ok) => `
    <span style="display: inline-flex; align-items: baseline; gap: 6px; padding: 5px 12px; border-radius: 999px;
                 background: ${ok ? 'rgba(127,217,127,0.14)' : 'rgba(230,184,0,0.14)'};
                 border: 1px solid ${ok ? 'rgba(127,217,127,0.5)' : 'rgba(230,184,0,0.5)'};">
      <span style="font-size: 0.7em; text-transform: uppercase; letter-spacing: 0.06em; color: #999;">${esc(label)}</span>
      <span style="font-size: 0.9em; font-weight: bold; color: ${ok ? '#7fd97f' : '#e6b800'};">${esc(value)}</span>
      <span style="font-size: 0.85em; color: ${ok ? '#7fd97f' : '#e6b800'};">${ok ? '✓' : '✗'}</span>
    </span>`;

  const chips = [];
  if (rtp != null && targetRtp != null) {
    chips.push(chip('RTP', `${rtp.toFixed(2)}%`, Math.abs(rtp - targetRtp) <= (rtpTolerancePct ?? 1.5)));
  }
  if (triggerRatePct != null && targetTriggerRatePct != null) {
    const spins = pctToSpinsPerTrigger(triggerRatePct);
    chips.push(chip('Bonus', spins == null ? 'never' : `1 in ${Math.round(spins)}`,
      Math.abs(triggerRatePct - targetTriggerRatePct) <= (triggerRateTolerancePct ?? 0.15)));
  }
  if (volatilityClass) {
    // With no volatility target asked for there is nothing to pass or fail against, so the chip
    // reports the measured band as satisfied rather than inventing a standard to judge it by.
    chips.push(chip('Volatility', volatilityClass.toUpperCase(), !targetVolatility || targetVolatility === volatilityClass));
  }
  if (chips.length === 0) return '';
  return `<div style="display: flex; gap: 8px; flex-wrap: wrap; margin: 12px 0 10px;">${chips.join('')}</div>`;
}

/**
 * The plain-language player-experience report. Pure - returns HTML.
 */
export function renderPlayerExperienceHtml(experience) {
  if (!experience?.lines?.length) return '';
  return `<div style="background: rgba(255,255,255,0.05); border-left: 3px solid #c58fff; border-radius: 6px; padding: 10px 14px; margin-bottom: 12px;">
      <div style="font-size: 0.72em; letter-spacing: 0.08em; text-transform: uppercase; color: #c58fff; margin-bottom: 6px;">What this game feels like to play</div>
      ${experience.lines.map(l => `<div style="font-size: 0.84em; color: #ddd; margin-bottom: 5px; line-height: 1.5;">${esc(l)}</div>`).join('')}
    </div>`;
}

/**
 * What each soft constraint currently COSTS, for the "now:" column beside its intent dropdown.
 * Pure; returns a `{ key: text }` map. `null` preview -> em dashes, since nothing has measured
 * anything yet and a zero would claim otherwise.
 */
export function describePenaltyStateNow(lossPreview) {
  const out = {};
  PENALTY_INTENTS.forEach(({ key }) => { out[key] = '—'; });
  if (!lossPreview?.terms?.length) return out;
  const byKey = new Map(lossPreview.terms.map(t => [t.key, t]));
  PENALTY_INTENTS.forEach(({ key, lossKey }) => {
    const term = byKey.get(lossKey);
    if (!term) return;
    // The measured quantity first, then what it is costing the search. A satisfied constraint
    // reads "satisfied" rather than "0.00", because 0 next to a weight looks like the constraint
    // is switched off when it may be switched on and simply not violated.
    out[key] = term.value === 0
      ? 'satisfied'
      : `${term.value.toFixed(2)} → costs ${term.contribution.toFixed(2)} (${(term.contributionPct ?? 0).toFixed(0)}% of loss)`;
  });
  return out;
}

/**
 * The loss budget as a bar-per-term breakdown. Pure - returns HTML, renders nothing.
 *
 * The quantity every one of these numbers is denominated in is "as much as this many percentage
 * points of RTP error", because that is literally how the loss adds them up. Saying so is the
 * whole point: `spacingPenaltyWeight: 0.25` conveys nothing, while "reel spacing is worth 75 of
 * this loss and RTP error 21" conveys that the search is not doing what its operator thinks.
 */
export function renderLossBudgetHtml(lossPreview) {
  if (!lossPreview?.terms?.length) return '';
  const { terms, total, dominant, rtpIsDominant, penaltyNormalization } = lossPreview;
  const rows = terms.map(t => {
    const pct = t.contributionPct ?? 0;
    const isDominant = t.key === dominant;
    // A term switched off contributes nothing and has no bar - but it is still listed, because
    // "this is off" is information a developer looking for a missing constraint needs.
    const off = t.weight === 0 && t.key !== 'rtpError';
    return `<tr style="${isDominant ? 'background: rgba(255,255,255,0.05);' : ''}">
        <td style="padding: 3px 8px 3px 0; white-space: nowrap; color: ${off ? '#777' : '#ddd'};">${isDominant ? '▶ ' : ''}${esc(t.label)}</td>
        <td style="padding: 3px 8px 3px 0; text-align: right; color: #888; font-size: 0.9em;">${off ? 'off' : `×${t.weight}`}</td>
        <td style="padding: 3px 8px 3px 0; width: 110px;">
          <div style="height: 8px; border-radius: 4px; background: rgba(255,255,255,0.1); overflow: hidden;">
            <div style="height: 100%; width: ${pct.toFixed(0)}%; background: ${t.key === 'rtpError' ? '#7fbfff' : '#c58fff'};"></div>
          </div>
        </td>
        <td style="padding: 3px 8px 3px 0; text-align: right; white-space: nowrap; color: ${off ? '#777' : '#fff'};">${t.contribution.toFixed(2)}</td>
        <td style="padding: 3px 0; text-align: right; color: #9ab; font-size: 0.9em;">${pct.toFixed(0)}%</td>
      </tr>`;
  }).join('');

  const verdict = rtpIsDominant
    ? `<div style="font-size: 0.82em; color: #9ab; margin-top: 8px;">RTP error is the largest term, so the search is chiefly optimizing RTP — which is usually what you want.</div>`
    : `<div style="font-size: 0.82em; color: #e6b800; margin-top: 8px;"><strong>${esc(terms[0].label)}</strong> outweighs RTP error in this loss (${terms[0].contribution.toFixed(2)} against ${(terms.find(t => t.key === 'rtpError')?.contribution ?? 0).toFixed(2)}). The search will trade RTP away to satisfy it. That is a legitimate choice — but it should be one you made, not one you find out about after 150 iterations.</div>`;

  return `<div style="font-size: 0.78em; color: #9ab; margin-bottom: 8px;">
      measured once at the starting point · total loss ${total.toFixed(2)} ·
      ${penaltyNormalization === 'normalized'
        ? 'penalties normalized, so a weight of 1 is worth about one RTP point'
        : 'RAW penalty units — these are not comparable to each other or to RTP error'}
    </div>
    <table style="border-collapse: collapse; font-size: 0.82em; width: 100%;">${rows}</table>
    ${verdict}`;
}

export function renderDiagnosisHtml({ validation = [], structuralHeadroom = null, sensitivity = null, structuralRecommendation = null, lossPreview = null } = {}) {
  const sections = [];

  const card = (title, accent, body) => `
    <div style="background: rgba(255,255,255,0.05); border-left: 3px solid ${accent}; border-radius: 6px; padding: 10px 14px; margin-bottom: 10px;">
      <div style="font-size: 0.72em; letter-spacing: 0.08em; text-transform: uppercase; color: ${accent}; margin-bottom: 6px;">${title}</div>
      ${body}
    </div>`;

  // ---- Validation ----
  const errors = validation.filter(f => f.severity === 'error');
  const warnings = validation.filter(f => f.severity !== 'error');
  if (errors.length || warnings.length) {
    const row = (f) => `
      <div style="margin-bottom: 6px;">
        <div style="color: ${f.severity === 'error' ? '#ff9a9a' : '#ffcc66'}; font-size: 0.85em;">
          ${f.severity === 'error' ? '✖' : '⚠'} ${esc(f.message)}
        </div>
        <div style="color: #9ab; font-size: 0.78em; padding-left: 1.2em;">→ ${esc(f.suggestion)}</div>
      </div>`;
    sections.push(card(
      errors.length ? `${errors.length} problem${errors.length === 1 ? '' : 's'} must be fixed first` : `${warnings.length} warning${warnings.length === 1 ? '' : 's'}`,
      errors.length ? '#ff8080' : '#ffcc66',
      [...errors, ...warnings].map(row).join('')));
  }

  // ---- Structural headroom ----
  if (structuralHeadroom) {
    const { uniformRtp, targetRtp, reachableWithEvenFrequencies } = structuralHeadroom;
    const verdict = reachableWithEvenFrequencies
      ? `Even frequencies already pay <strong>${uniformRtp.toFixed(2)}%</strong> against a ${targetRtp}% target — the search will not need to skew anything to reach it.`
      : uniformRtp < targetRtp
      ? `Even frequencies pay only <strong>${uniformRtp.toFixed(2)}%</strong> against a ${targetRtp}% target. The frequency search can only close that by CONCENTRATING symbols, which is where over-abundance comes from — it is the optimizer compensating for a structural setting, not misbehaving.`
      : `Even frequencies pay <strong>${uniformRtp.toFixed(2)}%</strong>, above the ${targetRtp}% target. Frequencies alone can bring that down, but the structural knobs below do it without skewing anything.`;

    // Headroom and the sweep both measure the SAME quantity - RTP at even frequencies - at
    // different sample sizes, so they routinely disagree. Printed one above the other with no
    // comment (148.43% then 133.96%, observed) that reads as one of them being wrong. It is not:
    // it is the measurement noise being visible, and a gap wider than the sweep's own noise floor
    // is a genuine signal that both numbers need more spins before anything is decided on them.
    let reconciliation = '';
    if (sensitivity?.baseline?.rtp != null && Number.isFinite(sensitivity.noiseFloorPct)) {
      const gap = Math.abs(uniformRtp - sensitivity.baseline.rtp);
      reconciliation = gap > sensitivity.noiseFloorPct
        ? `<div style="font-size: 0.78em; color: #ffcc66; margin-top: 5px;">⚠ The sweep below measured the same thing at ${sensitivity.baseline.rtp.toFixed(2)}% — a ${gap.toFixed(1)}pp gap, wider than its own ±${sensitivity.noiseFloorPct.toFixed(2)}pp noise floor. Both numbers are under-sampled; raise Trial Spins before acting on either.</div>`
        : `<div style="font-size: 0.78em; color: #9ab; margin-top: 5px;">The sweep below measures the same thing at ${sensitivity.baseline.rtp.toFixed(2)}% on a smaller sample — a ${gap.toFixed(1)}pp gap, within its ±${sensitivity.noiseFloorPct.toFixed(2)}pp noise floor.</div>`;
    }
    sections.push(card('Structural headroom', '#7fbfff', `<div style="font-size: 0.85em; color: #ddd;">${verdict}</div>${reconciliation}`));
  }

  // ---- Which knob matters ----
  if (sensitivity?.knobs?.length) {
    const { knobs, routesToTarget, noiseFloorPct, baseline, targetRtp, measuredAt, spinsPerPoint } = sensitivity;
    // Bars scale against the strongest knob, so the top row is always full and every other row
    // reads as a fraction of it. Absolute scaling would make a game whose knobs are all weak look
    // identical to one whose knobs are all strong.
    const strongest = Math.max(...knobs.map(k => k.elasticityRtpPerUnit), 0);

    const knobRow = (k) => {
      const pct = strongest > 0 ? (k.elasticityRtpPerUnit / strongest) * 100 : 0;
      const lead = k.measurementUnreliable ? 'measurement failed'
        : k.flat ? 'no measurable effect'
        : `${k.elasticityRtpPerUnit.toFixed(1)}pp per unit`;
      const leadColour = k.measurementUnreliable ? '#ff9a9a' : k.flat ? '#777' : '#cfe6ff';
      const ladder = k.ladder.map(p => {
        const isCurrent = p.value === k.current;
        return `<span style="display: inline-block; padding: 1px 5px; margin: 1px; border-radius: 3px; ${
          isCurrent ? 'background: rgba(127,191,255,0.25); border: 1px solid rgba(127,191,255,0.6); color: #fff;' : 'color: #aab;'
        }">${p.value}: ${p.rtp.toFixed(0)}%</span>`;
      }).join('');
      const notes = [];
      if (k.measurementUnreliable && k.measurementNote) notes.push(esc(k.measurementNote));
      // The one knob with a discontinuity in it, flagged at the point of use rather than only in a
      // tooltip: a developer reaching for "more stacking" would otherwise reach straight past 0.9.
      if (k.knob === 'stackChance' && !k.flat) notes.push('1.0 is a MODE SWITCH, not more stacking — it pays far less than 0.7.');
      return `
        <tr>
          <td style="padding: 3px 8px 3px 0; white-space: nowrap; color: #ddd;">${esc(k.knob)}</td>
          <td style="padding: 3px 8px 3px 0; text-align: right; color: #fff; font-weight: bold;">${k.current}</td>
          <td style="padding: 3px 8px 3px 0; width: 90px;">
            <div style="height: 8px; border-radius: 4px; background: rgba(255,255,255,0.1); overflow: hidden;">
              <div style="height: 100%; width: ${pct.toFixed(0)}%; background: linear-gradient(90deg,#7fbfff,#c58fff);"></div>
            </div>
          </td>
          <td style="padding: 3px 10px 3px 0; white-space: nowrap; color: ${leadColour};">${lead}</td>
          <td style="padding: 3px 0;">${ladder}${notes.map(n => `<div style="color: #ffcc66; font-size: 0.92em; margin-top: 2px;">${n}</div>`).join('')}</td>
        </tr>`;
    };

    const routes = routesToTarget?.length ? `
      <div style="margin-top: 10px; padding-top: 8px; border-top: 1px solid rgba(255,255,255,0.12);">
        <div style="font-size: 0.78em; color: #8fb8ff; text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 4px;">To reach ${targetRtp}% from here — one knob at a time</div>
        ${routesToTarget.map(r => {
          const verb = r.knob === 'payoutScale' ? 'scale every payout by' : `set ${esc(r.knob)} to`;
          const value = r.value.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
          const detail = r.exact ? 'exact — RTP is strictly proportional to payouts'
            : `interpolated between ${r.interpolatedFrom.join(' and ')}`;
          return `<div style="font-size: 0.85em; color: #ddd;">• ${verb} <strong style="color:#fff;">${value}</strong>
            <span style="color: #9ab; font-size: 0.9em;">(${detail})</span></div>`;
        }).join('')}
      </div>` : '';

    sections.push(card('Which knob matters', '#c58fff', `
      <div style="font-size: 0.78em; color: #9ab; margin-bottom: 8px;">
        measured at ${measuredAt === 'uniform' ? 'EVEN symbol frequencies' : 'the current frequencies'},
        ${fmt(spinsPerPoint)} spins per point ·
        baseline ${baseline.rtp.toFixed(2)}% · target ${targetRtp}% ·
        noise floor ±${noiseFloorPct.toFixed(2)}pp
      </div>
      <table style="border-collapse: collapse; font-size: 0.82em; width: 100%;">${knobs.map(knobRow).join('')}</table>
      ${routes}`));
  }

  // ---- What the search is actually optimizing ----
  // Last, because it is a statement about everything above it: given this config and these
  // weights, here is what the loss is made of before a single iteration is spent.
  if (lossPreview?.terms?.length) {
    sections.push(card(
      lossPreview.rtpIsDominant ? 'What the search will optimize' : 'What the search will optimize — not RTP',
      lossPreview.rtpIsDominant ? '#7fbfff' : '#e6b800',
      renderLossBudgetHtml(lossPreview)));
  }

  // ---- What to set them to (Phase 0d) ----
  // Deliberately LAST, under the per-knob table it is built from: the table explains why these
  // values, and a recommendation read without that explanation is a number to obey rather than a
  // proposal to judge. The whole point is that it can be rejected.
  if (structuralRecommendation) {
    const rec = structuralRecommendation;
    const changed = Object.entries(rec.changed ?? {});
    // Amber for an unresolvable run as much as for a missed target: a recommendation the
    // measurements cannot support should not be wearing the same green as one they do.
    const accent = (rec.reachedTarget && rec.resolvable !== false) ? '#7fd97f' : '#e6b800';
    const rows = Object.entries(rec.knobs ?? {}).map(([knob, value]) => {
      const from = rec.current?.[knob];
      const moved = value !== from;
      return `<tr>
          <td style="padding: 3px 10px 3px 0; color: #ddd;">${esc(knob)}</td>
          <td style="padding: 3px 10px 3px 0; text-align: right; color: #888;">${from}</td>
          <td style="padding: 3px 6px 3px 0; color: #666;">${moved ? '→' : '='}</td>
          <td style="padding: 3px 0; font-weight: bold; color: ${moved ? '#fff' : '#888'};">${value}</td>
        </tr>`;
    }).join('');

    const verdict = rec.note
      ? `<div style="font-size: 0.82em; color: ${rec.reachedTarget ? '#9ab' : '#e6b800'}; margin-top: 8px;">${esc(rec.note)}</div>`
      : `<div style="font-size: 0.85em; color: #ddd; margin-top: 8px;">Measured <strong style="color:#fff;">${rec.measuredRtp.toFixed(2)}%</strong> against a ${rec.targetRtp}% target, at even symbol frequencies — so the frequency search would start from here rather than having to invent the difference by skewing symbols.</div>`;

    sections.push(card(
      rec.resolvable === false ? 'What to set them to — not resolvable at this sample size'
        : changed.length ? 'What to set them to'
        : 'What to set them to — no change needed',
      accent,
      `<div style="font-size: 0.78em; color: #9ab; margin-bottom: 8px;">
         searched ${rec.knobsSearched.map(esc).join(', ') || 'nothing'} jointly ·
         ${rec.measurementsUsed} combination${rec.measurementsUsed === 1 ? '' : 's'} measured
         ${rec.respectedDesignIntent === false ? '· closest to target' : '· smallest change that hits target'}
       </div>
       ${rows ? `<table style="border-collapse: collapse; font-size: 0.85em;">${rows}</table>` : ''}
       ${verdict}
       ${changed.length ? `<div style="margin-top: 8px; font-family: monospace; font-size: 0.8em; color: #cfe6ff; background: rgba(0,0,0,0.3); border-radius: 4px; padding: 6px 8px; overflow-x: auto;">defaults: { ${changed.map(([k, v]) => `${esc(k)}: ${v}`).join(', ')}, … }</div>` : ''}
       <div style="font-size: 0.75em; color: #888; margin-top: 6px;">A suggestion only — nothing has been changed. These go in each reel's <code>defaults</code> block.</div>
       <!-- Revealed by the results block once there is a copyable output to apply it TO. Hidden
            rather than conditionally rendered, so this formatter stays pure and DOM-free. -->
       ${changed.length ? `<button id="tune-structural-apply" class="btn-icon btn-sim-btn" style="display: none; margin-top: 8px; padding: 4px 10px; font-size: 0.75em;">APPLY TO THE OUTPUT BELOW</button>` : ''}`));
  }

  return sections.join('');
}

// Shared symbol-type -> color mapping, used anywhere a symbol name is listed next to others of
// mixed type (the TUNE FREQUENCIES live/results tables) so type is visible at a glance without
// needing a separate column or section per type. Deliberately distinct from the gauge's own
// palette (configured/tested bands, current tick) so the two don't read as related.
function symbolTypeColor(type) {
  switch (type) {
    case 'scatter': return '#ffd700';
    case 'wild': return '#c792ea';
    case 'premium': return '#7ec8ff';
    case 'regular': return '#eee';
    default: return '#888';
  }
}

// A symbol name span colored by its paytable type, with a title (hover) attribute spelling out
// the friendly name and type explicitly for anyone who can't rely on color alone. `displayText`
// defaults to the raw symbol key (compact, for the space-constrained live gauge table) but can
// be overridden (e.g. to the friendly name) where there's room for it.
function renderSymbolLabel(symbol, paytable, displayText = symbol) {
  const meta = paytable?.[symbol];
  const type = meta?.type || 'other';
  const friendlyName = meta?.friendlyName || symbol;
  const color = symbolTypeColor(type);
  const title = `${friendlyName} (${type})`;
  return `<span title="${title}" style="color: ${color}; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${displayText}</span>`;
}

/**
 * Runs tuneFrequencies() on this thread, backed by a pool of Worker threads (see
 * core/SimulationWorkerPool.js) that each individual Monte Carlo trial is dispatched to - so
 * the potentially long search still never blocks page rendering/input, and now spreads its
 * actual CPU work across every available core instead of just one.
 *
 * tuneFrequencies' own control flow (building candidate reel tables, penalty math, deciding the
 * next Nelder-Mead/gradient-descent step) is cheap - a handful of numbers over at most a few
 * hundred tunable dimensions - so it's safe to run right here rather than isolated in its own
 * dedicated Worker the way it used to be; the actual expensive part (simulateSpins over
 * hundreds of thousands of spins) always runs on a pool Worker's own thread via `runTrial`.
 *
 * `runTrial`'s own `config` (real `mechanic`/`winEvaluator`/`freeSpinsMode` objects/functions,
 * since tuneFrequencies runs in-process here) can't cross postMessage to a pool Worker as-is -
 * converted to names the same way the old dedicated-worker version did for its whole options
 * object (see mechanicName/winEvaluatorName/freeSpinsModeName below).
 * @returns {Promise<{ reelFrequencyTables: Object[], rtp: number, triggerRatePct: number, diagnostics: Object }>}
 */
async function runTuneFrequenciesWithPool(paytable, reelFrequencyTables, options, onProgress) {
  // winEvaluatorName/minClusterSize/scatterTriggerCount are pool-dispatch metadata only -
  // tuneFrequencies itself never reads them (a cascade game's real winEvaluator, still a real
  // closure, is passed straight through in `tuneOptions` below for the (unused when runTrial is
  // set) in-process fallback path).
  const { winEvaluatorName: explicitWinEvaluatorName, minClusterSize, scatterTriggerCount, ...tuneOptions } = options;
  const pool = createSimulationWorkerPool();
  try {
    return await tuneFrequencies(paytable, reelFrequencyTables, {
      ...tuneOptions,
      // Passed through as well as being used for pool dispatch below. These stopped being purely
      // dispatch metadata once Phase 0a validation started reading them: without them the
      // cluster-size-reachable and payout-ladder-floor checks silently never fire from the panel,
      // which is exactly the kind of "the feature is there but reaches nothing" gap this package
      // exists to close.
      minClusterSize, scatterTriggerCount,
      onProgress,
      runTrial: (config, numSpins, betPerLine, linesCount, rngSeed) => {
        const { mechanic, winEvaluator, freeSpinsMode, ...restConfig } = config;
        const cloneableConfig = {
          ...restConfig,
          mechanicName: mechanic ? mechanic.name : null,
          // A cascade game's winEvaluator is a per-game closure baking in its own paytable/
          // minClusterSize/scatterSymbol (see CascadeMath.js's own doc), so `.name` (just the
          // closure's own variable name, e.g. 'winEvaluator') can't identify it - the explicit
          // override from tuneConfig (e.g. 'checkClusterWins') wins over any derived name.
          winEvaluatorName: explicitWinEvaluatorName ?? (winEvaluator ? winEvaluator.name : null),
          freeSpinsModeName: freeSpinsMode ? freeSpinsMode.name : null,
          minClusterSize,
          scatterTriggerCount,
        };
        return pool.runTrial(cloneableConfig, numSpins, betPerLine, linesCount, rngSeed);
      },
    });
  } finally {
    pool.terminate();
  }
}

function renderWinTable(counts, hitLabel, accentColor, emptyText) {
  const sortedKeys = Object.keys(counts).sort((a, b) => a - b);
  if (sortedKeys.length === 0) {
    return `<div style="color: #666; font-style: italic; font-size: 0.8em;">${emptyText}</div>`;
  }
  let html = `<table style="width: 100%; border-collapse: collapse; font-size: 0.95em;">`;
  html += `<thead><tr style="color: #888; font-size: 0.8em; text-transform: uppercase;">
              <th style="text-align: left; font-weight: normal; padding: 2px 4px 4px 0;">${hitLabel}</th>
              <th style="text-align: right; font-weight: normal; padding: 2px 4px 4px;">Wins</th>
              <th style="text-align: right; font-weight: normal; padding: 2px 4px 4px;">Avg Win</th>
              <th style="text-align: right; font-weight: normal; padding: 2px 0 4px;">Total Win</th>
            </tr></thead><tbody>`;
  sortedKeys.forEach(key => {
    const data = counts[key];
    const avg = data.totalAmount / data.count;
    html += `<tr>
                <td style="padding: 2px 4px 2px 0; color: ${accentColor};">${key}</td>
                <td style="text-align: right; padding: 2px 4px;">${data.count}</td>
                <td style="text-align: right; padding: 2px 4px;">$${fmt(avg)}</td>
                <td style="text-align: right; padding: 2px 0; font-weight: bold;">$${fmt(data.totalAmount)}</td>
              </tr>`;
  });
  html += `</tbody></table>`;
  return html;
}

// `labels` overrides the primary (non-scatter, non-wild-assisted, non-alone, non-expanding)
// win bucket's header/column - defaults to the line-pay wording; a cascade mechanic's caller
// passes its own (see CascadeSpinMechanic.statsLabels: 'Cluster Wins'/'Cluster Size') so a
// cluster win doesn't get mislabeled as a payline hit.
function createSection(title, symbols, symbolStats, paytable, labels = { primaryHeader: 'Normal Wins', hitLabel: 'Hits' }) {
  if (symbols.length === 0) return `<div style="color: #666; font-style: italic; font-size: 0.8em;">No wins found for ${title}</div>`;
  let sectionHtml = `<h4 style="margin: 15px 0 10px 0; color: #aaa; text-transform: uppercase; font-size: 0.75em; letter-spacing: 1px;">${title}</h4>`;
  sectionHtml += `<div style="display: grid; grid-template-columns: repeat(5, 1fr); gap: 12px;">`;

  symbols.forEach(symbol => {
    const stats = symbolStats[symbol] || { counts: {}, wildAssisted: { counts: {} }, alone: { counts: {} }, expanding: { counts: {} } };
    const friendlyName = paytable[symbol]?.friendlyName || symbol;
    const isScatter = paytable[symbol]?.type === 'scatter';

    sectionHtml += `<div style="border: 1px solid rgba(255,255,255,0.2); padding: 12px; border-radius: 8px; background: rgba(255,255,255,0.05); font-size: 0.85em;">`;
    sectionHtml += `<strong style="display: block; margin-bottom: 8px; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 4px;">${friendlyName}</strong>`;

    sectionHtml += `<div style="margin-bottom: 8px;">`;
    sectionHtml += `<span style="font-size: 0.7em; color: #999; text-transform: uppercase;">${isScatter ? 'Scatter Wins' : labels.primaryHeader}</span>`;
    sectionHtml += renderWinTable(stats.counts, labels.hitLabel, '#ccc', isScatter ? 'No scatter wins' : `No ${labels.primaryHeader.toLowerCase()}`);
    sectionHtml += `</div>`;

    // Wild-assisted matches (natural run one short of a full line, completed by a wild) are
    // reported apart from natural hits above - otherwise a full-payout wild-completed win
    // reads like a partial pay for symbols that don't actually have one.
    if (stats.wildAssisted && Object.keys(stats.wildAssisted.counts).length > 0) {
      sectionHtml += `<div style="margin-top: 8px; padding-top: 4px; border-top: 1px dashed rgba(255,255,255,0.1);">`;
      sectionHtml += `<span style="font-size: 0.7em; color: #7ec8ff; text-transform: uppercase;">Wild-Assisted Wins</span>`;
      sectionHtml += renderWinTable(stats.wildAssisted.counts, 'Natural Hits', '#7ec8ff', '');
      sectionHtml += `</div>`;
    }

    // A wild's standalone "alone bonus" pays out regardless of what's elsewhere on the
    // line, so it's tallied under the wild symbol itself rather than whatever unrelated
    // symbol happened to land in reel 1.
    if (stats.alone && Object.keys(stats.alone.counts).length > 0) {
      sectionHtml += `<div style="margin-top: 8px; padding-top: 4px; border-top: 1px dashed rgba(255,255,255,0.1);">`;
      sectionHtml += `<span style="font-size: 0.7em; color: #ffb27e; text-transform: uppercase;">Alone Bonus</span>`;
      sectionHtml += renderWinTable(stats.alone.counts, 'Landed', '#ffb27e', '');
      sectionHtml += `</div>`;
    }

    if (stats.expanding && Object.keys(stats.expanding.counts).length > 0) {
      sectionHtml += `<div style="margin-top: 8px; padding-top: 4px; border-top: 1px dashed rgba(255,255,255,0.1);">`;
      sectionHtml += `<span style="font-size: 0.7em; color: #ffd700; text-transform: uppercase;">Expanding Wins</span>`;
      sectionHtml += renderWinTable(stats.expanding.counts, 'Reels', '#ffd700', '');
      sectionHtml += `</div>`;
    }

    sectionHtml += `</div>`;
  });

  sectionHtml += `</div>`;
  return sectionHtml;
}

/**
 * Groups a paytable's symbols by their `type` field (in first-seen order, 'other' for
 * symbols with no type), for rendering one section per type in the win breakdown. This
 * is purely data-driven - it reflects whatever `type` values the caller's paytable uses,
 * with no hardcoded symbol or type name.
 */
function groupSymbolsByType(paytable) {
  const order = [];
  const groups = {};
  Object.keys(paytable).forEach(symbol => {
    const type = paytable[symbol].type || 'other';
    if (!groups[type]) {
      groups[type] = [];
      order.push(type);
    }
    groups[type].push(symbol);
  });
  return order.map(type => ({ type, symbols: groups[type] }));
}

/**
 * Runs engine.runSimulation() and renders the results (stats + detailed win breakdown)
 * into the given DOM refs.
 * @param {Object} args
 * @param {Object} args.engine - a SlotEngine instance (has .runSimulation())
 * @param {Object} args.paytable
 * @param {number} args.betPerLine
 * @param {number} args.linesCount
 * @param {number} [args.numSpins=1000000]
 * @param {Object} [args.labels] - Primary win-bucket header/column override for a non-line-pay
 *   mechanic (see createSection's own doc) - e.g. CascadeSpinMechanic.statsLabels for Candy
 *   Frenzy's RUN SIMULATION button. Defaults to the line-pay wording.
 * @param {Object} args.domRefs
 */
export function runSimulationAndRender({ engine, paytable, betPerLine, linesCount, numSpins = 1000000, labels, domRefs }) {
  const { btnSim, simModal, simStats, simRtpDisplay, simTotalSpinsDisplay, simMaxWinDisplay, simFreeSpinsDisplay } = domRefs;

  btnSim.textContent = 'RUNNING...';
  btnSim.disabled = true;

  setTimeout(() => {
    try {
      // Every run is seeded (even though no UI exposes the value to type back in yet) so the
      // exported spin log's "Seed" column is always meaningful provenance, not a placeholder -
      // note it down and pass it to engine.runSimulation(..., { seed }) to reproduce this run.
      const seed = Math.floor(Math.random() * 2 ** 31);
      const startedAt = new Date().toISOString();
      const results = engine.runSimulation(numSpins, betPerLine, linesCount, { seed, logSpins: true });

      if (simStats) simStats.style.display = '';
      simRtpDisplay.textContent = results.rtp;
      simTotalSpinsDisplay.textContent = results.totalSpins;
      simMaxWinDisplay.textContent = `$${results.maxWin}`;
      const pct = results.totalSpins > 0 ? (results.freeSpinsTriggered / results.totalSpins) * 100 : 0;
      simFreeSpinsDisplay.textContent = `${results.freeSpinsTriggered} (${pct.toFixed(2)}%)`;

      function bump(bucket, key, amount) {
        if (!bucket[key]) bucket[key] = { count: 0, totalAmount: 0 };
        bucket[key].count += 1;
        bucket[key].totalAmount += amount;
      }

      const symbolStats = {};
      results.detailedWins.forEach(win => {
        if (!symbolStats[win.symbol]) {
          symbolStats[win.symbol] = { counts: {}, wildAssisted: { counts: {} }, alone: { counts: {} }, expanding: { counts: {} } };
        }
        const stats = symbolStats[win.symbol];
        if (win.type === 'expanding') {
          bump(stats.expanding.counts, win.count, win.winAmount);
        } else if (win.type === 'alone') {
          bump(stats.alone.counts, win.count, win.winAmount);
        } else if (win.wildUsed) {
          bump(stats.wildAssisted.counts, win.count, win.winAmount);
        } else {
          bump(stats.counts, win.count, win.winAmount);
        }
      });

      let detailsContainer = simModal.querySelector('#sim-details');
      if (!detailsContainer) {
        detailsContainer = document.createElement('div');
        detailsContainer.id = 'sim-details';
        detailsContainer.style.marginTop = '20px';
        detailsContainer.style.padding = '15px';
        detailsContainer.style.background = 'rgba(255, 255, 255, 0.1)';
        detailsContainer.style.borderRadius = '12px';
        detailsContainer.style.fontSize = '0.9em';
        simModal.appendChild(detailsContainer);
      } else {
        detailsContainer.innerHTML = '';
      }

      let detailsHtml = '<h3 style="margin-top: 0; border-bottom: 1px solid rgba(255,255,255,0.2); padding-bottom: 8px;">Detailed Win Breakdown</h3>';
      detailsHtml += `<div style="display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 15px; font-size: 0.85em; color: #aaa;">
                        <span title="Pass this to engine.runSimulation(..., { seed }) to reproduce this exact run">Seed: <strong style="color: #ccc;">${seed}</strong></span>
                        <button id="sim-export-log-btn" class="btn-icon btn-sim-btn" style="padding: 6px 14px; font-size: 0.9em;">EXPORT SPIN LOG (CSV)</button>
                      </div>`;
      groupSymbolsByType(paytable).forEach(({ type, symbols }) => {
        const title = type.charAt(0).toUpperCase() + type.slice(1) + ' Symbols';
        detailsHtml += labels ? createSection(title, symbols, symbolStats, paytable, labels) : createSection(title, symbols, symbolStats, paytable);
      });
      detailsContainer.innerHTML = detailsHtml;

      detailsContainer.querySelector('#sim-export-log-btn').addEventListener('click', () => {
        exportSpinLogCsv(results.spinLog, { seed, startedAt, filenamePrefix: 'spinlog' });
      });

      simModal.style.display = 'block';
      simModal.style.maxWidth = '1200px';
      simModal.style.width = '95%';
    } catch (error) {
      console.error('Simulation failed:', error);
      alert('Error running simulation');
    } finally {
      btnSim.textContent = 'RUN SIMULATION';
      btnSim.disabled = false;
    }
  }, 50);
}

/**
 * Formats an array of per-reel frequency tables back out as paste-ready
 * `export const FREQUENCY_REELn = { ... }` literals, column-aligned - matching the exact
 * style already used in games/fruitmachine/game.js.
 */
// A fixed decimal-place count (the previous `.toFixed(1)`) is fine for frequencies in the
// tens (fruitmachine's bar: 25.3) but is catastrophically lossy for frequencies under 1
// (bookbookbook's book: 0.051 and explorer: 0.079 both rounded to "0.1" - two symbols with
// nearly 2x different rarity reading back as identical). Significant figures scale with
// magnitude instead, so both ranges keep enough precision to survive a copy/paste
// round-trip without silently corrupting the tuned result.
function formatFrequencyForCopy(freq) {
  if (freq === 0) return '0';
  return Number(freq.toPrecision(4)).toString();
}

// Payouts, unlike frequencies, are read back by humans as design values ("a 5-cluster of a
// premium pays 0.75x"), so they keep more precision than formatFrequencyForCopy's 4 s.f. - a
// scale of 0.6922 turns 0.75 into 0.51915, and rounding that to 0.5192 is a silent 0.01% RTP
// drift the developer never asked for.
// Greedy word wrap into `// ` comment lines at the same 100-column budget the surrounding source
// uses, so an emitted explanation reads like the file it is pasted into.
function wrapAsComment(text, width = 96) {
  const lines = [];
  let line = '';
  text.split(/\s+/).filter(Boolean).forEach(word => {
    if (line && (line.length + 1 + word.length) > width) { lines.push(line); line = word; }
    else line = line ? `${line} ${word}` : word;
  });
  if (line) lines.push(line);
  return lines.map(l => `// ${l}`).join('\n');
}

function formatPayoutForCopy(v) {
  if (typeof v !== 'number') return JSON.stringify(v);
  if (v === 0) return '0';
  return Number(v.toPrecision(6)).toString();
}

/**
 * Renders a `scaledPaytable` (from tuneFrequencies' `solvePayoutScale`) as paste-ready code.
 *
 * Cluster games declare a small number of SHARED ladders - Candy Frenzy has exactly two,
 * `PREMIUM_PAYOUT` and `REGULAR_PAYOUT`, with six symbols pointing at each - so emitting one
 * literal per symbol would be technically correct and practically useless: the developer's source
 * has two constants to paste over, not twelve object literals to reassemble by hand. Ladders are
 * therefore grouped by VALUE (not by reference, which `scalePaytable`'s per-entry copy has already
 * broken), and each group is named after the `type` its members share - which on the real target
 * game reproduces the source's own constant names exactly.
 *
 * Line-pay games instead carry a distinct `payout` array per symbol with no shared structure to
 * preserve, so those are emitted as per-symbol replacement lines. The asymmetry is deliberate: in
 * both cases the output matches the shape of the declaration it is meant to replace.
 */
export function formatScaledPaytableForCopy(scaledPaytable, payoutScale = null) {
  if (!scaledPaytable) return '';
  const scale = payoutScale?.scale;

  // ---- cluster ladders, grouped by value ----
  const groups = new Map(); // serialized ladder -> { tiers, symbols, types }
  // ---- line-pay payout arrays, per symbol ----
  const lineRows = [];

  Object.keys(scaledPaytable).forEach(sym => {
    const entry = scaledPaytable[sym];
    if (Array.isArray(entry.clusterPayout)) {
      const key = JSON.stringify(entry.clusterPayout);
      if (!groups.has(key)) groups.set(key, { tiers: entry.clusterPayout, symbols: [], types: new Set() });
      const g = groups.get(key);
      g.symbols.push(sym);
      if (entry.type) g.types.add(entry.type);
    } else if (Array.isArray(entry.payout)) {
      lineRows.push([sym, entry.payout]);
    }
    // Everything else - scatters, wilds, anything with no payout data - is carried through
    // unchanged by scalePaytable and has nothing to paste, so it is omitted rather than
    // emitted as an empty stub the developer would have to recognize as a no-op.
  });

  const blocks = [];
  const usedNames = new Set();
  groups.forEach(g => {
    // Unanimous type -> the name the source almost certainly already uses. Mixed or missing
    // type -> an indexed fallback, since guessing a name wrong is worse than not guessing.
    let base = g.types.size === 1 ? `${[...g.types][0].toUpperCase()}_PAYOUT` : `CLUSTER_PAYOUT_${blocks.length + 1}`;
    let name = base;
    for (let n = 2; usedNames.has(name); n++) name = `${base}_${n}`;
    usedNames.add(name);

    const minWidth = Math.max(...g.tiers.map(t => String(t.min).length));
    const lines = g.tiers.map(t => `  { min: ${String(t.min).padStart(minWidth)}, multiplier: ${formatPayoutForCopy(t.multiplier)} },`);
    blocks.push(`// Used by: ${g.symbols.join(', ')}\nexport const ${name} = [\n${lines.join('\n')}\n];`);
  });

  if (lineRows.length > 0) {
    const keyWidth = Math.max(...lineRows.map(([s]) => s.length + 1));
    const rows = lineRows.map(([sym, payout]) =>
      `//   ${`${sym}:`.padEnd(keyWidth)} payout: [${payout.map(formatPayoutForCopy).join(', ')}],`);
    blocks.push(`// Replace each symbol's \`payout:\` array in PAYTABLE:\n${rows.join('\n')}`);
  }

  if (blocks.length === 0) return '';

  const header = [
    `// ---- Scaled paytable (payout scale ${scale != null ? Number(scale.toPrecision(6)) : '?'}) ----`,
    `// RTP is strictly proportional to a global multiplier on every payout, so this is exact`,
    `// arithmetic rather than a search result${payoutScale?.rtpBeforeScaling != null
      ? `: ${payoutScale.rtpBeforeScaling.toFixed(2)}% x ${Number(scale.toPrecision(6))} = target.`
      : '.'}`,
    payoutScale?.verified === true
      ? `// Confirmed by measurement under the scaled paytable: ${payoutScale.verifiedRtp?.toFixed(2)}% RTP.`
      : payoutScale?.verified === false
      // Wrapped rather than emitted as one line: this note runs to several sentences (it has to -
      // it distinguishes three different causes with different fixes), and a 400-column comment
      // pasted into game.js is a comment nobody reads.
      ? wrapAsComment(`NOT CONFIRMED by measurement. ${payoutScale.verificationNote ?? `Measured ${payoutScale.verifiedRtp?.toFixed(2)}%.`}`)
      : null,
  ].filter(l => l !== null).join('\n');

  return `${header}\n${blocks.join('\n\n')}`;
}

/**
 * The payout-scale solve as it appears in the results panel. Pure - returns HTML, renders nothing.
 * Empty string when no solve was run, so the caller can drop it in unconditionally.
 */
export function renderPayoutScaleHtml(payoutScale, { targetRtp } = {}) {
  if (!payoutScale) return '';
  const scale = Number(payoutScale.scale.toPrecision(6));
  const direction = scale < 1 ? 'down' : 'up';
  const pct = Math.abs((scale - 1) * 100).toFixed(1);
  // Confirmed and unconfirmed are drawn differently on purpose. The scale is exact arithmetic
  // either way, but a game whose winEvaluator captured its own paytable measures the ORIGINAL
  // payouts on the verification run - and presenting that identically to a confirmed result is
  // how a paytable nobody checked ends up shipped.
  const ok = payoutScale.verified === true;
  return `<div style="margin: 10px 0; padding: 10px 12px; border-radius: 6px; background: rgba(127,191,255,0.1); border-left: 3px solid ${ok ? '#7fbfff' : '#e6b800'};">
      <div style="font-size: 0.85em; color: #cfe6ff; font-weight: bold;">Payout scale ${scale} &mdash; every payout ${direction} ${pct}%</div>
      <div style="font-size: 0.78em; color: #ccc; margin-top: 4px;">
        These frequencies pay <strong>${payoutScale.rtpBeforeScaling.toFixed(2)}%</strong>; scaling every payout by
        <strong>${scale}</strong> lands on ${targetRtp != null ? `${targetRtp}%` : 'target'}. RTP is strictly proportional to a
        global payout multiplier, so this is exact rather than another thing to search for.
      </div>
      ${ok
        ? `<div style="font-size: 0.75em; color: #7fd97f; margin-top: 4px;">Confirmed by measurement under the scaled paytable: <strong>${payoutScale.verifiedRtp.toFixed(2)}%</strong>.</div>`
        : `<div style="font-size: 0.75em; color: #e6b800; margin-top: 4px;"><strong>Not confirmed</strong> &mdash; ${esc(payoutScale.verificationNote ?? `the check run measured ${payoutScale.verifiedRtp.toFixed(2)}%, not the ${targetRtp ?? 'target'}% the arithmetic requires.`)}</div>`}
      <div style="font-size: 0.75em; color: #888; margin-top: 4px;">The scaled paytable is in the copyable output below. Nothing here has changed your game's paytable.</div>
    </div>`;
}

export function formatReelFrequencyTablesForCopy(reelFrequencyTables, context = null) {
  const tables = reelFrequencyTables.map((table, i) => {
    // Phase 0d's recommendation, applied at EMIT time only. The running game, the tuned tables and
    // the measured RTP above all still describe the config as it was searched - overwriting them
    // would silently attach a number to settings it was never measured under. What this produces
    // is a starting point to paste and re-tune from, which is what "accept the recommendation"
    // actually means.
    const defaults = { ...(table.defaults || {}), ...(context?.structuralDefaults ?? {}) };
    const symbolsTable = table.symbols || table;
    const symbols = Object.keys(symbolsTable);
    if (symbols.length === 0) return `export const FREQUENCY_REEL${i + 1} = {\n  defaults: {},\n  symbols: {},\n};`;

    const defaultsParts = [];
    if (defaults.minGap != null) defaultsParts.push(`minGap: ${defaults.minGap}`);
    if (defaults.maxStack != null) defaultsParts.push(`maxStack: ${defaults.maxStack}`);
    if (defaults.minStack != null) defaultsParts.push(`minStack: ${defaults.minStack}`);
    // stackChance was previously omitted here, which silently DELETED it on paste-back.
    // generateReel reads it (resolveStackChance) and falls back to 1 when absent - and 1 takes a
    // different code path entirely (_computeClusterSizes rather than _computeStackedPlacements).
    // On a cluster game that is not a subtle difference: Candy Frenzy measures 9.7% RTP at
    // stackChance 0.10 and 94.5% at 0.50, so losing the field turned a tuned result into a
    // completely different game the moment it was pasted back.
    if (defaults.stackChance != null) defaultsParts.push(`stackChance: ${defaults.stackChance}`);
    if (defaults.minFrequency != null) defaultsParts.push(`minFrequency: ${defaults.minFrequency}`);
    if (defaults.maxFrequency != null) defaultsParts.push(`maxFrequency: ${defaults.maxFrequency}`);
    const defaultsLine = `  defaults: { ${defaultsParts.join(', ')} },`;

    const keyWidth = Math.max(...symbols.map(s => s.length + 1));
    const lines = symbols.map(symbol => {
      const entry = symbolsTable[symbol];
      const keyPart = `${symbol}:`.padEnd(keyWidth);
      const minGapPart = entry.minGap != null ? `, minGap: ${entry.minGap}` : '';
      const maxStackPart = entry.maxStack != null ? `, maxStack: ${entry.maxStack}` : '';
      const minStackPart = entry.minStack != null ? `, minStack: ${entry.minStack}` : '';
      const stackChancePart = entry.stackChance != null ? `, stackChance: ${entry.stackChance}` : '';
      const fixedPart = entry.fixed ? ', fixed: true' : '';
      const minPart = entry.minFrequency != null ? `, minFrequency: ${entry.minFrequency}` : '';
      const maxPart = entry.maxFrequency != null ? `, maxFrequency: ${entry.maxFrequency}` : '';
      return `    ${keyPart} { frequency: ${formatFrequencyForCopy(entry.frequency)}${minGapPart}${maxStackPart}${minStackPart}${stackChancePart}${fixedPart}${minPart}${maxPart} },`;
    });
    return `export const FREQUENCY_REEL${i + 1} = {\n${defaultsLine}\n  symbols: {\n${lines.join('\n')}\n  },\n};`;
  }).join('\n\n');

  if (!context) return tables;

  // Everything needed to REPRODUCE this result on a later run, not just the frequencies it
  // produced. Frequencies alone are not a reproducible artifact: the same numbers pasted back
  // against a different reel length, seed set, or paytable build a different set of strips and
  // therefore a different game. REEL_LENGTH in particular is emitted as real code because the
  // panel lets it be changed per run, so a result tuned at one length silently misreports itself
  // if pasted into a game still declaring another.
  const p = context.inputParameters ?? {};
  const num = (v, d = 4) => (typeof v === 'number' ? Number(v.toFixed(d)) : v);
  const weights = [
    ['ordering', p.orderingPenaltyWeight], ['limit', p.limitPenaltyWeight],
    ['uniformity', p.uniformityPenaltyWeight], ['stdError', p.stdErrorPenaltyWeight],
    ['triggerRate', p.triggerRatePenaltyWeight], ['spacing', p.spacingPenaltyWeight],
  ].filter(([, v]) => v != null).map(([k, v]) => `${k} ${v}`).join(', ');

  const header = [
    `// ---- Tuned ${new Date().toISOString().slice(0, 10)} ----`,
    `// Achieved: RTP ${num(context.rtp, 2)}%  |  free-spin trigger ${num(context.triggerRatePct, 3)}%`,
    `//`,
    `// To reproduce this exact run, the tuner needs all of the following - same searchSeed AND`,
    `// same reel geometry, since strips are generated from them:`,
    `//   searchSeed ${p.searchSeed}   reelSeeds [${(p.reelSeeds ?? []).join(', ')}]`,
    `//   reelLength ${p.reelLength}   reels ${p.reelsCount} x ${p.rowsCount} rows`,
    `//   target RTP ${p.targetRtp}% +/-${p.rtpTolerancePct}   target trigger ${p.targetTriggerRatePct}% +/-${p.triggerRateTolerancePct}`,
    `//   ${p.trialSpins?.toLocaleString()} spins x ${p.trialsPerPoint} trials   ${p.searchAlgorithm}, max ${p.maxIterations} iterations`,
    `//   initial weights: ${p.initialWeightStrategy}   max RTP std error ${p.maxRtpStdError}`,
    // Coupling changes what the result MEANS, not just how it was found: the same frequencies
    // reached with one shared weight per symbol and with one per (symbol, reel) came out of
    // searches with very different degrees of freedom, and only the first guarantees the reels
    // are not lopsided relative to each other.
    p.reelCoupling ? `//   reelCoupling ${p.reelCoupling}   maxReelDeviation ${p.maxReelDeviation}` : null,
    // WITH the denomination, always. The same weights mean entirely different things in the two:
    // measured on Candy Frenzy a raw spacing weight of 0.25 is worth 43.75 of the loss against an
    // RTP error term of 1.76, and normalized it is worth a small fraction of one point. A weight
    // list without its denomination does not describe a run.
    weights ? `//   loss weights (${p.penaltyNormalization ?? 'raw'}): ${weights}` : null,
    p.orderingBiasByReel ? `//   ordering bias by reel: [${p.orderingBiasByReel.join(', ')}]` : null,
    `//`,
    `// REEL_LENGTH is part of the result, not a separate setting - these frequencies were tuned`,
    `// against this length and do not reproduce the RTP above at any other.`,
    `export const REEL_LENGTH = ${p.reelLength};`,
    // Applying the Phase 0d recommendation changes the reels these frequencies were searched
    // against, so the RTP reported at the top of this header no longer describes what is below it.
    // Said plainly rather than left for the reader to notice, because a header that silently
    // misdescribes its own contents is worse than no header.
    context.structuralDefaults
      ? `\n// NOTE: the structural recommendation has been applied to the defaults below. The RTP at the\n`
        + `// top of this header was measured BEFORE that change - re-tune from these settings to get a\n`
        + `// figure that describes them.`
      : null,
    ``,
  ].filter(l => l !== null).join('\n');

  // Same reasoning as REEL_LENGTH directly above: a result that depends on a rescaled paytable is
  // not reproducible from frequencies alone. Pasting these frequencies back WITHOUT the scaled
  // payouts reproduces the RTP the search started from, not the one reported at the top.
  const paytableBlock = context.scaledPaytable
    ? `${formatScaledPaytableForCopy(context.scaledPaytable, context.payoutScale)}\n\n`
    : '';

  return `${header}\n${paytableBlock}${tables}`;
}

/**
 * Opens (or reuses) the frequency auto-balancer panel (SpinSimulator.js's tuneFrequencies)
 * with inputs for the tuning targets, showing live iteration-by-iteration progress. Only
 * ever reports a suggestion - never mutates the caller's live paytable/reels itself
 * (applying a result means regenerating reel strips, a deliberate source change).
 * @param {Object} args
 * @param {Object} args.paytable
 * @param {Object[]} args.reelFrequencyTables - One table per reel, each `{ symbol: { frequency } }`.
 * @param {Object} args.tuneConfig - { reelsCount, rowsCount, paylines, reelSeeds, betPerLine, linesCount, reelLength, winEvaluator, wildSymbol, scatterSymbol }.
 *   A cascade game additionally sets `mechanic` (CascadeSpinMechanic), `freeSpinsMode`, and -
 *   since its winEvaluator is a per-game closure, not a reusable named function -
 *   `minClusterSize`/`scatterTriggerCount` alongside `winEvaluator: checkClusterWins` so a pool
 *   Worker (core/simulationTrialWorker.js) can rebuild an equivalent closure on its side of
 *   postMessage.
 * @param {Object} args.domRefs - { simModal, simStats }
 */
export function openTuneFrequenciesPanel({ paytable, reelFrequencyTables, tuneConfig, domRefs }) {
  const { simModal, simStats } = domRefs;
  let tuneContainer = simModal.querySelector('#tune-details');
  if (!tuneContainer) {
    tuneContainer = document.createElement('div');
    tuneContainer.id = 'tune-details';
    tuneContainer.style.marginTop = '20px';
    tuneContainer.style.padding = '15px';
    tuneContainer.style.background = 'rgba(255, 255, 255, 0.1)';
    tuneContainer.style.borderRadius = '12px';
    tuneContainer.style.fontSize = '0.9em';
    simModal.appendChild(tuneContainer);

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
    const isCascadeMechanic = tuneConfig.mechanic?.name === 'cascade';
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
      <h3 style="margin-top: 0; border-bottom: 1px solid rgba(255,255,255,0.2); padding-bottom: 8px;">Frequency Tuner</h3>
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
          <label title="How many spins are simulated to measure each candidate's RTP/trigger rate. Higher reduces Monte Carlo noise but makes every iteration slower - see also Trials Averaged." style="font-size: 0.8em; color: #ccc;">Trial Spins / Candidate<br>
            <input id="tune-trial-spins" type="number" value="300000" step="50000" min="10000" style="width: 100%; margin-top: 4px;">
          </label>
          <label title="How many independent Trial Spins runs are averaged per candidate measurement. Higher further reduces noise in the RTP/trigger estimate, at a proportional cost in time (2 trials ≈ 2x the work per iteration)." style="font-size: 0.8em; color: #ccc;">Trials Averaged / Candidate<br>
            <input id="tune-trials-per-point" type="number" value="2" step="1" min="1" max="10" style="width: 100%; margin-top: 4px;">
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

  if (simStats) simStats.style.display = 'none';

  simModal.style.display = 'block';
  simModal.style.maxWidth = '900px';
  simModal.style.width = '95%';
}

// One symbol's gauge: a single horizontal track, scaled 0 -> reelMax (the highest frequency
// value seen anywhere on this symbol's own reel - configured bounds, tested range, current, or
// best value, across every symbol on that reel, not just this one) so every symbol's bar on a
// given reel is directly comparable at a glance - a symbol at 26 fills most of the track while
// one at 1.6 is a sliver, instead of each bar independently stretching to fill its own box
// regardless of magnitude. A light blue band for the configured minFrequency/maxFrequency
// range, a brighter band for the tested min/max range (the actual low/high frequency this
// symbol has been assigned to across every candidate evaluated so far this run), a gold tick
// for the candidate this step just tried (`current` - may not be an improvement), and a green
// tick for this symbol's value in the overall best-ever candidate found so far (`best` - same
// distinction as the progress log's "current"/"best" split, see startTuning's own onProgress
// handler doc for why the two can differ for many iterations in a row). reelMax <= 0 can't
// derive a span (e.g. every symbol on the reel is 0) - ticks render centered with no bands
// rather than dividing by zero.
function renderFrequencyGauge(current, best, configuredMin, configuredMax, testedMin, testedMax, reelMax) {
  const pct = (v) => reelMax > 0 ? (v / reelMax) * 100 : 50;

  const configuredBand = (configuredMin != null && configuredMax != null)
    ? `<div style="position: absolute; left: ${pct(configuredMin)}%; width: ${Math.max(pct(configuredMax) - pct(configuredMin), 1)}%; top: 0; height: 100%; background: rgba(126,200,255,0.18); border-left: 1px solid rgba(126,200,255,0.5); border-right: 1px solid rgba(126,200,255,0.5);"></div>`
    : '';
  const testedBand = (testedMin != null && testedMax != null)
    ? `<div style="position: absolute; left: ${pct(testedMin)}%; width: ${Math.max(pct(testedMax) - pct(testedMin), 1)}%; top: 30%; height: 40%; background: rgba(255,255,255,0.4); border-radius: 2px;"></div>`
    : '';
  // Drawn before the current tick so current wins visually if the two ever land on the exact
  // same pixel (common once the search has actually converged onto the best candidate).
  const bestTick = best != null
    ? `<div style="position: absolute; left: calc(${pct(best)}% - 1px); top: -2px; width: 2px; height: calc(100% + 4px); background: #4ade80;"></div>`
    : '';
  const currentTick = current != null
    ? `<div style="position: absolute; left: calc(${pct(current)}% - 1px); top: -2px; width: 2px; height: calc(100% + 4px); background: #e6b800;"></div>`
    : '';

  const title = [
    current != null ? `current: ${current.toFixed(3)}` : null,
    best != null ? `best: ${best.toFixed(3)}` : null,
    testedMin != null ? `tested: ${testedMin.toFixed(3)} – ${testedMax.toFixed(3)}` : null,
    configuredMin != null || configuredMax != null
      ? `configured: ${configuredMin != null ? configuredMin.toFixed(3) : '–'} – ${configuredMax != null ? configuredMax.toFixed(3) : '–'}`
      : null,
  ].filter(Boolean).join(' | ');

  return `<div title="${title}" style="position: relative; height: 14px; background: rgba(255,255,255,0.06); border-radius: 3px;">${configuredBand}${testedBand}${bestTick}${currentTick}</div>`;
}

// Renders the TUNE FREQUENCIES panel's live per-reel view: one gauge row per value symbol,
// showing both the candidate this step just tried (`liveTrial` - "current", may not be an
// improvement) and this symbol's value in the overall best-ever candidate found so far
// (`bestTrial` - "best") against both its configured soft minFrequency/maxFrequency bounds
// (resolved once up front - static for the whole run) and the min/max it's actually been tested
// at so far this run (`testedRangeByReel`, updated by the caller on every Phase 2 iteration -
// grows monotonically, never shrinks, until the next run resets it). Before Phase 2 has run at
// all (or during Phase 1, which never touches value symbols), both `liveTrial`/`bestTrial` are
// null and every symbol just shows its untouched baseline frequency with no best marker - see
// startTuning's onProgress handler for exactly when each is populated, and why "current" and
// "best" can disagree for many steps in a row (same reasoning as the progress log's own
// current/best split). Every symbol's gauge on a given reel shares that reel's own scale (0 ->
// the highest value seen anywhere on that reel), not its own - see renderFrequencyGauge's doc.
function renderLiveFrequencyTable(reelFrequencyTables, boundsByReel, testedRangeByReel, liveTrial, bestTrial, paytable, bestOrderingViolations = [], bestLimitViolations = []) {
  let html = `<div style="font-size: 0.7em; color: #888; margin-bottom: 6px;">
                 <span style="color: #7ec8ff;">▮</span> configured range &nbsp;
                 <span style="color: #ddd;">▮</span> tested range &nbsp;
                 <span style="color: #e6b800;">|</span> current &nbsp;
                 <span style="color: #4ade80;">|</span> best &nbsp; &nbsp;
                 <span style="color: ${symbolTypeColor('scatter')};">●</span> scatter &nbsp;
                 <span style="color: ${symbolTypeColor('wild')};">●</span> wild &nbsp;
                 <span style="color: ${symbolTypeColor('premium')};">●</span> premium &nbsp;
                 <span style="color: ${symbolTypeColor('regular')};">●</span> regular &nbsp; &nbsp;
                 <span style="color: #ff8080;">▮</span> ordering/limit violation (best)
               </div>`;
  html += `<div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 12px;">`;
  reelFrequencyTables.forEach((baseReelTableWrapper, reelIdx) => {
    const baseReelTable = baseReelTableWrapper.symbols || baseReelTableWrapper;
    const liveReelTable = liveTrial ? (liveTrial[reelIdx].symbols || liveTrial[reelIdx]) : null;
    const bestReelTable = bestTrial ? (bestTrial[reelIdx].symbols || bestTrial[reelIdx]) : null;
    const testedRange = testedRangeByReel[reelIdx];
    // Reel-wide scale ceiling: the highest of every symbol's current/best/configured-max/
    // tested-max on this reel - computed once per reel, then shared by every symbol's gauge
    // below so bars are comparable to each other, not just internally consistent with their own
    // min/max.
    let reelMax = 0;
    Object.keys(baseReelTable).forEach(symbol => {
      const current = liveReelTable ? liveReelTable[symbol].frequency : baseReelTable[symbol].frequency;
      const best = bestReelTable ? bestReelTable[symbol].frequency : null;
      const { maxFrequency } = boundsByReel[reelIdx][symbol];
      const tested = testedRange[symbol];
      [current, best, maxFrequency, tested ? tested.max : null].forEach(v => { if (v != null && v > reelMax) reelMax = v; });
    });
    html += `<div><h4 style="margin: 0 0 4px; font-size: 0.75em; color: #aaa; text-transform: uppercase;">Reel ${reelIdx + 1}</h4>`;
    Object.keys(baseReelTable).forEach(symbol => {
      const current = liveReelTable ? liveReelTable[symbol].frequency : baseReelTable[symbol].frequency;
      const best = bestReelTable ? bestReelTable[symbol].frequency : null;
      const { minFrequency, maxFrequency } = boundsByReel[reelIdx][symbol];
      const tested = testedRange[symbol];
      const gauge = renderFrequencyGauge(current, best, minFrequency, maxFrequency, tested ? tested.min : null, tested ? tested.max : null, reelMax);
      // Marks a symbol currently involved in one of the BEST candidate's own ordering/limit
      // violations (the same arrays the final results' "N ordering/limit violations remain"
      // paragraphs list, surfaced live and per-symbol here instead of only after the run ends) -
      // a row can carry both if a symbol happens to violate on two fronts at once.
      const orderingHits = bestOrderingViolations.filter(v => v.reel === reelIdx && (v.higherPaySymbol === symbol || v.lowerPaySymbol === symbol));
      const limitHits = bestLimitViolations.filter(v => v.reel === reelIdx && v.symbol === symbol);
      const violationTitle = [...orderingHits.map(v => `ordering: ${v.amount.toFixed(3)} past preference`), ...limitHits.map(v => `${v.bound} limit: ${v.amount.toFixed(3)} past ${v.limit}`)].join(' | ');
      const rowStyle = (orderingHits.length > 0 || limitHits.length > 0)
        ? 'background: rgba(255,90,90,0.12); border-left: 2px solid #ff8080; padding-left: 4px;'
        : 'border-left: 2px solid transparent; padding-left: 4px;';
      html += `<div title="${violationTitle}" style="display: grid; grid-template-columns: 66px 46px 46px 1fr; align-items: center; gap: 6px; padding: 2px 0; font-size: 0.78em; ${rowStyle}">
                  ${renderSymbolLabel(symbol, paytable)}
                  <span style="text-align: right; color: #ddd;">${current.toFixed(3)}</span>
                  <span style="text-align: right; color: #4ade80;">${best != null ? best.toFixed(3) : '–'}</span>
                  ${gauge}
                </div>`;
    });
    html += `</div>`;
  });
  html += `</div>`;
  return html;
}

async function startTuning({ paytable, reelFrequencyTables, tuneConfig, tuneContainer, originalReelFrequencyTables = reelFrequencyTables, continuedFrom = null, diagnoseOnly = false }) {
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
    // Entered as "one bonus every N spins" and converted at the boundary - see core/TuningUnits.js
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
  // core/TuneLog.js for why the final answer alone is not enough.
  const tuneLog = [];
  const bestLogEl = tuneContainer.querySelector('#tune-best-log');
  const bestLogBtn = tuneContainer.querySelector('#tune-best-log-btn');
  let bestLogOpen = false;
  const tuneLogMeta = () => ({ game: tuneConfig.gameName ?? null, inputParameters: lastDiagnostics?.inputParameters ?? null });
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
    trialsPerPoint: parseInt(inputs.trialsPerPoint.value, 10) || 2,
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
    reelCoupling: inputs.reelCoupling.value,
    // Which denomination the weights above are in. The panel defaults to normalized (the library
    // to raw), because the named levels in the shape section are only meaningful against
    // normalized penalties - see core/SpinSimulator.js's own penaltyNormalization doc.
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
        // core/SpinSimulator.js) - but without saying so here the log runs straight on into
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
    // number of strip positions (see bisect1D's own doc in core/SpinSimulator.js), so the
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

    html += `<div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 16px;">`;
    reelFrequencyTables.forEach((baseReelTableWrapper, reelIdx) => {
      const baseReelTable = baseReelTableWrapper.symbols || baseReelTableWrapper;
      const tunedReelTable = (tunedReelTables[reelIdx].symbols || tunedReelTables[reelIdx]);
      html += `<div><h4 style="margin: 0 0 6px; font-size: 0.8em; color: #aaa; text-transform: uppercase;">Reel ${reelIdx + 1}</h4>`;
      html += `<table style="width: 100%; border-collapse: collapse; font-size: 0.85em;">`;
      html += `<thead><tr style="color: #888; font-size: 0.75em; text-transform: uppercase; border-bottom: 1px solid rgba(255,255,255,0.15);">
                  <th style="text-align: left; padding: 3px;">Symbol</th>
                  <th style="text-align: right; padding: 3px;">Current</th>
                  <th style="text-align: right; padding: 3px;">Suggested</th>
                  <th style="text-align: right; padding: 3px;">Δ</th>
                </tr></thead><tbody>`;
      Object.keys(baseReelTable).forEach(symbol => {
        const current = baseReelTable[symbol].frequency;
        const suggested = tunedReelTable[symbol].frequency;
        const delta = suggested - current;
        const deltaColor = Math.abs(delta) < 0.001 ? '#888' : (delta > 0 ? '#7fd97f' : '#e67f7f');
        html += `<tr style="border-bottom: 1px solid rgba(255,255,255,0.05);">
                    <td style="padding: 3px;">${renderSymbolLabel(symbol, paytable, paytable[symbol]?.friendlyName || symbol)}</td>
                    <td style="text-align: right; padding: 3px;">${current.toFixed(4)}</td>
                    <td style="text-align: right; padding: 3px; font-weight: bold;">${suggested.toFixed(4)}</td>
                    <td style="text-align: right; padding: 3px; color: ${deltaColor};">${delta >= 0 ? '+' : ''}${delta.toFixed(4)}</td>
                  </tr>`;
      });
      html += `</tbody></table></div>`;
    });
    html += `</div>`;
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
    // openTuneFrequenciesPanel) rather than inside #tune-results itself, so they sit on the same
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
