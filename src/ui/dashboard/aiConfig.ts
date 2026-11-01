/**
 * Dashboard-side settings for AI category suggestions. The model never sees
 * these: "high confidence" is a display/bulk-action threshold chosen here,
 * not something the model is told to aim for.
 */
export const AI_SUGGESTIONS = {
  /** Suggestions at or above this confidence are labelled "High" and offered for bulk accept (still an explicit click). */
  highConfidence: 0.85,
  /** At most this many items per click (4 requests of 25); click again for more. */
  maxItemsPerRun: 100,
} as const
