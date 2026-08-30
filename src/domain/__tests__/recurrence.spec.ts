import { describe, expect, it } from 'vitest'
import { nextOccurrence } from '../recurrence'

describe('recurrence dates', () => {
  it('adds weekly and fortnightly occurrences across month and year boundaries', () => {
    expect(nextOccurrence('2026-12-28', { frequency: 'weekly' })).toBe('2027-01-04')
    expect(nextOccurrence('2026-02-20', { frequency: 'fortnightly' })).toBe('2026-03-06')
  })

  it('clamps a monthly occurrence to the final calendar day of a shorter month', () => {
    expect(nextOccurrence('2024-01-31', { frequency: 'monthly' })).toBe('2024-02-29')
    expect(nextOccurrence('2025-01-31', { frequency: 'monthly' })).toBe('2025-02-28')
  })

  it('clamps a leap-day yearly occurrence in a non-leap year', () => {
    expect(nextOccurrence('2024-02-29', { frequency: 'yearly' })).toBe('2025-02-28')
  })
})
