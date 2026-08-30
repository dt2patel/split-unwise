import { describe, expect, it } from 'vitest'
import { buildCurrencyTotals, buildGroupCharts } from '../aggregates'
import type { ExpenseRow } from '../repositories'

const expense = (id: string, amount: number): ExpenseRow => ({
  id, groupId: 'lake-house-weekend', description: id, date: '2026-08-30', category: 'Food', createdAt: '2026-08-30T12:00:00.000Z', updatedAt: '2026-08-30T12:00:00.000Z', revision: 1, syncState: 'fresh',
  total: { currency: 'USD', minorAmount: amount }, payments: [{ participantId: 'maya-p', money: { currency: 'USD', minorAmount: amount } }], allocations: [{ participantId: 'maya-p', money: { currency: 'USD', minorAmount: amount } }],
  splitMethod: { type: 'exact', allocations: [{ participantId: 'maya-p', money: { currency: 'USD', minorAmount: amount } }] }, attachmentRefs: [],
})

describe('checked aggregates', () => {
  it('rejects an overflow before emitting totals or chart values', () => {
    const rows = [expense('maximum', Number.MAX_SAFE_INTEGER), expense('one-more', 1)]
    expect(() => buildCurrencyTotals(rows, 'maya-p')).toThrow('safe integer')
    expect(() => buildGroupCharts(rows)).toThrow('safe integer')
  })
})
