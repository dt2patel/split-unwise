import { describe, expect, it } from 'vitest'
import type { Expense } from '../model'
import { computeBalances, simplifyDebts } from '../balances'

const expenses: readonly Expense[] = [
  {
    id: 'dinner',
    description: 'Dinner',
    date: '2026-08-01',
    total: { currency: 'USD', minorAmount: 900 },
    payments: [{ participantId: 'alex', money: { currency: 'USD', minorAmount: 900 } }],
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
    payments: [{ participantId: 'blair', money: { currency: 'USD', minorAmount: 300 } }],
    allocations: [
      { participantId: 'alex', money: { currency: 'USD', minorAmount: 100 } },
      { participantId: 'blair', money: { currency: 'USD', minorAmount: 100 } },
      { participantId: 'casey', money: { currency: 'USD', minorAmount: 100 } },
    ],
  },
]

describe('balances', () => {
  it('preserves exact participant nets when an expense has multiple payers', () => {
    const multiPayer = {
      id: 'shared-cabin',
      description: 'Shared cabin',
      date: '2026-08-04',
      total: { currency: 'USD', minorAmount: 1000 },
      payments: [
        { participantId: 'alex', money: { currency: 'USD', minorAmount: 700 } },
        { participantId: 'blair', money: { currency: 'USD', minorAmount: 300 } },
      ],
      allocations: [
        { participantId: 'alex', money: { currency: 'USD', minorAmount: 250 } },
        { participantId: 'blair', money: { currency: 'USD', minorAmount: 250 } },
        { participantId: 'casey', money: { currency: 'USD', minorAmount: 500 } },
      ],
    } as Expense

    expect(simplifyDebts(computeBalances([multiPayer]))).toEqual([
      { fromParticipantId: 'casey', toParticipantId: 'alex', money: { currency: 'USD', minorAmount: 450 } },
      { fromParticipantId: 'casey', toParticipantId: 'blair', money: { currency: 'USD', minorAmount: 50 } },
    ])
  })

  it('rejects duplicate payers and payment totals that do not equal the expense', () => {
    const base = {
      id: 'invalid-payments',
      description: 'Invalid payments',
      date: '2026-08-04',
      total: { currency: 'USD', minorAmount: 1000 },
      allocations: [{ participantId: 'casey', money: { currency: 'USD', minorAmount: 1000 } }],
    }
    expect(() => computeBalances([{ ...base, payments: [
      { participantId: 'alex', money: { currency: 'USD', minorAmount: 500 } },
      { participantId: 'alex', money: { currency: 'USD', minorAmount: 500 } },
    ] } as Expense])).toThrow('Expense cannot repeat a payer')
    expect(() => computeBalances([{ ...base, payments: [
      { participantId: 'alex', money: { currency: 'USD', minorAmount: 999 } },
    ] } as Expense])).toThrow('Expense payments must equal its total')
  })

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
      payments: [{ participantId: 'alex', money: { currency: 'USD', minorAmount: Number.MAX_SAFE_INTEGER } }],
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
