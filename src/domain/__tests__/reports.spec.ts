import { describe, expect, it } from 'vitest'
import type { ExpenseRow, Member, SettlementRecord } from '../../data/repositories'
import { buildReport, selectReportInput } from '../reports'

const members: readonly Member[] = [
  { id: 'maya', displayName: 'Maya', initials: 'MP', isCurrentUser: true, canManage: true },
  { id: 'alex', displayName: 'Alex', initials: 'AR', isCurrentUser: false },
]

describe('authoritative premium reports', () => {
  it('selects only fresh current expenses and fresh non-void settlements with explicit exclusions', () => {
    const fresh = expense('fresh', 1000)
    const stale = { ...expense('stale', 2000), syncState: 'stale' as const }
    const deleted = { ...expense('deleted', 3000), deletedAt: '2026-08-10T00:00:00.000Z' }
    const active = settlement('active', 200)
    const voided = { ...settlement('voided', 400), void: { operationId: 'void-op', reason: 'Duplicate', actor: { id: 'maya', displayName: 'Maya' }, createdAt: '2026-08-11T00:00:00.000Z', revision: 2 } }

    const selected = selectReportInput({ currentUserId: 'maya', members, expenses: [fresh, stale, deleted], settlements: [active, voided], coverage: { status: 'complete', scannedGroups: 1, scannedExpenses: 3 } })

    expect(selected.expenses.map(({ id }) => id)).toEqual(['fresh'])
    expect(selected.previewExpenses.map(({ id }) => id)).toEqual(['stale'])
    expect(selected.settlements.map(({ settlementId }) => settlementId)).toEqual(['active'])
    expect(selected.authority).toEqual({ status: 'confirmed', excludedDeleted: 1, excludedUnconfirmed: 1, excludedVoidedSettlements: 1 })
  })

  it('keeps currencies isolated and exposes expense, settlement, and period-net semantics', () => {
    const usdOne = expense('one', 1000, {
      payments: [{ participantId: 'maya', money: { currency: 'USD', minorAmount: 1000 } }],
      allocations: [{ participantId: 'maya', money: { currency: 'USD', minorAmount: 400 } }, { participantId: 'alex', money: { currency: 'USD', minorAmount: 600 } }],
      category: 'Food', date: '2026-08-01',
    })
    const usdTwo = expense('two', 500, {
      payments: [{ participantId: 'alex', money: { currency: 'USD', minorAmount: 500 } }],
      allocations: [{ participantId: 'maya', money: { currency: 'USD', minorAmount: 250 } }, { participantId: 'alex', money: { currency: 'USD', minorAmount: 250 } }],
      category: 'Travel', date: '2026-08-03',
    })
    const eur = expense('eur', 700, { currency: 'EUR', date: '2026-09-01', category: 'Food' })
    const report = buildReport(selectReportInput({
      currentUserId: 'maya', members, expenses: [usdTwo, eur, usdOne], settlements: [settlement('paid-back', 200)],
      coverage: { status: 'complete', scannedGroups: 1, scannedExpenses: 3 },
    }))

    expect(report.totals).toContainEqual({
      currency: 'USD', expenseTotal: 1500, currentUserPaid: 1000, currentUserShare: 650,
      settlementSent: 0, settlementReceived: 200, periodNet: 150,
    })
    expect(report.totals).toContainEqual(expect.objectContaining({ currency: 'EUR', expenseTotal: 700 }))
    expect(report.category).toEqual([
      { currency: 'EUR', category: 'Food', minorAmount: 700 },
      { currency: 'USD', category: 'Food', minorAmount: 1000 },
      { currency: 'USD', category: 'Travel', minorAmount: 500 },
    ])
    expect(report.monthly).toEqual([
      { currency: 'EUR', month: '2026-09', minorAmount: 700 },
      { currency: 'USD', month: '2026-08', minorAmount: 1500 },
    ])
    expect(report.memberContributions.find((row) => row.currency === 'USD' && row.participantId === 'maya')).toEqual({ currency: 'USD', participantId: 'maya', paidMinor: 1000, shareMinor: 650 })
    expect(report.balanceOverTime.filter(({ currency }) => currency === 'USD').at(-1)).toMatchObject({ occurredOn: '2026-08-03', minorAmount: 150 })
  })

  it('uses checked BigInt intermediates and rejects safe-integer overflow', () => {
    expect(() => buildReport(selectReportInput({
      currentUserId: 'maya', members,
      expenses: [expense('maximum', Number.MAX_SAFE_INTEGER), expense('overflow', 1)], settlements: [],
      coverage: { status: 'complete', scannedGroups: 1, scannedExpenses: 2 },
    }))).toThrow('safe integer')
  })

  it('orders same-day balance events by their persisted occurrence timestamp and then domain ID', () => {
    const laterIdFirst = expense('aaa', 100, { createdAt: '2026-08-02T18:00:00.000Z' })
    const earlierIdLast = expense('zzz', 200, { createdAt: '2026-08-02T08:00:00.000Z' })
    const report = buildReport(selectReportInput({
      currentUserId: 'maya', members, expenses: [laterIdFirst, earlierIdLast], settlements: [],
      coverage: { status: 'complete', scannedGroups: 1, scannedExpenses: 2 },
    }))

    expect(report.balanceOverTime.map(({ id }) => id)).toEqual(['expense:zzz', 'expense:aaa'])
  })
})

function expense(id: string, minorAmount: number, override: Partial<ExpenseRow> & { currency?: 'USD' | 'EUR' } = {}): ExpenseRow {
  const currency = override.currency ?? 'USD'
  return {
    id, groupId: 'group', description: id, date: '2026-08-02', total: { currency, minorAmount },
    payments: override.payments ?? [{ participantId: 'alex', money: { currency, minorAmount } }],
    allocations: override.allocations ?? [{ participantId: 'maya', money: { currency, minorAmount } }],
    category: override.category ?? 'Other', splitMethod: { type: 'equal', participantIds: ['maya'] }, notes: `${id} notes`, attachmentRefs: [],
    createdAt: '2026-08-02T12:00:00.000Z', updatedAt: '2026-08-02T12:00:00.000Z', revision: 1, syncState: 'fresh', ...override,
  }
}

function settlement(id: string, minorAmount: number): SettlementRecord {
  return {
    settlementId: id, groupId: 'group', operationId: `operation-${id}`, senderId: 'alex', recipientId: 'maya',
    money: { currency: 'USD', minorAmount }, basis: { kind: 'simplified', senderId: 'alex', recipientId: 'maya', currency: 'USD', debtMinor: minorAmount },
    method: 'cash', occurredOn: '2026-08-02', createdBy: { id: 'maya', displayName: 'Maya' }, createdAt: '2026-08-02T18:00:00.000Z', revision: 1, syncState: 'fresh',
  }
}
