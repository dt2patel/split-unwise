import { describe, expect, it } from 'vitest'
import { buildCurrencyTotals, buildGroupCharts } from '../aggregates'
import type { ExpenseRow } from '../repositories'

const expense = (id: string, amount: number): ExpenseRow => ({
  id, groupId: 'lake-house-weekend', description: id, date: '2026-08-30', category: 'Food', createdAt: '2026-08-30T12:00:00.000Z', updatedAt: '2026-08-30T12:00:00.000Z', revision: 1, syncState: 'fresh',
  total: { currency: 'USD', minorAmount: amount }, payments: [{ participantId: 'maya-p', money: { currency: 'USD', minorAmount: amount } }], allocations: [{ participantId: 'maya-p', money: { currency: 'USD', minorAmount: amount } }],
  splitMethod: { type: 'exact', allocations: [{ participantId: 'maya-p', money: { currency: 'USD', minorAmount: amount } }] }, attachmentRefs: [],
})

describe('checked aggregates', () => {
  it('nets reimbursements out of spending and reverses each member contribution', () => {
    const refund: ExpenseRow = {
      ...expense('deposit-refund', 1000),
      reimbursement: true,
      payments: [{ participantId: 'maya-p', money: { currency: 'USD', minorAmount: 1000 } }],
      allocations: [{ participantId: 'alex-r', money: { currency: 'USD', minorAmount: 1000 } }],
      splitMethod: { type: 'exact', allocations: [{ participantId: 'alex-r', money: { currency: 'USD', minorAmount: 1000 } }] },
    }

    expect(buildCurrencyTotals([refund], 'maya-p')).toEqual([
      { currency: 'USD', totalPaid: -1000, currentUserPaid: -1000, currentUserShare: 0, currentUserNet: -1000 },
    ])
    expect(buildCurrencyTotals([refund], 'alex-r')).toEqual([
      { currency: 'USD', totalPaid: -1000, currentUserPaid: 0, currentUserShare: -1000, currentUserNet: 1000 },
    ])
    expect(buildGroupCharts([refund])).toEqual({
      categorySpending: [{ currency: 'USD', category: 'Food', minorAmount: -1000 }],
      dailySpending: [{ currency: 'USD', date: '2026-08-30', minorAmount: -1000 }],
    })
  })

  it('rejects an overflow before emitting totals or chart values', () => {
    const rows = [expense('maximum', Number.MAX_SAFE_INTEGER), expense('one-more', 1)]
    expect(() => buildCurrencyTotals(rows, 'maya-p')).toThrow('safe integer')
    expect(() => buildGroupCharts(rows)).toThrow('safe integer')
  })
})
