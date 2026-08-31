import { assertCurrencyCode } from '../domain/money'
import { computeAllocations } from '../domain/splits'
import type { Allocation, Recurrence, SplitMethod } from '../domain/model'
import type { ActivityItem, ActivityKind, ActivitySubject, ActorSnapshot, ExpenseComment, ExpenseRevision, ExpenseRow, Group, GroupBalanceSnapshot, Member, NotificationItem, RecurringExpense, SettlementBasis, SettlementMethod, SettlementRecord, SettlementVoid } from './repositories'
import { isStrictId } from './identifiers'

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
    ...(data.avatarUrl === undefined ? {} : { avatarUrl: requiredString(data.avatarUrl, `member ${id}.avatarUrl`) }),
    ...(data.canManage === undefined ? {} : { canManage: requiredBoolean(data.canManage, `member ${id}.canManage`) }),
    isCurrentUser,
  }
}

export function decodeBalanceSnapshot(groupId: string, value: unknown): GroupBalanceSnapshot {
  const data = record(value, `balance snapshot ${groupId}`)
  if (requiredString(data.groupId, `balance snapshot ${groupId}.groupId`) !== groupId) throw new DocumentDecodeError(`balance snapshot ${groupId}`, 'groupId does not match its parent')
  return {
    groupId,
    balanceRevision: nonNegativeSafeInteger(data.balanceRevision, `balance snapshot ${groupId}.balanceRevision`),
    simplifyDebtsEnabled: requiredBoolean(data.simplifyDebtsEnabled, `balance snapshot ${groupId}.simplifyDebtsEnabled`),
    pairwise: debtArray(data.pairwise, `balance snapshot ${groupId}.pairwise`),
    simplified: debtArray(data.simplified, `balance snapshot ${groupId}.simplified`),
  }
}

export function decodeSettlement(groupId: string, id: string, value: unknown): SettlementRecord {
  const data = record(value, `settlement ${id}`)
  if (requiredString(data.groupId, `settlement ${id}.groupId`) !== groupId) throw new DocumentDecodeError(`settlement ${id}`, 'groupId does not match its parent')
  const senderId = requiredString(data.senderId, `settlement ${id}.senderId`)
  const recipientId = requiredString(data.recipientId, `settlement ${id}.recipientId`)
  if (senderId === recipientId) throw new DocumentDecodeError(`settlement ${id}`, 'sender and recipient must be distinct')
  const money = positiveMoneyValue(data.money, `settlement ${id}.money`)
  const basis = settlementBasis(data.basis, `settlement ${id}.basis`)
  if (basis.senderId !== senderId || basis.recipientId !== recipientId) throw new DocumentDecodeError(`settlement ${id}`, 'basis participants must match the settlement')
  if (basis.currency !== money.currency) throw new DocumentDecodeError(`settlement ${id}`, 'basis currency must match settlement money')
  if (money.minorAmount > basis.debtMinor) throw new DocumentDecodeError(`settlement ${id}`, 'amount cannot exceed basis debt')
  const revision = positiveInteger(data.revision, `settlement ${id}.revision`)
  const voided = data.void === undefined ? undefined : settlementVoid(data.void, `settlement ${id}.void`)
  if ((revision === 1) !== (voided === undefined) || (voided && voided.revision !== revision)) throw new DocumentDecodeError(`settlement ${id}`, 'void revision must match the settlement revision')
  const createdBy = actorSnapshot(data.createdBy, `settlement ${id}.createdBy`)
  if (createdBy.id !== senderId && createdBy.id !== recipientId) throw new DocumentDecodeError(`settlement ${id}`, 'creator must be the sender or recipient')
  return {
    settlementId: id,
    groupId,
    operationId: requiredString(data.operationId, `settlement ${id}.operationId`),
    senderId,
    recipientId,
    money,
    basis,
    method: settlementMethod(data.method, `settlement ${id}.method`),
    occurredOn: isoDate(data.occurredOn, `settlement ${id}.occurredOn`),
    ...(data.note === undefined ? {} : { note: normalizedSettlementText(data.note, `settlement ${id}.note`, false) }),
    createdBy,
    createdAt: isoTimestamp(data.createdAt, `settlement ${id}.createdAt`),
    revision,
    syncState: 'fresh',
    ...(voided ? { void: voided } : {}),
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
    ...(data.createdBy === undefined ? {} : { createdBy: actorSnapshot(data.createdBy, `expense ${id}.createdBy`) }),
    ...(data.updatedBy === undefined ? {} : { updatedBy: actorSnapshot(data.updatedBy, `expense ${id}.updatedBy`) }),
  }
}

export function decodeExpenseRevision(groupId: string, expenseId: string, id: string, value: unknown): ExpenseRevision {
  const data = record(value, `expense revision ${id}`)
  if (requiredString(data.groupId, `expense revision ${id}.groupId`) !== groupId) throw new DocumentDecodeError(`expense revision ${id}`, 'groupId does not match its parent')
  if (requiredString(data.expenseId, `expense revision ${id}.expenseId`) !== expenseId) throw new DocumentDecodeError(`expense revision ${id}`, 'expenseId does not match its parent')
  const revision = positiveInteger(data.revision, `expense revision ${id}.revision`)
  const action = data.action
  if (action !== 'created' && action !== 'updated' && action !== 'deleted') throw new DocumentDecodeError(`expense revision ${id}.action`, 'must be created, updated, or deleted')
  const expense = decodeExpense(groupId, expenseId, data.expense)
  if (expense.revision !== revision) throw new DocumentDecodeError(`expense revision ${id}`, 'snapshot revision does not match revision')
  if (action === 'created' && revision !== 1) throw new DocumentDecodeError(`expense revision ${id}`, 'created revision must be revision 1')
  if (action !== 'created' && revision < 2) throw new DocumentDecodeError(`expense revision ${id}`, `${action} revision must follow creation`)
  if (action === 'deleted' && expense.deletedAt === undefined) throw new DocumentDecodeError(`expense revision ${id}`, 'deleted revision requires a tombstone snapshot')
  if (action !== 'deleted' && expense.deletedAt !== undefined) throw new DocumentDecodeError(`expense revision ${id}`, 'live revision cannot contain a tombstone snapshot')
  const actor = actorSnapshot(data.actor, `expense revision ${id}.actor`)
  const commitActor = action === 'created' ? expense.createdBy : expense.updatedBy
  if (!commitActor || !sameActor(actor, commitActor)) throw new DocumentDecodeError(`expense revision ${id}`, 'actor does not match the committed expense snapshot')
  const createdAt = isoTimestamp(data.createdAt, `expense revision ${id}.createdAt`)
  const snapshotTimestamp = action === 'created' ? expense.createdAt : expense.updatedAt
  if (createdAt !== snapshotTimestamp) throw new DocumentDecodeError(`expense revision ${id}`, 'commit timestamp does not match the expense snapshot')
  return {
    id, groupId, expenseId, revision,
    operationId: requiredString(data.operationId, `expense revision ${id}.operationId`),
    action,
    actor,
    createdAt,
    expense,
  }
}

export function decodeComment(groupId: string, expenseId: string, id: string, value: unknown): ExpenseComment {
  const data = record(value, `comment ${id}`)
  if (requiredString(data.expenseId, `comment ${id}.expenseId`) !== expenseId) throw new DocumentDecodeError(`comment ${id}`, 'expenseId does not match query')
  return {
    commentId: id,
    groupId,
    expenseId,
    operationId: requiredString(data.operationId, `comment ${id}.operationId`),
    author: actorSnapshot(data.author, `comment ${id}.author`),
    body: requiredString(data.body, `comment ${id}.body`),
    attachmentRefs: requiredStringArray(data.attachmentRefs, `comment ${id}.attachmentRefs`),
    createdAt: isoTimestamp(data.createdAt, `comment ${id}.createdAt`),
    ...(data.deletedAt === undefined ? {} : { deletedAt: isoTimestamp(data.deletedAt, `comment ${id}.deletedAt`) }),
    syncState: 'fresh',
  }
}

export function decodeActivity(groupId: string, id: string, value: unknown): ActivityItem {
  if (!isStrictId(groupId)) throw new DocumentDecodeError(`activity ${id}.groupId`, 'groupId must be a valid structured ID')
  const data = record(value, `activity ${id}`)
  const kind = activityKind(data.kind, `activity ${id}.kind`)
  const subject = activitySubject(data.subject, `activity ${id}.subject`)
  const item: ActivityItem = {
    id,
    groupId,
    operationId: requiredString(data.operationId, `activity ${id}.operationId`),
    kind,
    subject,
    actor: actorSnapshot(data.actor, `activity ${id}.actor`),
    ...(data.expenseId === undefined ? {} : { expenseId: requiredString(data.expenseId, `activity ${id}.expenseId`) }),
    ...(data.revision === undefined ? {} : { revision: positiveInteger(data.revision, `activity ${id}.revision`) }),
    ...(data.commentId === undefined ? {} : { commentId: requiredString(data.commentId, `activity ${id}.commentId`) }),
    ...(data.settlementId === undefined ? {} : { settlementId: requiredString(data.settlementId, `activity ${id}.settlementId`) }),
    createdAt: isoTimestamp(data.createdAt, `activity ${id}.createdAt`),
    syncState: 'fresh',
  }
  assertActivityInvariants(item, `activity ${id}`)
  return item
}

export function decodeNotification(principalId: string, id: string, value: unknown): NotificationItem {
  const data = record(value, `notification ${id}`)
  if (requiredString(data.principalId, `notification ${id}.principalId`) !== principalId) throw new DocumentDecodeError(`notification ${id}`, 'principalId does not match repository principal')
  if (!Object.prototype.hasOwnProperty.call(data, 'readAt')) throw new DocumentDecodeError(`notification ${id}.readAt`, 'must be explicit null or an ISO timestamp')
  const kind = activityKind(data.kind, `notification ${id}.kind`)
  const subject = activitySubject(data.subject, `notification ${id}.subject`)
  assertKindSubject(kind, subject, `notification ${id}`)
  return {
    notificationId: id,
    principalId,
    groupId: requiredString(data.groupId, `notification ${id}.groupId`),
    activityId: requiredString(data.activityId, `notification ${id}.activityId`),
    kind,
    subject,
    actor: actorSnapshot(data.actor, `notification ${id}.actor`),
    createdAt: isoTimestamp(data.createdAt, `notification ${id}.createdAt`),
    ...(data.readAt === null ? {} : { readAt: isoTimestamp(data.readAt, `notification ${id}.readAt`) }),
    syncState: 'fresh',
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

function actorSnapshot(value: unknown, path: string): ActorSnapshot {
  const data = record(value, path)
  return { id: requiredString(data.id, `${path}.id`), displayName: requiredString(data.displayName, `${path}.displayName`) }
}

function activityKind(value: unknown, path: string): ActivityKind {
  const kinds: readonly ActivityKind[] = ['comment.added', 'comment.deleted', 'expense.created', 'expense.updated', 'expense.deleted', 'group.event', 'membership.changed', 'settlement.created', 'settlement.voided']
  if (typeof value !== 'string' || !kinds.includes(value as ActivityKind)) throw new DocumentDecodeError(path, 'activity type is invalid')
  return value as ActivityKind
}

function activitySubject(value: unknown, path: string): ActivitySubject {
  const data = record(value, path)
  const kind = data.kind
  if (kind !== 'comment' && kind !== 'expense' && kind !== 'group' && kind !== 'membership' && kind !== 'settlement') throw new DocumentDecodeError(`${path}.kind`, 'subject kind is invalid')
  return {
    kind,
    id: requiredString(data.id, `${path}.id`),
    ...(data.label === undefined ? {} : { label: requiredString(data.label, `${path}.label`) }),
  }
}

function assertActivityInvariants(item: ActivityItem, path: string): void {
  assertKindSubject(item.kind, item.subject, path)
  if (item.kind.startsWith('expense.')) {
    if (!item.expenseId || item.subject.id !== item.expenseId) throw new DocumentDecodeError(path, 'expense subject ID must match expenseId')
    if (item.revision === undefined || item.commentId !== undefined || item.settlementId !== undefined) throw new DocumentDecodeError(path, 'expense activity identifiers are inconsistent')
    return
  }
  if (item.kind.startsWith('comment.')) {
    if (!item.expenseId || !item.commentId || item.subject.id !== item.commentId) throw new DocumentDecodeError(path, 'comment subject must match commentId and include expenseId')
    if (item.revision !== undefined || item.settlementId !== undefined) throw new DocumentDecodeError(path, 'comment activity identifiers are inconsistent')
    return
  }
  if (item.kind.startsWith('settlement.')) {
    if (!item.settlementId || item.subject.id !== item.settlementId) throw new DocumentDecodeError(path, 'settlement subject ID must match settlementId')
    if (item.expenseId !== undefined || item.commentId !== undefined || item.revision !== undefined) throw new DocumentDecodeError(path, 'settlement activity identifiers are inconsistent')
    return
  }
  if (item.expenseId !== undefined || item.commentId !== undefined || item.settlementId !== undefined || item.revision !== undefined) {
    throw new DocumentDecodeError(path, 'group activity cannot carry financial subject identifiers')
  }
}

function assertKindSubject(kind: ActivityKind, subject: ActivitySubject, path: string): void {
  const expected = kind.startsWith('expense.') ? 'expense'
    : kind.startsWith('comment.') ? 'comment'
      : kind.startsWith('settlement.') ? 'settlement'
        : kind === 'membership.changed' ? 'membership' : 'group'
  if (subject.kind !== expected) throw new DocumentDecodeError(path, `${expected} activity requires a ${expected} subject`)
}

function sameActor(left: ActorSnapshot, right: ActorSnapshot): boolean { return left.id === right.id && left.displayName === right.displayName }

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
function debtArray(value: unknown, path: string): GroupBalanceSnapshot['pairwise'] {
  return requiredArray(value, path).map((item, index) => {
    const data = record(item, `${path}[${index}]`)
    const fromParticipantId = requiredString(data.fromParticipantId, `${path}[${index}].fromParticipantId`)
    const toParticipantId = requiredString(data.toParticipantId, `${path}[${index}].toParticipantId`)
    if (fromParticipantId === toParticipantId) throw new DocumentDecodeError(`${path}[${index}]`, 'debt participants must be distinct')
    return { fromParticipantId, toParticipantId, money: positiveMoneyValue(data.money, `${path}[${index}].money`) }
  })
}
function settlementBasis(value: unknown, path: string): SettlementBasis {
  const data = record(value, path)
  const kind = data.kind
  if (kind !== 'pairwise' && kind !== 'simplified') throw new DocumentDecodeError(`${path}.kind`, 'must be pairwise or simplified')
  const senderId = requiredString(data.senderId, `${path}.senderId`)
  const recipientId = requiredString(data.recipientId, `${path}.recipientId`)
  if (senderId === recipientId) throw new DocumentDecodeError(path, 'basis participants must be distinct')
  return {
    kind,
    senderId,
    recipientId,
    currency: currencyValue(data.currency, `${path}.currency`),
    debtMinor: positiveSafeInteger(data.debtMinor, `${path}.debtMinor`),
  }
}
function settlementMethod(value: unknown, path: string): SettlementMethod {
  if (value !== 'cash' && value !== 'bank-transfer' && value !== 'payment-app' && value !== 'other') throw new DocumentDecodeError(path, 'settlement method is invalid')
  return value
}
function settlementVoid(value: unknown, path: string): SettlementVoid {
  const data = record(value, path)
  return {
    operationId: requiredString(data.operationId, `${path}.operationId`),
    reason: normalizedSettlementText(data.reason, `${path}.reason`, true),
    actor: actorSnapshot(data.actor, `${path}.actor`),
    createdAt: isoTimestamp(data.createdAt, `${path}.createdAt`),
    revision: positiveInteger(data.revision, `${path}.revision`),
  }
}
function normalizedSettlementText(value: unknown, path: string, required: boolean): string {
  const text = typeof value === 'string' ? value : (() => { throw new DocumentDecodeError(path, 'must be plain text') })()
  const normalized = text.normalize('NFC').replace(/\r\n?/g, '\n').trim()
  if ((required && !normalized) || normalized !== text || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(normalized)) throw new DocumentDecodeError(path, 'must be normalized plain text')
  if ([...normalized].length > 500) throw new DocumentDecodeError(path, 'must be at most 500 Unicode code points')
  return normalized
}
function moneyValue(value: unknown, path: string): ExpenseRow['total'] {
  const data = record(value, path)
  const currency = currencyValue(data.currency, `${path}.currency`)
  const minorAmount = nonNegativeSafeInteger(data.minorAmount, `${path}.minorAmount`)
  return { currency, minorAmount }
}
function positiveMoneyValue(value: unknown, path: string): ExpenseRow['total'] {
  const data = record(value, path)
  const currency = currencyValue(data.currency, `${path}.currency`)
  if (!Number.isSafeInteger(data.minorAmount) || (data.minorAmount as number) <= 0) throw new DocumentDecodeError(path, 'money must be positive')
  return { currency, minorAmount: data.minorAmount as number }
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
function requiredBoolean(value: unknown, path: string): boolean { if (typeof value !== 'boolean') throw new DocumentDecodeError(path, 'must be a boolean'); return value }
function nonNegativeSafeInteger(value: unknown, path: string): number { if (!Number.isSafeInteger(value) || (value as number) < 0) throw new DocumentDecodeError(path, 'must be a non-negative safe integer'); return value as number }
function positiveSafeInteger(value: unknown, path: string): number { if (!Number.isSafeInteger(value) || (value as number) < 1) throw new DocumentDecodeError(path, 'must be a positive safe integer'); return value as number }
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
