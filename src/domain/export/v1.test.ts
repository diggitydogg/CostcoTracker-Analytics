// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { isCalendarDate, isZonedDateTime } from './v1'

describe('isCalendarDate', () => {
  it.each(['2026-01-01', '2024-02-29', '2026-12-31'])('accepts %s', (v) => {
    expect(isCalendarDate(v)).toBe(true)
  })
  it.each([
    '2026-02-29', // not a leap year
    '2026-02-30',
    '2026-13-01',
    '2026-00-10',
    '2026-04-31',
    '2026-1-01',
    '26-01-01',
    '2026-01-01T00:00:00Z', // a moment, not a calendar date
    '01/04/2026',
    '',
  ])('rejects %s', (v) => {
    expect(isCalendarDate(v)).toBe(false)
  })
})

describe('isZonedDateTime', () => {
  it.each(['2026-10-31T18:00:00Z', '2026-10-31T18:00:00.123Z', '2026-10-31T11:00:00-07:00', '2026-10-31T18:00Z'])(
    'accepts %s',
    (v) => expect(isZonedDateTime(v)).toBe(true),
  )
  it.each(['2026-10-31T18:00:00', '2026-10-31', '2026-02-30T00:00:00Z', 'yesterday', '2026-10-31 18:00:00Z'])(
    'rejects %s',
    (v) => expect(isZonedDateTime(v)).toBe(false),
  )
})
