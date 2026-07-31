// Compatibility exports. New code imports from ./tuning/* according to responsibility.
export { openTuningPanel } from './tuning/TuningPanelView.js';
export {
  renderTuneLogHtml, renderTargetChipsHtml, renderPlayerExperienceHtml,
  describePenaltyStateNow, renderLossBudgetHtml, renderDiagnosisHtml,
  formatScaledPaytableForCopy, renderPayoutScaleHtml, formatReelFrequencyTablesForCopy,
} from './tuning/TuningReports.js';