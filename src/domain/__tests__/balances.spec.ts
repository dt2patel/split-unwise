import { describe, expect, it } from 'vitest'
import type { Expense } from '../model'
import { computeBalances, simplifyDebts } from '../balances'

const expenses: readonly Expense[] = [
  {
    id: 'dinner',
    description: 'Dinner',
    date: '2026-08-01',
    total: { currency: 'USD', minorAmount: 900 },
    payerId: 'alex',
    allocations: [
      { participantId: 'alex', money: { currency: 'USD', minorAmount: 300 } },
      { participantId: 'blair', money: { currency: 'USD', minorAmount: 300 } },
      { participantId: 'casey', money: { currency: 'USD', minorAmount: 300 } },
    ],
  },
  {
    id: 'tickets',
    description: 'Tickets',
    date: '2026-08-02',
    total: { currency: 'USD', minorAmount: 300 },
    payerId: 'blair',
    allocations: [
      { participantId: 'alex', money: { currency: 'USD', minorAmount: 100 } },
      { participantId: 'blair', money: { currency: 'USD', minorAmount: 100 } },
      { participantId: 'casey', money: { currency: 'USD', minorAmount: 100 } },
    ],
  },
]

describe('balances', () => {
  it('aggregates payer obligations into canonical signed participant pairs', () => {
    expect(computeBalances(expenses)).toEqual([
      { fromParticipantId: 'alex', toParticipantId: 'blair', money: { currency: 'USD', minorAmount: -200 } },
      { fromParticipantId: 'alex', toParticipantId: 'casey', money: { currency: 'USD', minorAmount: -300 } },
      { fromParticipantId: 'blair', toParticipantId: 'casey', money: { currency: 'USD', minorAmount: -100 } },
    ])
  })

  it('simplifies pairwise balances without changing participant net positions', () => {
    expect(simplifyDebts(computeBalances(expenses))).toEqual([
      { fromParticipantId: 'blair', toParticipantId: 'alex', money: { currency: 'USD', minorAmount: 100 } },
      { fromParticipantId: 'casey', toParticipantId: 'alex', money: { currency: 'USD', minorAmount: 400 } },
    ])
  })

  it('rejects a pairwise total that cannot remain a safe minor-unit integer', () => {
    const maximumExpense = (id: string): Expense => ({
      id,
      description: 'Maximum',
      date: '2026-08-03',
      total: { currency: 'USD', minorAmount: Number.MAX_SAFE_INTEGER },
      payerId: 'alex',
      allocations: [
        { participantId: 'blair', money: { currency: 'USD', minorAmount: Number.MAX_SAFE_INTEGER } },
      ],
    })

    expect(() => computeBalances([maximumExpense('one'), maximumExpense('two')]))
      .toThrow('Money addition exceeds safe integer range')
  })

  it('rejects multi-pair participant nets that cannot be represented safely', () => {
    expect(() => simplifyDebts([
      { fromParticipantId: 'alex', toParticipantId: 'blair', money: { currency: 'USD', minorAmount: Number.MAX_SAFE_INTEGER } },
      { fromParticipantId: 'alex', toParticipantId: 'casey', money: { currency: 'USD', minorAmount: Number.MAX_SAFE_INTEGER } },
    ])).toThrow('Money addition exceeds safe integer range')
  })

  it('preserves a participant net across several distinct pairwise balances', () => {
    expect(simplifyDebts([
      { fromParticipantId: 'alex', toParticipantId: 'blair', money: { currency: 'USD', minorAmount: 70 } },
      { fromParticipantId: 'alex', toParticipantId: 'casey', money: { currency: 'USD', minorAmount: -20 } },
      { fromParticipantId: 'blair', toParticipantId: 'casey', money: { currency: 'USD', minorAmount: 30 } },
    ])).toEqual([
      { fromParticipantId: 'alex', toParticipantId: 'blair', money: { currency: 'USD', minorAmount: 40 } },
      { fromParticipantId: 'alex', toParticipantId: 'casey', money: { currency: 'USD', minorAmount: 10 } },
    ])
  })
})
