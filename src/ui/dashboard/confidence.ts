import type { InflationConfidence } from '../../analytics'

/** Plain-language labels for the engine's inflation confidence levels. */
export const CONFIDENCE_TEXT: Record<InflationConfidence, { label: string; help: string }> = {
  reliable: { label: 'Reliable', help: 'Enough items bought in both periods, covering a representative share of your spending.' },
  'low-coverage': {
    label: 'Low coverage',
    help: 'Calculated from enough repeat items, but they represent only a small share of your spending, so treat it as indicative.',
  },
  insufficient: { label: 'Insufficient data', help: 'Too few items were bought with a recorded price in both periods for a meaningful comparison.' },
}
