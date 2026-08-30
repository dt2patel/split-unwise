import { assertCurrencyCode } from '../domain/money'
import { computeAllocations } from '../domain/splits'
import type { Allocation, Recurrence, SplitMethod } from '../domain/model'
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
  const payments = allocationArray(data.payments, `expense ${id}.payments`, total.currency)
  const allocations = allocationArray(data.allocations, `expense ${id}.allocations`, total.currency)
  assertUniqueParticipants(payments, `expense ${id}`, 'payer')
  assertUniqueParticipants(allocations, `expense ${id}`, 'participant')
  if (payments.length === 0) throw new DocumentDecodeError(`expense ${id}`, 'at least one payment is required')
  if (sumAllocations(payments) !== BigInt(total.minorAmount)) throw new DocumentDecodeError(`expense ${id}`, 'payment total must equal total')
  if (sumAllocations(allocations) !== BigInt(total.minorAmount)) throw new DocumentDecodeError(`expense ${id}`, 'allocation total must equal total')
  const splitMethod = splitMethodValue(data.splitMethod, `expense ${id}.splitMethod`, total)
  const computed = computeAllocations(total, splitMethod)
  if (!sameAllocations(computed, allocations)) throw new DocumentDecodeError(`expense ${id}`, 'allocations do not match split method')
  const createdAt = isoTimestamp(data.createdAt, `expense ${id}.createdAt`)
  const updatedAt = isoTimestamp(data.updatedAt, `expense ${id}.updatedAt`)
  return {
    id, groupId, description: requiredString(data.description, `expense ${id}.description`), date: isoDate(data.date, `expense ${id}.date`), total,
    payments, allocations, category: requiredString(data.category, `expense ${id}.category`), createdAt, updatedAt,
    revision: positiveInteger(data.revision, `expense ${id}.revision`), splitMethod, attachmentRefs: requiredStringArray(data.attachmentRefs, `expense ${id}.attachmentRefs`), syncState: 'fresh',
    ...(data.notes === undefined ? {} : { notes: requiredString(data.notes, `expense ${id}.notes`) }),
    ...(data.recurrence === undefined ? {} : { recurrence: recurrenceValue(data.recurrence, `expense ${id}.recurrence`) }),
    ...(data.occurrenceEditScope === undefined ? {} : { occurrenceEditScope: occurrenceScope(data.occurrenceEditScope, `expense ${id}.occurrenceEditScope`) }),
    ...(data.recurringTemplateId === undefined ? {} : { recurringTemplateId: requiredString(data.recurringTemplateId, `expense ${id}.recurringTemplateId`) }),
    ...(data.deletedAt === undefined ? {} : { deletedAt: isoTimestamp(data.deletedAt, `expense ${id}.deletedAt`) }),
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
  const total = moneyValue(data.total, `recurring ${id}.total`)
  const payments = allocationArray(data.payments, `recurring ${id}.payments`, total.currency)
  assertUniqueParticipants(payments, `recurring ${id}`, 'payer')
  if (payments.length === 0 || sumAllocations(payments) !== BigInt(total.minorAmount)) throw new DocumentDecodeError(`recurring ${id}`, 'payments must equal total')
  return {
    id, groupId, description: requiredString(data.description, `recurring ${id}.description`), total, payments,
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
  const timeZone = requiredString(data.timeZone, `${path}.timeZone`)
  try { new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date(0)) } catch { throw new DocumentDecodeError(path, 'timeZone is not an IANA time zone') }
  if (month > 12 || day > new Date(Date.UTC(2024, month, 0)).getUTCDate()) throw new DocumentDecodeError(path, 'anchor is not a calendar date')
  return { frequency, anchor: { month, day }, timeZone }
}

function allocationArray(value: unknown, path: string, currency: ExpenseRow['total']['currency']): readonly Allocation[] {
  return requiredArray(value, path).map((item, index) => {
    const allocation = record(item, `${path}[${index}]`)
    const money = moneyValue(allocation.money, `${path}[${index}].money`)
    if (money.currency !== currency) throw new DocumentDecodeError(path, 'currency must match total currency')
    return { participantId: requiredString(allocation.participantId, `${path}[${index}].participantId`), money }
  })
}

function splitMethodValue(value: unknown, path: string, total: ExpenseRow['total']): SplitMethod {
  const data = record(value, path)
  const type = data.type
  if (type === 'equal') return { type, participantIds: requiredStringArray(data.participantIds, `${path}.participantIds`) }
  if (type === 'exact') return { type, allocations: allocationArray(data.allocations, `${path}.allocations`, total.currency) }
  if (type === 'percentage' || type === 'shares' || type === 'adjustment') {
    const participantIds = requiredStringArray(data.participantIds, `${path}.participantIds`)
    const field = type === 'percentage' ? 'percentages' : type === 'shares' ? 'shares' : 'adjustments'
    const values = numberRecord(data[field], `${path}.${field}`)
    if (type === 'percentage') return { type, participantIds, percentages: values }
    if (type === 'shares') return { type, participantIds, shares: values }
    return { type, participantIds, adjustments: values }
  }
  if (type === 'itemized') {
    const items = requiredArray(data.items, `${path}.items`).map((item, index) => {
      const recordItem = record(item, `${path}.items[${index}]`)
      const money = moneyValue(recordItem.money, `${path}.items[${index}].money`)
      if (money.currency !== total.currency) throw new DocumentDecodeError(path, 'item currency must match total currency')
      return { description: requiredString(recordItem.description, `${path}.items[${index}].description`), money, participantIds: requiredStringArray(recordItem.participantIds, `${path}.items[${index}].participantIds`) }
    })
    return { type, items }
  }
  throw new DocumentDecodeError(path, 'split type is invalid')
}

function numberRecord(value: unknown, path: string): Readonly<Record<string, number>> {
  const data = record(value, path)
  return Object.fromEntries(Object.entries(data).map(([key, item]) => {
    if (typeof item !== 'number' || !Number.isFinite(item)) throw new DocumentDecodeError(`${path}.${key}`, 'must be a finite number')
    return [key, item]
  }))
}

function assertUniqueParticipants(allocations: readonly Allocation[], path: string, label: string): void {
  if (new Set(allocations.map(({ participantId }) => participantId)).size !== allocations.length) throw new DocumentDecodeError(path, `${label} cannot be repeated`)
}
function sumAllocations(allocations: readonly Allocation[]): bigint { return allocations.reduce((sum, allocation) => sum + BigInt(allocation.money.minorAmount), 0n) }
function sameAllocations(left: readonly Allocation[], right: readonly Allocation[]): boolean {
  const normalize = (values: readonly Allocation[]) => [...values].sort((a, b) => a.participantId.localeCompare(b.participantId)).map(({ participantId, money }) => `${participantId}\u0000${money.currency}\u0000${money.minorAmount}`)
  const first = normalize(left); const second = normalize(right)
  return first.length === second.length && first.every((value, index) => value === second[index])
}
function occurrenceScope(value: unknown, path: string): 'future' | 'occurrence' { if (value !== 'future' && value !== 'occurrence') throw new DocumentDecodeError(path, 'must be occurrence or future'); return value }
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
function isoTimestamp(value: unknown, path: string): string {
  const timestamp = requiredString(value, path)
  const parsed = new Date(timestamp)
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== timestamp) throw new DocumentDecodeError(path, 'must be an ISO timestamp')
  return timestamp
}
