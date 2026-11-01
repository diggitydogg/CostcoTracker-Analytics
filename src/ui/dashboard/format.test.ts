// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { change, count, date, days, money, moneyAxis, moneyWhole, month, share } from './format'

describe('dashboard formatting', () => {
  it('never renders NaN, Infinity or undefined', () => {
    for (const bad of [NaN, Infinity, -Infinity, null, undefined]) {
      for (const f of [money, moneyWhole, change, share, count, days]) expect(f(bad as never)).toBe('—')
    }
    expect(moneyAxis(NaN)).toBe('—')
    expect(date(null)).toBe('—')
    expect(date('not-a-date')).toBe('—')
    expect(month(undefined)).toBe('—')
  })

  it('formats values', () => {
    expect(money(123456)).toBe('$1,234.56')
    expect(money(-500)).toBe('-$5.00')
    expect(moneyWhole(123456)).toBe('$1,235')
    expect(change(0.0421)).toBe('+4.2%')
    expect(change(-0.1)).toBe('−10.0%')
    expect(change(0)).toBe('0.0%')
    expect(share(0.125)).toBe('12.5%')
    expect(moneyAxis(150000)).toBe('$1.5k')
    expect(moneyAxis(4250)).toBe('$42.50')
    expect(moneyAxis(-100000)).toBe('−$1k')
    expect(date('2024-03-05')).toBe('Mar 5, 2024')
    expect(month('2024-03')).toBe('Mar 2024')
    expect(days(1)).toBe('1 day')
  })
})
