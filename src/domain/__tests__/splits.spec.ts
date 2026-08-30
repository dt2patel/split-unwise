import { describe, expect, it } from 'vitest'
import type { Money } from '../model'
import { computeAllocations } from '../splits'

const total: Money = { currency: 'USD', minorAmount: 101 }

function amounts(allocations: ReturnType<typeof computeAllocations>) {
  return allocations.map(({ participantId, money }) => [participantId, money.minorAmount])
}

describe('split allocations', () => {
  it('splits equal shares and gives minor-unit remainders to participant order', () => {
    expect(amounts(computeAllocations(total, {
      type: 'equal',
      participantIds: ['alex', 'blair', 'casey'],
    }))).toEqual([
      ['alex', 34],
      ['blair', 34],
      ['casey', 33],
    ])
  })

  it('accepts exact allocations only when they equal the expense total', () => {
    expect(amounts(computeAllocations(total, {
      type: 'exact',
      allocations: [
        { participantId: 'alex', money: { currency: 'USD', minorAmount: 1 } },
        { participantId: 'blair', money: { currency: 'USD', minorAmount: 100 } },
      ],
    }))).toEqual([
      ['alex', 1],
      ['blair', 100],
    ])
  })

  it('distributes percentage remainders in participant order', () => {
    expect(amounts(computeAllocations(total, {
      type: 'percentage',
      participantIds: ['alex', 'blair', 'casey'],
      percentages: { alex: 50, blair: 30, casey: 20 },
    }))).toEqual([
      ['alex', 51],
      ['blair', 30],
      ['casey', 20],
    ])
  })

  it('distributes weighted-share remainders in participant order', () => {
    expect(amounts(computeAllocations(total, {
      type: 'shares',
      participantIds: ['alex', 'blair', 'casey'],
      shares: { alex: 3, blair: 2, casey: 1 },
    }))).toEqual([
      ['alex', 51],
      ['blair', 34],
      ['casey', 16],
    ])
  })

  it('applies fixed adjustments before equally splitting the residual', () => {
    expect(amounts(computeAllocations(total, {
      type: 'adjustment',
      participantIds: ['alex', 'blair', 'casey'],
      adjustments: { alex: 10 },
    }))).toEqual([
      ['alex', 41],
      ['blair', 30],
      ['casey', 30],
    ])
  })

  it('adds deterministic equal allocations from itemized receipt lines', () => {
    expect(amounts(computeAllocations(total, {
      type: 'itemized',
      items: [
        {
          description: 'groceries',
          money: { currency: 'USD', minorAmount: 51 },
          participantIds: ['alex', 'blair'],
        },
        {
          description: 'wine',
          money: { currency: 'USD', minorAmount: 50 },
          participantIds: ['blair', 'casey'],
        },
      ],
    }))).toEqual([
      ['alex', 26],
      ['blair', 50],
      ['casey', 25],
    ])
  })

  it('uses overflow-safe ratio arithmetic for large totals and shares', () => {
    const largeTotal: Money = { currency: 'USD', minorAmount: Number.MAX_SAFE_INTEGER }
    const allocations = computeAllocations(largeTotal, {
      type: 'shares',
      participantIds: ['alex', 'blair'],
      shares: { alex: Number.MAX_VALUE, blair: 1 },
    })

    expect(amounts(allocations)).toEqual([
      ['alex', Number.MAX_SAFE_INTEGER],
      ['blair', 0],
    ])
    expect(allocations.reduce((sum, allocation) => sum + allocation.money.minorAmount, 0)).toBe(Number.MAX_SAFE_INTEGER)
  })

  it('rejects a non-canonical currency at the split boundary', () => {
    const malformedTotal = { currency: 'usd', minorAmount: 100 } as unknown as Money
    expect(() => computeAllocations(malformedTotal, {
      type: 'equal',
      participantIds: ['alex', 'blair'],
    })).toThrow('Unsupported ISO 4217 currency')
  })
})
