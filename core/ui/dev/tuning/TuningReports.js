import { resolveFrequencyBounds } from '../../../math/SlotMath.js';
import { pctToSpinsPerTrigger } from '../../../tuning/Units.js';
import { describePlayerExperience } from '../../../tuning/PlayerExperience.js';
import { describeTuneEntryQuality } from '../../../tuning/TuneLog.js';
import { fmt, esc } from './TuningFormat.js';
import { PENALTY_INTENTS } from './TuningPanelSchema.js';

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
          <button class="btn-icon tune-log-copy-js" data-index="${e.index}" title="Copy this config as paste-ready FREQUENCY_REEL code, exactly like the output at the end of a tune - with a header saying which log entry it is and what was wrong with it, since this is one candidate from the history rather than the run's final answer." style="padding: 3px 8px; font-size: 0.7em; background: rgba(255,214,0,0.18); border-color: rgba(255,214,0,0.5); color: #ffe9a3;">COPY JS</button>
          <button class="btn-icon tune-log-copy" data-index="${e.index}" title="Copy this entry as JSON - every measured field, not just the frequencies." style="padding: 3px 8px; font-size: 0.7em; background: rgba(255,255,255,0.08); border-color: rgba(255,255,255,0.2); color: #ddd;">JSON</button>
          <button class="btn-icon tune-log-export" data-index="${e.index}" title="Download this entry as a .json file." style="padding: 3px 8px; font-size: 0.7em; background: rgba(255,255,255,0.08); border-color: rgba(255,255,255,0.2); color: #ddd;">FILE</button>
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
 * Cluster games declare one constant per DISTINCT ladder, and how many that is varies: a game may
 * point six symbols at two shared ladders, or give all seven their own. Emitting one literal per
 * symbol would be technically correct and practically useless in the first case - the developer's
 * source has two constants to paste over, not twelve object literals to reassemble by hand.
 * Ladders are therefore grouped by VALUE (not by reference, which `scalePaytable`'s per-entry copy
 * has already broken), and each group is named after whatever its members have in common: the sole
 * symbol when a ladder has only one, otherwise the `type` they share. Both spellings reproduce the
 * source's own constant names on the real target games.
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
    // One symbol -> name it after that symbol, since a per-symbol ladder is what the source
    // declares. Several symbols with a unanimous type -> the name a shared ladder almost certainly
    // already uses. Anything else -> an indexed fallback, since guessing a name wrong is worse
    // than not guessing. Naming every group by type would emit PREMIUM_PAYOUT_2/_3 for a game with
    // a ladder per symbol - names matching nothing in the file they are meant to be pasted into.
    const solo = g.symbols.length === 1;
    const base = solo ? `${g.symbols[0].toUpperCase()}_PAYOUT`
      : g.types.size === 1 ? `${[...g.types][0].toUpperCase()}_PAYOUT`
      : `CLUSTER_PAYOUT_${blocks.length + 1}`;
    let name = base;
    for (let n = 2; usedNames.has(name); n++) name = `${base}_${n}`;
    usedNames.add(name);

    const minWidth = Math.max(...g.tiers.map(t => String(t.min).length));
    const lines = g.tiers.map(t => `  { min: ${String(t.min).padStart(minWidth)}, multiplier: ${formatPayoutForCopy(t.multiplier)} },`);
    // The "used by" line is what tells you where to paste a SHARED ladder. On a solo ladder the
    // constant's own name already says it, and the comment is noise.
    const usedBy = solo ? '' : `// Used by: ${g.symbols.join(', ')}\n`;
    blocks.push(`${usedBy}export const ${name} = [\n${lines.join('\n')}\n];`);
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
  const explorationSpins = p.searchTrialSpins ?? p.trialSpins;
  const explorationTrials = p.searchTrialsPerPoint ?? p.trialsPerPoint;
  const holdoutSpins = p.finalValidationSpins ?? p.trialSpins;
  const holdoutTrials = p.finalValidationTrials ?? Math.max(p.trialsPerPoint ?? 0, 3);

  // An entry pulled out of the accepted-best log is NOT the run's final answer, and pasting it as
  // though it were is how a config with a known problem gets shipped believing it was the winner.
  // So it identifies itself, and carries the same verdict the log showed - most importantly the
  // measurement uncertainty, since the reason to reach past the winner is usually that an earlier
  // candidate was measured more reliably.
  const e = context.tuneLogEntry ?? null;
  const q = e ? describeTuneEntryQuality(e) : null;
  const header = [
    e
      ? `// ---- Tuned ${new Date().toISOString().slice(0, 10)} - accepted-best entry #${e.index} (step ${e.step}${e.stage ? `, ${e.stage}` : ''}) ----`
      : `// ---- Tuned ${new Date().toISOString().slice(0, 10)} ----`,
    `// Achieved: RTP ${num(context.rtp, 2)}%  |  free-spin trigger ${num(context.triggerRatePct, 3)}%`
      + (e ? `  |  measured +/-${e.measurement.trialRtpStdError.toFixed(2)}pp` : ''),
    e ? `// This is one candidate from that run's history, NOT necessarily its final result.` : null,
    e ? `// Verdict at the time: ${q.ok ? 'meets every target' : q.verdict}${q.notes.length ? ` (${q.notes.join(', ')})` : ''}` : null,
    e && e.shape
      ? `// Shape: volatility ${e.shape.volatilityIndex.toFixed(1)}x (${e.shape.volatilityBand}), hit rate ${(e.shape.hitRate * 100).toFixed(0)}%, biggest round ${e.shape.maxWin.toFixed(0)}x, top 1% carry ${(e.shape.top1PctShare * 100).toFixed(0)}%`
      : null,
    `//`,
    `// To reproduce this exact run, the tuner needs all of the following - same searchSeed AND`,
    `// same reel geometry, since strips are generated from them:`,
    `//   searchSeed ${p.searchSeed}   reelSeeds [${(p.reelSeeds ?? []).join(', ')}]`,
    `//   reelLength ${p.reelLength}   reels ${p.reelsCount} x ${p.rowsCount} rows`,
    // The trigger target is derived from the "1 in N spins" the panel actually asks for, so as a
    // percentage it is a repeating fraction - printed raw it lands in the header as
    // "0.5988023952095808%". Rounded, plus the spins form, which is the number to type back in.
    `//   target RTP ${p.targetRtp}% +/-${p.rtpTolerancePct}   target trigger ${num(p.targetTriggerRatePct)}%`
      + ` (1 in ${Math.round(pctToSpinsPerTrigger(p.targetTriggerRatePct) ?? 0)}) +/-${p.triggerRateTolerancePct}`,
    `//   ${p.trialSpins?.toLocaleString()} spins x ${p.trialsPerPoint} trials   ${p.searchAlgorithm}, max ${p.maxIterations} iterations`,
    (p.searchTrialSpins != null || p.searchTrialsPerPoint != null || p.finalValidation)
      ? `//   exploration: ${explorationSpins?.toLocaleString()} spins x ${explorationTrials} trials   holdout: ${p.finalValidation ? `${holdoutSpins?.toLocaleString()} spins x ${holdoutTrials} trials across ${p.finalistCount ?? 4} finalists` : 'off'}`
      : null,
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
