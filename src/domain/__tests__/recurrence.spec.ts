import { describe, expect, it } from 'vitest'
import { nextOccurrence, recurringOccurrenceId } from '../recurrence'

describe('recurrence dates', () => {
  it('derives a bounded stable ID from a strict template ID and occurrence date', () => {
    expect(recurringOccurrenceId('monthly-rent', '2026-09-01')).toBe('occ_4552bb042b2ea0154b7cbd89417b2d8d')
    expect(recurringOccurrenceId('monthly-rent', '2026-09-01')).toBe(recurringOccurrenceId('monthly-rent', '2026-09-01'))
    expect(recurringOccurrenceId('monthly-rent', '2026-09-01')).toHaveLength(36)
  })

  it('rejects occurrence identities with non-strict template IDs or invalid ISO dates', () => {
    expect(() => recurringOccurrenceId('monthly rent', '2026-09-01')).toThrow('template ID')
    expect(() => recurringOccurrenceId('monthly-rent', '2026-02-30')).toThrow('valid calendar date')
    expect(() => recurringOccurrenceId('monthly-rent', '2026-9-01')).toThrow('YYYY-MM-DD')
  })

  it('adds weekly and fortnightly occurrences across month and year boundaries', () => {
    expect(nextOccurrence('2026-12-28', { frequency: 'weekly', anchor: { month: 12, day: 28 }, timeZone: 'UTC' })).toBe('2027-01-04')
    expect(nextOccurrence('2026-02-20', { frequency: 'fortnightly', anchor: { month: 2, day: 20 }, timeZone: 'UTC' })).toBe('2026-03-06')
  })

  it('clamps a monthly occurrence to the final calendar day of a shorter month', () => {
    expect(nextOccurrence('2024-01-31', { frequency: 'monthly', anchor: { month: 1, day: 31 }, timeZone: 'UTC' })).toBe('2024-02-29')
    expect(nextOccurrence('2025-01-31', { frequency: 'monthly', anchor: { month: 1, day: 31 }, timeZone: 'UTC' })).toBe('2025-02-28')
  })

  it('clamps a leap-day yearly occurrence in a non-leap year', () => {
    expect(nextOccurrence('2024-02-29', { frequency: 'yearly', anchor: { month: 2, day: 29 }, timeZone: 'UTC' })).toBe('2025-02-28')
  })

  it('returns to a monthly anchor day after a shorter month', () => {
    const recurrence = { frequency: 'monthly', anchor: { month: 1, day: 31 }, timeZone: 'UTC' } as const
    const februaryOccurrence = nextOccurrence('2025-01-31', recurrence)

    expect(februaryOccurrence).toBe('2025-02-28')
    expect(nextOccurrence(februaryOccurrence, recurrence)).toBe('2025-03-31')
  })

  it('returns to a leap-day yearly anchor in a later leap year', () => {
    const recurrence = { frequency: 'yearly', anchor: { month: 2, day: 29 }, timeZone: 'UTC' } as const
    let occurrence = '2024-02-29'
    for (let year = 2025; year <= 2028; year += 1) occurrence = nextOccurrence(occurrence, recurrence)

    expect(occurrence).toBe('2028-02-29')
  })
})
