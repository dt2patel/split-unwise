import { assertCurrencyCode } from '../domain/money'
import type { Recurrence } from '../domain/model'
import type { ActivityItem, ExpenseComment, ExpenseRow, Group, Member, RecurringExpense } from './repositories'

export class DocumentDecodeError extends Error {
  constructor(document: string, message: string) { super(`${document}: ${message}`); this.name = 'DocumentDecodeError' }
}

export function decodeGroup(id: string, value: unknown): Group {
  const data = record(value, `group ${id}`)
  const currency = currencyValue(data.currency, `group ${id}.currency`)
  return {
    id, name: requiredString(data.name, `group ${id}.name`), currency,
    ...(data.coverImageUrl === undefined ? {} : { coverImageUrl: requiredString(data.coverImageUrl, `group ${id}.coverImageUrl`) }),
    memberIds: requiredStringArray(data.memberIds, `group ${id}.memberIds`), syncState: 'fresh',
  }
}

/** User-visible group projections are validated before driving a group read. */
export function decodeGroupProjection(id: string, value: unknown): string {
  const data = record(value, `group projection ${id}`)
  const groupId = requiredString(data.groupId, `group projection ${id}.groupId`)
  if (groupId !== id) throw new DocumentDecodeError(`group projection ${id}`, 'groupId does not match document ID')
  return groupId
}

export function decodeMember(id: string, value: unknown, isCurrentUser: boolean): Member {
  const data = record(value, `member ${id}`)
  return {
    id, displayName: requiredString(data.displayName, `member ${id}.displayName`), initials: requiredString(data.initials, `member ${id}.initials`),
    ...(data.avatarUrl === undefined ? {} : { avatarUrl: requiredString(data.avatarUrl, `member ${id}.avatarUrl`) }), isCurrentUser,
  }
}

export function decodeExpense(groupId: string, id: string, value: unknown): ExpenseRow {
  const data = record(value, `expense ${id}`)
  const total = moneyValue(data.total, `expense ${id}.total`)
  const allocations = requiredArray(data.allocations, `expense ${id}.allocations`).map((item, index) => {
    const allocation = record(item, `expense ${id}.allocations[${index}]`)
    return { participantId: requiredString(allocation.participantId, `expense ${id}.allocations[${index}].participantId`), money: moneyValue(allocation.money, `expense ${id}.allocations[${index}].money`) }
  })
  if (allocations.some((allocation) => allocation.money.currency !== total.currency)) throw new DocumentDecodeError(`expense ${id}`, 'allocation currency must match total currency')
  if (allocations.reduce((sum, allocation) => sum + BigInt(allocation.money.minorAmount), 0n) !== BigInt(total.minorAmount)) throw new DocumentDecodeError(`expense ${id}`, 'allocation total must equal total')
  return {
    id, groupId, description: requiredString(data.description, `expense ${id}.description`), date: isoDate(data.date, `expense ${id}.date`), total,
    payerId: requiredString(data.payerId, `expense ${id}.payerId`), allocations, category: requiredString(data.category, `expense ${id}.category`),
    createdAt: requiredString(data.createdAt, `expense ${id}.createdAt`), syncState: 'fresh',
    ...(data.recurringTemplateId === undefined ? {} : { recurringTemplateId: requiredString(data.recurringTemplateId, `expense ${id}.recurringTemplateId`) }),
  }
}

export function decodeComment(expenseId: string, id: string, value: unknown): ExpenseComment {
  const data = record(value, `comment ${id}`)
  return { id, expenseId, authorId: requiredString(data.authorId, `comment ${id}.authorId`), body: requiredString(data.body, `comment ${id}.body`), createdAt: requiredString(data.createdAt, `comment ${id}.createdAt`), syncState: 'fresh' }
}

export function decodeActivity(groupId: string, id: string, value: unknown): ActivityItem {
  const data = record(value, `activity ${id}`)
  const type = data.type
  if (type !== 'comment-added' && type !== 'expense-created' && type !== 'expense-updated') throw new DocumentDecodeError(`activity ${id}`, 'activity type is invalid')
  return {
    id, groupId, ...(data.expenseId === undefined ? {} : { expenseId: requiredString(data.expenseId, `activity ${id}.expenseId`) }),
    actorId: requiredString(data.actorId, `activity ${id}.actorId`), type, createdAt: requiredString(data.createdAt, `activity ${id}.createdAt`), summary: requiredString(data.summary, `activity ${id}.summary`), syncState: 'fresh',
  }
}

export function decodeRecurringExpense(groupId: string, id: string, value: unknown): RecurringExpense {
  const data = record(value, `recurring ${id}`)
  return {
    id, groupId, description: requiredString(data.description, `recurring ${id}.description`), total: moneyValue(data.total, `recurring ${id}.total`), payerId: requiredString(data.payerId, `recurring ${id}.payerId`),
    recurrence: recurrenceValue(data.recurrence, `recurring ${id}.recurrence`), nextDate: isoDate(data.nextDate, `recurring ${id}.nextDate`), syncState: 'fresh',
  }
}

function recurrenceValue(value: unknown, path: string): Recurrence {
  const data = record(value, path)
  const frequency = data.frequency
  if (frequency !== 'weekly' && frequency !== 'fortnightly' && frequency !== 'monthly' && frequency !== 'yearly') throw new DocumentDecodeError(path, 'frequency is invalid')
  const anchor = record(data.anchor, `${path}.anchor`)
  const month = positiveInteger(anchor.month, `${path}.anchor.month`)
  const day = positiveInteger(anchor.day, `${path}.anchor.day`)
  if (month > 12 || day > new Date(Date.UTC(2024, month, 0)).getUTCDate()) throw new DocumentDecodeError(path, 'anchor is not a calendar date')
  return { frequency, anchor: { month, day } }
}
function moneyValue(value: unknown, path: string): ExpenseRow['total'] {
  const data = record(value, path)
  const currency = currencyValue(data.currency, `${path}.currency`)
  const minorAmount = nonNegativeSafeInteger(data.minorAmount, `${path}.minorAmount`)
  return { currency, minorAmount }
}
function currencyValue(value: unknown, path: string): ExpenseRow['total']['currency'] {
  const currency = requiredString(value, path)
  try { assertCurrencyCode(currency) } catch { throw new DocumentDecodeError(path, 'currency is not ISO 4217') }
  return currency
}
function record(value: unknown, path: string): Record<string, unknown> { if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new DocumentDecodeError(path, 'must be an object'); return value as Record<string, unknown> }
function requiredArray(value: unknown, path: string): readonly unknown[] { if (!Array.isArray(value)) throw new DocumentDecodeError(path, 'must be an array'); return value }
function requiredStringArray(value: unknown, path: string): readonly string[] { return requiredArray(value, path).map((item, index) => requiredString(item, `${path}[${index}]`)) }
function requiredString(value: unknown, path: string): string { if (typeof value !== 'string' || !value.trim()) throw new DocumentDecodeError(path, 'must be a non-empty string'); return value }
function nonNegativeSafeInteger(value: unknown, path: string): number { if (!Number.isSafeInteger(value) || (value as number) < 0) throw new DocumentDecodeError(path, 'must be a non-negative safe integer'); return value as number }
function positiveInteger(value: unknown, path: string): number { if (!Number.isInteger(value) || (value as number) < 1) throw new DocumentDecodeError(path, 'must be a positive integer'); return value as number }
function isoDate(value: unknown, path: string): string {
  const date = requiredString(value, path)
  const parsed = new Date(`${date}T00:00:00.000Z`)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== date) throw new DocumentDecodeError(path, 'must be an ISO date')
  return date
}
