import type { Recurrence } from './model'

/**
 * Computes one calendar occurrence from an ISO date without a time zone.
 * Monthly and yearly rules retain the day when possible and otherwise use the target month's final day.
 */
export function nextOccurrence(date: string, recurrence: Recurrence): string {
  const source = parseIsoDate(date)
  switch (recurrence.frequency) {
    case 'weekly':
      source.setUTCDate(source.getUTCDate() + 7)
      return formatIsoDate(source)
    case 'fortnightly':
      source.setUTCDate(source.getUTCDate() + 14)
      return formatIsoDate(source)
    case 'monthly':
      return formatIsoDate(addClampedMonths(source, 1))
    case 'yearly':
      return formatIsoDate(addClampedMonths(source, 12))
  }
}

function addClampedMonths(source: Date, months: number): Date {
  const year = source.getUTCFullYear()
  const month = source.getUTCMonth() + months
  const day = source.getUTCDate()
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
  return new Date(Date.UTC(year, month, Math.min(day, lastDay)))
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
