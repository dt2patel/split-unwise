import type { Recurrence } from './model'

const STRICT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

/** Produces the Firestore-Rules-reconstructable document ID for one recurrence occurrence. */
export function recurringOccurrenceId(templateId: string, occurrenceDate: string): string {
  if (!STRICT_ID_PATTERN.test(templateId)) throw new Error('Recurring template ID must be a strict ID')
  parseIsoDate(occurrenceDate)
  return `occ_${templateId}_${occurrenceDate}`
}

/**
 * Computes one calendar occurrence from an ISO date without a time zone.
 * Monthly and yearly rules retain their explicit original anchor and otherwise use the target month's final day.
 */
export function nextOccurrence(date: string, recurrence: Recurrence): string {
  const source = parseIsoDate(date)
  assertAnchor(recurrence.anchor)
  switch (recurrence.frequency) {
    case 'weekly':
      source.setUTCDate(source.getUTCDate() + 7)
      return formatIsoDate(source)
    case 'fortnightly':
      source.setUTCDate(source.getUTCDate() + 14)
      return formatIsoDate(source)
    case 'monthly':
      return formatIsoDate(addClampedMonths(source, 1, recurrence.anchor.day))
    case 'yearly':
      return formatIsoDate(addClampedYear(source, recurrence.anchor.month, recurrence.anchor.day))
  }
}

function addClampedMonths(source: Date, months: number, day: number): Date {
  const year = source.getUTCFullYear()
  const month = source.getUTCMonth() + months
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
  return new Date(Date.UTC(year, month, Math.min(day, lastDay)))
}

function addClampedYear(source: Date, month: number, day: number): Date {
  const year = source.getUTCFullYear() + 1
  const targetMonth = month - 1
  const lastDay = new Date(Date.UTC(year, targetMonth + 1, 0)).getUTCDate()
  return new Date(Date.UTC(year, targetMonth, Math.min(day, lastDay)))
}

function parseIsoDate(value: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) throw new Error('Date must use YYYY-MM-DD')
  const [, yearText, monthText, dayText] = match
  const date = new Date(Date.UTC(Number(yearText), Number(monthText) - 1, Number(dayText)))
  if (formatIsoDate(date) !== value) throw new Error('Date must be a valid calendar date')
  return date
}

function formatIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function assertAnchor(anchor: Recurrence['anchor']): void {
  if (!Number.isInteger(anchor.month) || anchor.month < 1 || anchor.month > 12) {
    throw new Error('Recurrence anchor month must be between 1 and 12')
  }
  if (!Number.isInteger(anchor.day) || anchor.day < 1) throw new Error('Recurrence anchor day must be positive')
  const maximumDay = new Date(Date.UTC(2024, anchor.month, 0)).getUTCDate()
  if (anchor.day > maximumDay) throw new Error('Recurrence anchor day must exist in its month')
}
