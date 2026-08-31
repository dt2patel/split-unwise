import { describe, expect, it } from 'vitest'
import type { ExpenseRow, Group, Member } from '../../data/repositories'
import { searchExpenses } from '../search'

describe('premium expense search', () => {
  it('normalizes Unicode and combines dimensions with AND while selections within dimensions use OR', () => {
    const result = searchExpenses({
      groups: [group('lake', 'Lake House'), group('city', 'City Trip')],
      expenses: [
        expense('cafe', 'lake', 'Café brunch', 'Crème brûlée', 'Food', ['maya'], '2026-08-01', 1200, 'USD'),
        expense('train', 'city', 'Night train', 'Reserved cabin', 'Travel', ['alex'], '2026-08-02', 8000, 'USD'),
        expense('museum', 'city', 'Museum', 'Modern art', 'Fun', ['maya', 'alex'], '2026-08-03', 2500, 'EUR'),
      ],
      filters: { query: 'CAFE creme', groupIds: ['lake', 'city'], participantIds: ['maya', 'someone-else'], categories: ['Food', 'Travel'], dateFrom: '2026-08-01', dateTo: '2026-08-02', minMinor: 1000, maxMinor: 2000, currency: 'USD' },
      coverageStatus: 'complete',
    })

    expect(result.items.map(({ expense }) => expense.id)).toEqual(['cafe'])
    expect(result.coverage).toEqual({ status: 'complete', scannedGroups: 2, scannedExpenses: 3 })
  })

  it('rejects malformed filters instead of silently widening a query', () => {
    expect(() => searchExpenses({ groups: [group('lake', 'Lake')], expenses: [], filters: { dateFrom: '08/01/2026' }, coverageStatus: 'complete' })).toThrow('date')
    expect(() => searchExpenses({ groups: [group('lake', 'Lake')], expenses: [], filters: { dateFrom: '2026-02-30' }, coverageStatus: 'complete' })).toThrow('date')
    expect(() => searchExpenses({ groups: [group('lake', 'Lake')], expenses: [], filters: { minMinor: -1, currency: 'USD' }, coverageStatus: 'complete' })).toThrow('amount')
    expect(() => searchExpenses({ groups: [group('lake', 'Lake')], expenses: [], filters: { minMinor: 1 }, coverageStatus: 'complete' })).toThrow('currency')
  })

  it('reports bounded coverage when either client ceiling is reached', () => {
    const groups = Array.from({ length: 100 }, (_, index) => group(`group-${index}`, `Group ${index}`))
    const result = searchExpenses({ groups, expenses: [], filters: {}, coverageStatus: 'complete' })
    expect(result.coverage).toEqual({ status: 'bounded', scannedGroups: 100, scannedExpenses: 0, reason: 'group-limit' })

    const expenses = Array.from({ length: 10_000 }, (_, index) => expense(`expense-${index}`, 'lake', `Expense ${index}`, '', 'Other', ['maya'], '2026-08-01', 1, 'USD'))
    expect(searchExpenses({ groups: [group('lake', 'Lake')], expenses, filters: {}, coverageStatus: 'complete' }).coverage).toEqual({ status: 'bounded', scannedGroups: 1, scannedExpenses: 10_000, reason: 'expense-limit' })
  })

  it('never includes deleted or non-fresh projections in authoritative search', () => {
    const base = expense('base', 'lake', 'Visible', '', 'Other', ['maya'], '2026-08-01', 1, 'USD')
    const result = searchExpenses({ groups: [group('lake', 'Lake')], expenses: [base, { ...base, id: 'stale', syncState: 'stale' }, { ...base, id: 'deleted', deletedAt: '2026-08-02T00:00:00.000Z' }], filters: {}, coverageStatus: 'complete' })
    expect(result.items.map(({ expense }) => expense.id)).toEqual(['base'])
  })

  it('returns stable authorized facets from the full scanned source instead of shrinking them to the current result', () => {
    const lake = group('lake', 'Lake House')
    const city = group('city', 'City Trip')
    const maya: Member = { id: 'maya', displayName: 'Maya P.', initials: 'MP', isCurrentUser: true }
    const alex: Member = { id: 'alex', displayName: 'Alex R.', initials: 'AR', isCurrentUser: false }
    const result = searchExpenses({
      groups: [lake, city], membersByGroup: new Map([['lake', [maya]], ['city', [alex]]]),
      expenses: [
        expense('cafe', 'lake', 'Café', '', 'Food', ['maya'], '2026-08-01', 1200, 'USD'),
        expense('museum', 'city', 'Museum', '', 'Fun', ['alex'], '2026-08-02', 2500, 'EUR'),
      ],
      filters: { query: 'cafe' }, coverageStatus: 'complete',
    })

    expect(result.items.map(({ expense }) => expense.id)).toEqual(['cafe'])
    expect(result.facets.groups.map(({ id }) => id)).toEqual(['city', 'lake'])
    expect(result.facets.participants).toEqual([{ id: 'alex', displayName: 'Alex R.' }, { id: 'maya', displayName: 'Maya P.' }])
    expect(result.facets.categories).toEqual(['Food', 'Fun'])
    expect(result.facets.currencies).toEqual(['EUR', 'USD'])
  })
})

function group(id: string, name: string): Group { return { id, name, currency: 'USD', memberIds: ['maya', 'alex'], syncState: 'fresh' } }
function expense(id: string, groupId: string, description: string, notes: string, category: string, participantIds: readonly string[], date: string, minorAmount: number, currency: 'USD' | 'EUR'): ExpenseRow {
  return {
    id, groupId, description, notes, category, date, total: { currency, minorAmount },
    payments: [{ participantId: participantIds[0]!, money: { currency, minorAmount } }],
    allocations: participantIds.map((participantId, index) => ({ participantId, money: { currency, minorAmount: index === 0 ? minorAmount : 0 } })),
    splitMethod: { type: 'equal', participantIds }, attachmentRefs: [], createdAt: `${date}T12:00:00.000Z`, updatedAt: `${date}T12:00:00.000Z`, revision: 1, syncState: 'fresh',
  }
}
