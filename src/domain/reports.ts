import type { ExpenseRow, Member, SettlementRecord } from '../data/repositories'
import type { CurrencyCode } from './money'

export interface ReportCoverage {
  readonly status: 'complete' | 'bounded'
  readonly scannedGroups: number
  readonly scannedExpenses: number
  readonly reason?: 'expense-limit' | 'group-limit' | 'provider-unavailable'
}

export interface ReportSource {
  readonly currentUserId: string
  readonly members: readonly Member[]
  readonly expenses: readonly ExpenseRow[]
  readonly settlements: readonly SettlementRecord[]
  readonly coverage: ReportCoverage
}

export interface ReportInput {
  readonly currentUserId: string
  readonly members: readonly Member[]
  readonly expenses: readonly ExpenseRow[]
  readonly previewExpenses: readonly ExpenseRow[]
  readonly settlements: readonly SettlementRecord[]
  readonly authority: {
    readonly status: 'confirmed'
    readonly excludedDeleted: number
    readonly excludedUnconfirmed: number
    readonly excludedVoidedSettlements: number
  }
  readonly coverage: ReportCoverage
}

export interface CurrencyReportTotals {
  readonly currency: CurrencyCode
  readonly expenseTotal: number
  readonly currentUserPaid: number
  readonly currentUserShare: number
  readonly settlementSent: number
  readonly settlementReceived: number
  /** Expense paid minus share, plus settlements sent, minus settlements received. This is not the current balance. */
  readonly periodNet: number
}

export interface ReportModel {
  readonly totals: readonly CurrencyReportTotals[]
  readonly category: readonly { readonly currency: CurrencyCode; readonly category: string; readonly minorAmount: number }[]
  readonly daily: readonly { readonly currency: CurrencyCode; readonly date: string; readonly minorAmount: number }[]
  readonly monthly: readonly { readonly currency: CurrencyCode; readonly month: string; readonly minorAmount: number }[]
  readonly memberContributions: readonly { readonly currency: CurrencyCode; readonly participantId: string; readonly paidMinor: number; readonly shareMinor: number }[]
  readonly balanceOverTime: readonly { readonly currency: CurrencyCode; readonly occurredOn: string; readonly id: string; readonly minorAmount: number }[]
  readonly authority: ReportInput['authority']
  readonly coverage: ReportCoverage
}

export function selectReportInput(source: ReportSource): ReportInput {
  const expenses = source.expenses.filter((expense) => expense.syncState === 'fresh' && expense.deletedAt === undefined)
  const previewExpenses = source.expenses.filter((expense) => expense.syncState === 'stale' && expense.deletedAt === undefined)
  const settlements = source.settlements.filter((settlement) => settlement.syncState === 'fresh' && settlement.void === undefined)
  return {
    currentUserId: source.currentUserId,
    members: source.members.map((member) => ({ ...member })),
    expenses,
    previewExpenses,
    settlements,
    authority: {
      status: 'confirmed',
      excludedDeleted: source.expenses.filter(({ deletedAt }) => deletedAt !== undefined).length,
      excludedUnconfirmed: source.expenses.filter((expense) => expense.deletedAt === undefined && expense.syncState !== 'fresh').length,
      excludedVoidedSettlements: source.settlements.filter(({ void: audit }) => audit !== undefined).length,
    },
    coverage: { ...source.coverage },
  }
}

export function buildReport(input: ReportInput): ReportModel {
  const totals = new Map<CurrencyCode, MutableTotals>()
  const categories = new Map<string, bigint>()
  const days = new Map<string, bigint>()
  const months = new Map<string, bigint>()
  const contributions = new Map<string, { paid: bigint; share: bigint }>()
  const balanceEvents: Array<{ currency: CurrencyCode; occurredAt: string; occurredOn: string; id: string; delta: bigint }> = []

  for (const expense of input.expenses) {
    const currency = expense.total.currency
    const direction = expense.reimbursement ? -1 : 1
    const total = mutableTotals(totals, currency)
    total.expenseTotal = add(total.expenseTotal, direction * expense.total.minorAmount)
    addKey(categories, currency, expense.category, direction * expense.total.minorAmount)
    addKey(days, currency, expense.date, direction * expense.total.minorAmount)
    addKey(months, currency, expense.date.slice(0, 7), direction * expense.total.minorAmount)
    let userPaid = 0n
    let userShare = 0n
    for (const payment of expense.payments) {
      requireSameCurrency(payment.money.currency, currency)
      const row = mutableContribution(contributions, currency, payment.participantId)
      row.paid = add(row.paid, direction * payment.money.minorAmount)
      if (payment.participantId === input.currentUserId) userPaid = add(userPaid, direction * payment.money.minorAmount)
    }
    for (const allocation of expense.allocations) {
      requireSameCurrency(allocation.money.currency, currency)
      const row = mutableContribution(contributions, currency, allocation.participantId)
      row.share = add(row.share, direction * allocation.money.minorAmount)
      if (allocation.participantId === input.currentUserId) userShare = add(userShare, direction * allocation.money.minorAmount)
    }
    total.currentUserPaid += userPaid
    total.currentUserShare += userShare
    balanceEvents.push({ currency, occurredAt: expense.createdAt, occurredOn: expense.date, id: `expense:${expense.id}`, delta: userPaid - userShare })
  }

  for (const settlement of input.settlements) {
    const total = mutableTotals(totals, settlement.money.currency)
    if (settlement.senderId === input.currentUserId) {
      total.settlementSent = add(total.settlementSent, settlement.money.minorAmount)
      balanceEvents.push({ currency: settlement.money.currency, occurredAt: settlement.createdAt, occurredOn: settlement.occurredOn, id: `settlement:${settlement.settlementId}`, delta: BigInt(settlement.money.minorAmount) })
    } else if (settlement.recipientId === input.currentUserId) {
      total.settlementReceived = add(total.settlementReceived, settlement.money.minorAmount)
      balanceEvents.push({ currency: settlement.money.currency, occurredAt: settlement.createdAt, occurredOn: settlement.occurredOn, id: `settlement:${settlement.settlementId}`, delta: -BigInt(settlement.money.minorAmount) })
    }
  }

  const running = new Map<CurrencyCode, bigint>()
  const balanceOverTime = balanceEvents.sort((left, right) => compare(left.occurredOn, right.occurredOn) || compare(left.occurredAt, right.occurredAt) || compare(left.id, right.id)).map((event) => {
    const next = (running.get(event.currency) ?? 0n) + event.delta
    running.set(event.currency, next)
    return { currency: event.currency, occurredOn: event.occurredOn, id: event.id, minorAmount: toSafe(next) }
  })

  return {
    totals: [...totals].sort(([left], [right]) => compare(left, right)).map(([currency, row]) => ({
      currency,
      expenseTotal: toSafe(row.expenseTotal),
      currentUserPaid: toSafe(row.currentUserPaid),
      currentUserShare: toSafe(row.currentUserShare),
      settlementSent: toSafe(row.settlementSent),
      settlementReceived: toSafe(row.settlementReceived),
      periodNet: toSafe(row.currentUserPaid - row.currentUserShare + row.settlementSent - row.settlementReceived),
    })),
    category: aggregateRows(categories, 'category'),
    daily: aggregateRows(days, 'date'),
    monthly: aggregateRows(months, 'month'),
    memberContributions: [...contributions].map(([key, row]) => {
      const [currency, participantId] = splitKey(key)
      return { currency, participantId, paidMinor: toSafe(row.paid), shareMinor: toSafe(row.share) }
    }).sort((left, right) => compare(left.currency, right.currency) || compare(left.participantId, right.participantId)),
    balanceOverTime,
    authority: input.authority,
    coverage: input.coverage,
  }
}

interface MutableTotals { expenseTotal: bigint; currentUserPaid: bigint; currentUserShare: bigint; settlementSent: bigint; settlementReceived: bigint }

function mutableTotals(rows: Map<CurrencyCode, MutableTotals>, currency: CurrencyCode): MutableTotals {
  const existing = rows.get(currency)
  if (existing) return existing
  const created = { expenseTotal: 0n, currentUserPaid: 0n, currentUserShare: 0n, settlementSent: 0n, settlementReceived: 0n }
  rows.set(currency, created)
  return created
}

function mutableContribution(rows: Map<string, { paid: bigint; share: bigint }>, currency: CurrencyCode, participantId: string): { paid: bigint; share: bigint } {
  const key = joinKey(currency, participantId)
  const existing = rows.get(key)
  if (existing) return existing
  const created = { paid: 0n, share: 0n }
  rows.set(key, created)
  return created
}

function addKey(rows: Map<string, bigint>, currency: CurrencyCode, dimension: string, amount: number): void {
  const key = joinKey(currency, dimension)
  rows.set(key, add(rows.get(key) ?? 0n, amount))
}

function aggregateRows<Key extends 'category' | 'date' | 'month'>(rows: Map<string, bigint>, key: Key): readonly ({ readonly currency: CurrencyCode; readonly minorAmount: number } & Record<Key, string>)[] {
  return [...rows].map(([joined, amount]) => {
    const [currency, dimension] = splitKey(joined)
    return { currency, [key]: dimension, minorAmount: toSafe(amount) } as { currency: CurrencyCode; minorAmount: number } & Record<Key, string>
  }).sort((left, right) => compare(left.currency, right.currency) || compare(left[key], right[key]))
}

function add(total: bigint, amount: number): bigint {
  if (!Number.isSafeInteger(amount)) throw new Error('Report input must be a safe integer')
  const result = total + BigInt(amount)
  assertSafe(result)
  return result
}

function toSafe(value: bigint): number { assertSafe(value); return Number(value) }
function assertSafe(value: bigint): void {
  const maximum = BigInt(Number.MAX_SAFE_INTEGER)
  if (value < -maximum || value > maximum) throw new Error('Report aggregate exceeds safe integer range')
}
function requireSameCurrency(actual: CurrencyCode, expected: CurrencyCode): void { if (actual !== expected) throw new Error('Report allocations must match the expense currency') }
function joinKey(currency: CurrencyCode, value: string): string { return `${currency}\u0000${value}` }
function splitKey(value: string): [CurrencyCode, string] { const index = value.indexOf('\u0000'); return [value.slice(0, index) as CurrencyCode, value.slice(index + 1)] }
function compare(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0 }
