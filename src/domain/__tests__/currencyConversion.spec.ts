import { describe, expect, it } from 'vitest'
import type { ExpenseRow, SettlementRecord } from '../../data/repositories'
import {
  applyCurrencyConversionToExpense,
  applyCurrencyConversionToSettlement,
  sourceMoneyForConversion,
  type GroupCurrencyConversion,
} from '../currencyConversion'

const conversion: GroupCurrencyConversion = {
  schemaVersion: 1,
  operationId: 'convert-group-1',
  targetCurrency: 'JPY',
  convertedAt: '2026-09-01T12:00:00.000Z',
  rates: [{
    baseCurrency: 'USD', quoteCurrency: 'JPY', numerator: 150, denominator: 1,
    authority: 'European Central Bank via Frankfurter', effectiveDate: '2026-08-29', observedAt: '2026-09-01T11:59:00.000Z',
  }],
}

const expense: ExpenseRow = {
  id: 'expense-one', groupId: 'lake-house', description: 'Groceries', date: '2026-08-29',
  total: { currency: 'USD', minorAmount: 1001 },
  payments: [
    { participantId: 'maya', money: { currency: 'USD', minorAmount: 501 } },
    { participantId: 'alex', money: { currency: 'USD', minorAmount: 500 } },
  ],
  allocations: [
    { participantId: 'maya', money: { currency: 'USD', minorAmount: 334 } },
    { participantId: 'alex', money: { currency: 'USD', minorAmount: 667 } },
  ],
  category: 'Food', createdAt: '2026-08-29T10:00:00.000Z', updatedAt: '2026-08-29T10:00:00.000Z', revision: 1,
  splitMethod: { type: 'exact', allocations: [
    { participantId: 'maya', money: { currency: 'USD', minorAmount: 334 } },
    { participantId: 'alex', money: { currency: 'USD', minorAmount: 667 } },
  ] },
  attachmentRefs: [], syncState: 'fresh',
}

const settlement: SettlementRecord = {
  settlementId: 'settlement-one', groupId: 'lake-house', operationId: 'settle-1', senderId: 'maya', recipientId: 'alex',
  money: { currency: 'USD', minorAmount: 1001 },
  basis: { kind: 'pairwise', senderId: 'maya', recipientId: 'alex', currency: 'USD', debtMinor: 2000 },
  method: 'cash', occurredOn: '2026-08-30', createdBy: { id: 'maya', displayName: 'Maya' },
  createdAt: '2026-08-30T10:00:00.000Z', revision: 1, syncState: 'fresh',
}

describe('applied group currency conversion', () => {
  it('converts the full expense ledger with currency exponents and deterministic remainder distribution', () => {
    const projected = applyCurrencyConversionToExpense(expense, conversion)

    expect(projected.total).toEqual({ currency: 'JPY', minorAmount: 1502 })
    expect(projected.payments).toEqual([
      { participantId: 'maya', money: { currency: 'JPY', minorAmount: 752 } },
      { participantId: 'alex', money: { currency: 'JPY', minorAmount: 750 } },
    ])
    expect(projected.allocations).toEqual([
      { participantId: 'maya', money: { currency: 'JPY', minorAmount: 502 } },
      { participantId: 'alex', money: { currency: 'JPY', minorAmount: 1000 } },
    ])
    expect(projected.splitMethod).toEqual({ type: 'exact', allocations: projected.allocations })
    expect(projected.currencyConversion).toEqual({
      operationId: 'convert-group-1', sourceMoney: { currency: 'USD', minorAmount: 1001 },
      targetCurrency: 'JPY', authority: 'European Central Bank via Frankfurter', effectiveDate: '2026-08-29',
    })
    expect(expense.total).toEqual({ currency: 'USD', minorAmount: 1001 })
  })

  it('converts settlement money and its balance basis together', () => {
    const projected = applyCurrencyConversionToSettlement(settlement, conversion)

    expect(projected.money).toEqual({ currency: 'JPY', minorAmount: 1502 })
    expect(projected.basis).toEqual({ kind: 'pairwise', senderId: 'maya', recipientId: 'alex', currency: 'JPY', debtMinor: 3000 })
    expect(projected.currencyConversion?.sourceMoney).toEqual({ currency: 'USD', minorAmount: 1001 })
  })

  it('leaves later writes and target-currency values untouched', () => {
    const later = { ...expense, updatedAt: '2026-09-01T12:00:00.001Z' }
    const target = { ...expense, total: { currency: 'JPY' as const, minorAmount: 1001 }, payments: [
      { participantId: 'maya', money: { currency: 'JPY' as const, minorAmount: 501 } },
      { participantId: 'alex', money: { currency: 'JPY' as const, minorAmount: 500 } },
    ], allocations: [
      { participantId: 'maya', money: { currency: 'JPY' as const, minorAmount: 334 } },
      { participantId: 'alex', money: { currency: 'JPY' as const, minorAmount: 667 } },
    ], splitMethod: { type: 'exact' as const, allocations: [
      { participantId: 'maya', money: { currency: 'JPY' as const, minorAmount: 334 } },
      { participantId: 'alex', money: { currency: 'JPY' as const, minorAmount: 667 } },
    ] } }

    expect(applyCurrencyConversionToExpense(later, conversion)).toBe(later)
    expect(applyCurrencyConversionToExpense(target, conversion)).toBe(target)
  })

  it('retains the stored source money so a later conversion can fetch a direct rate', () => {
    const projected = applyCurrencyConversionToExpense(expense, conversion)

    expect(sourceMoneyForConversion(projected)).toEqual({ currency: 'USD', minorAmount: 1001 })
    expect(sourceMoneyForConversion(expense)).toEqual({ currency: 'USD', minorAmount: 1001 })
  })

  it.each([
    {
      label: 'equal',
      splitMethod: { type: 'equal' as const, participantIds: ['maya', 'alex'] },
      allocations: [501, 500],
      expectedMethod: { type: 'equal', participantIds: ['maya', 'alex'] },
      expectedAllocations: [751, 751],
    },
    {
      label: 'percentage',
      splitMethod: { type: 'percentage' as const, participantIds: ['maya', 'alex'], percentages: { maya: 25, alex: 75 } },
      allocations: [251, 750],
      expectedMethod: { type: 'percentage', participantIds: ['maya', 'alex'], percentages: { maya: 25, alex: 75 } },
      expectedAllocations: [376, 1126],
    },
    {
      label: 'shares',
      splitMethod: { type: 'shares' as const, participantIds: ['maya', 'alex'], shares: { maya: 1, alex: 3 } },
      allocations: [251, 750],
      expectedMethod: { type: 'shares', participantIds: ['maya', 'alex'], shares: { maya: 1, alex: 3 } },
      expectedAllocations: [376, 1126],
    },
    {
      label: 'adjustment',
      splitMethod: { type: 'adjustment' as const, participantIds: ['maya', 'alex'], adjustments: { maya: 101, alex: 0 } },
      allocations: [551, 450],
      expectedMethod: { type: 'adjustment', participantIds: ['maya', 'alex'], adjustments: { maya: 152, alex: 0 } },
      expectedAllocations: [827, 675],
    },
    {
      label: 'itemized',
      splitMethod: { type: 'itemized' as const, items: [
        { description: 'Produce', money: { currency: 'USD' as const, minorAmount: 334 }, participantIds: ['maya'] },
        { description: 'Pantry', money: { currency: 'USD' as const, minorAmount: 667 }, participantIds: ['alex'] },
      ] },
      allocations: [334, 667],
      expectedMethod: { type: 'itemized', items: [
        { description: 'Produce', money: { currency: 'JPY', minorAmount: 502 }, participantIds: ['maya'] },
        { description: 'Pantry', money: { currency: 'JPY', minorAmount: 1000 }, participantIds: ['alex'] },
      ] },
      expectedAllocations: [502, 1000],
    },
  ])('preserves $label split intent while making the converted ledger exact', ({ splitMethod, allocations, expectedMethod, expectedAllocations }) => {
    const source: ExpenseRow = {
      ...expense,
      payments: [{ participantId: 'maya', money: { currency: 'USD', minorAmount: 1001 } }],
      allocations: allocations.map((minorAmount, index) => ({ participantId: index === 0 ? 'maya' : 'alex', money: { currency: 'USD', minorAmount } })),
      splitMethod,
    }

    const projected = applyCurrencyConversionToExpense(source, conversion)

    expect(projected.splitMethod).toEqual(expectedMethod)
    expect(projected.allocations.map(({ money }) => money.minorAmount)).toEqual(expectedAllocations)
    expect(projected.allocations.reduce((sum, { money }) => sum + money.minorAmount, 0)).toBe(1502)
  })
})
