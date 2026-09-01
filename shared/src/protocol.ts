import { z } from 'zod'
import { CURRENCY_EXPONENTS } from './money.js'

const nonEmpty = z.string().trim().min(1).max(500)
const id = z.string().trim().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
const operationId = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
const safeMinor = z.number().int().safe().nonnegative()
const positiveMinor = z.number().int().safe().positive()
const currency = z.enum(Object.keys(CURRENCY_EXPONENTS) as [keyof typeof CURRENCY_EXPONENTS, ...(keyof typeof CURRENCY_EXPONENTS)[]])
const money = z.strictObject({ currency, minorAmount: safeMinor })
const positiveMoney = z.strictObject({ currency, minorAmount: positiveMinor })
const allocation = z.strictObject({ participantId: id, money })
const recurrence = z.strictObject({
  frequency: z.enum(['weekly', 'fortnightly', 'monthly', 'yearly']),
  anchor: z.strictObject({ month: z.number().int().min(1).max(12), day: z.number().int().min(1).max(31) }),
  timeZone: z.string().trim().min(1).max(100),
})
const exactSplit = z.strictObject({ type: z.literal('exact'), allocations: z.array(allocation).min(1).max(100) })
const equalSplit = z.strictObject({ type: z.literal('equal'), participantIds: z.array(id).min(1).max(100) })
const percentageSplit = z.strictObject({ type: z.literal('percentage'), participantIds: z.array(id).min(1).max(100), percentages: z.record(id, z.number().finite().nonnegative()) })
const sharesSplit = z.strictObject({ type: z.literal('shares'), participantIds: z.array(id).min(1).max(100), shares: z.record(id, z.number().finite().nonnegative()) })
const adjustmentSplit = z.strictObject({ type: z.literal('adjustment'), participantIds: z.array(id).min(1).max(100), adjustments: z.record(id, z.number().int().safe()) })
const itemizedSplit = z.strictObject({ type: z.literal('itemized'), items: z.array(z.strictObject({ description: nonEmpty, money, participantIds: z.array(id).min(1).max(100) })).min(1).max(200) })
const splitMethod = z.discriminatedUnion('type', [exactSplit, equalSplit, percentageSplit, sharesSplit, adjustmentSplit, itemizedSplit])
const expenseDraft = {
  groupId: id,
  description: nonEmpty,
  date: z.iso.date(),
  total: money,
  payments: z.array(allocation).min(1).max(100),
  allocations: z.array(allocation).min(1).max(100),
  category: z.string().trim().min(1).max(80),
  splitMethod,
  notes: z.string().max(5000).optional(),
  attachmentRefs: z.array(id).max(20),
  recurrence: recurrence.optional(),
  occurrenceEditScope: z.enum(['future', 'occurrence']).optional(),
} as const
const base = { operationId }
const defaultSplit = z.discriminatedUnion('type', [equalSplit, percentageSplit, sharesSplit])
const fxRate = z.strictObject({
  baseCurrency: currency,
  quoteCurrency: currency,
  numerator: z.number().int().safe().positive(),
  denominator: z.number().int().safe().positive(),
  authority: z.string().trim().min(1).max(200),
  effectiveDate: z.iso.date(),
  observedAt: z.iso.datetime({ offset: true }),
})
const cursor = z.strictObject({ createdAt: z.iso.datetime({ offset: true }), id })
const basis = z.strictObject({ kind: z.enum(['pairwise', 'simplified']), senderId: id, recipientId: id, currency, debtMinor: positiveMinor })

export const commandEnvelopeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('expense.add'), ...base, ...expenseDraft }),
  z.strictObject({ kind: z.literal('expense.edit'), ...base, groupId: id, expenseId: id, expectedRevision: z.number().int().positive(), draft: z.strictObject(expenseDraft) }),
  z.strictObject({ kind: z.literal('expense.delete'), ...base, groupId: id, expenseId: id, expectedRevision: z.number().int().positive() }),
  z.strictObject({ kind: z.literal('comment.add'), ...base, groupId: id, expenseId: id, body: z.string().trim().min(1).max(5000), attachmentRefs: z.array(id).max(20) }),
  z.strictObject({ kind: z.literal('comment.delete'), ...base, groupId: id, expenseId: id, commentId: id }),
  z.strictObject({ kind: z.literal('notification.read'), ...base, notificationId: id }),
  z.strictObject({ kind: z.literal('notification.read-all'), ...base, cutoff: cursor }),
  z.strictObject({ kind: z.literal('notification.preferences'), ...base, preferences: z.strictObject({ emailEnabled: z.boolean(), pushEnabled: z.boolean() }) }),
  z.strictObject({ kind: z.literal('settlement.record'), ...base, groupId: id, expectedBalanceRevision: z.number().int().nonnegative(), basis, money: positiveMoney, method: z.enum(['cash', 'bank-transfer', 'payment-app', 'other']), occurredOn: z.iso.date(), note: z.string().max(2000).optional(), outsidePaymentConfirmed: z.literal(true) }),
  z.strictObject({ kind: z.literal('settlement.void'), ...base, groupId: id, settlementId: id, expectedRevision: z.number().int().positive(), expectedBalanceRevision: z.number().int().nonnegative(), reason: z.string().trim().min(1).max(1000) }),
  z.strictObject({ kind: z.literal('group.default-split'), ...base, groupId: id, expectedRevision: z.number().int().positive(), defaultSplit: defaultSplit.nullable() }),
  z.strictObject({ kind: z.literal('group.currency-conversion'), ...base, groupId: id, expectedRevision: z.number().int().positive(), targetCurrency: currency, rates: z.array(fxRate).min(1).max(16) }),
  z.strictObject({ kind: z.literal('group.delete'), ...base, groupId: id }),
  z.strictObject({ kind: z.literal('group.simplify-debts'), ...base, groupId: id, expectedRevision: z.number().int().positive(), simplifyDebtsEnabled: z.boolean() }),
  z.strictObject({ kind: z.literal('group.member-remove'), ...base, groupId: id, targetMemberId: id }),
  z.strictObject({ kind: z.literal('group.restore'), ...base, groupId: id }),
  z.strictObject({ kind: z.literal('profile.update'), ...base, displayName: z.string().trim().min(1).max(120), initials: z.string().trim().min(1).max(4).optional() }),
])

export const executeCommandRequestSchema = z.strictObject({ schemaVersion: z.literal(1), command: commandEnvelopeSchema })
export type SharedCommandEnvelope = z.infer<typeof commandEnvelopeSchema>
export type ExecuteCommandRequest = z.infer<typeof executeCommandRequestSchema>

export function parseExecuteCommandRequest(value: unknown): ExecuteCommandRequest {
  return executeCommandRequestSchema.parse(value)
}

export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  return `{${Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`).join(',')}}`
}

export function assertExpenseMoney(command: Extract<SharedCommandEnvelope, { kind: 'expense.add' }> | Extract<SharedCommandEnvelope, { kind: 'expense.edit' }>['draft']): void {
  const participants = new Set<string>()
  const total = command.total
  if (total.minorAmount <= 0) throw new Error('Expense total must be positive')
  const validateEntries = (entries: typeof command.allocations, label: string) => {
    for (const entry of entries) {
      if (entry.money.currency !== total.currency) throw new Error(`${label} currency must match expense currency`)
      if (participants.has(`${label}:${entry.participantId}`)) throw new Error(`Expense cannot repeat a ${label.toLowerCase()}`)
      participants.add(`${label}:${entry.participantId}`)
    }
    const sum = entries.reduce((value, entry) => value + BigInt(entry.money.minorAmount), 0n)
    if (sum !== BigInt(total.minorAmount)) throw new Error(`Expense ${label.toLowerCase()}s must equal its total`)
  }
  validateEntries(command.payments, 'Payment')
  validateEntries(command.allocations, 'Allocation')
}
