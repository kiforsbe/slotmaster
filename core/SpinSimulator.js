// Compatibility facade. New runtime code imports simulation or tuning explicitly.
export { simulateSpins } from './simulation/SpinSimulator.js';
export { mergeRoundStats } from './simulation/RoundStatistics.js';
export {
  computeValueRanks, renormalizeWithinBounds, renormalizeWeights, scalePaytable,
  describePayoutScaleVerification, beatsIncumbent,
} from './tuning/Payouts.js';
export { gradientDescent1D, bisect1D, nelderMead } from './tuning/Optimizers.js';
export { diagnoseConfig, tuneFrequencies } from './tuning/FrequencyTuner.js';