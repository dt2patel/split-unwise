import { describe, expect, it } from 'vitest'
import { createDemoRepository } from '../demoRepository'

describe('demo repository', () => {
  it('returns the deterministic Lake House group journal and derived views', async () => {
    const repository = createDemoRepository()

    await expect(repository.app.getCurrentUser()).resolves.toMatchObject({
      id: 'maya-p',
      displayName: 'Maya P.',
    })
    await expect(repository.groups.getById('lake-house-weekend')).resolves.toMatchObject({
      id: 'lake-house-weekend',
      name: 'Lake House Weekend',
      coverImageUrl: '/assets/images/lake-house-cover.png',
    })
    await expect(repository.groups.listMembers('lake-house-weekend')).resolves.toEqual([
      expect.objectContaining({ id: 'maya-p', displayName: 'Maya P.' }),
      expect.objectContaining({ id: 'jordan-k', displayName: 'Jordan K.' }),
      expect.objectContaining({ id: 'alex-r', displayName: 'Alex R.' }),
      expect.objectContaining({ id: 'taylor-s', displayName: 'Taylor S.' }),
    ])
    await expect(repository.expenses.listForGroup('lake-house-weekend')).resolves.toMatchObject([
      { id: 'gas-for-the-boat', date: '2026-08-26', description: 'Gas for the boat', total: { currency: 'USD', minorAmount: 5600 } },
      { id: 'dinner', date: '2026-08-27', description: 'Dinner', total: { currency: 'USD', minorAmount: 7300 } },
      { id: 'cabin-deposit', date: '2026-08-28', description: 'Cabin deposit', total: { currency: 'USD', minorAmount: 40000 } },
      { id: 'kayak-rental', date: '2026-08-29', description: 'Kayak rental', total: { currency: 'USD', minorAmount: 6000 } },
      { id: 'groceries', date: '2026-08-30', description: 'Groceries', total: { currency: 'USD', minorAmount: 17000 } },
    ])
    await expect(repository.groups.getBalances('lake-house-weekend')).resolves.toEqual([
      { fromParticipantId: 'jordan-k', toParticipantId: 'alex-r', money: { currency: 'USD', minorAmount: 12975 } },
      { fromParticipantId: 'taylor-s', toParticipantId: 'alex-r', money: { currency: 'USD', minorAmount: 8050 } },
      { fromParticipantId: 'taylor-s', toParticipantId: 'maya-p', money: { currency: 'USD', minorAmount: 3625 } },
    ])
    await expect(repository.expenses.listComments('lake-house-weekend', 'cabin-deposit')).resolves.toEqual([
      expect.objectContaining({ authorId: 'alex-r', body: 'Booked the refundable rate for us.' }),
      expect.objectContaining({ authorId: 'maya-p', body: 'Perfect, thank you!' }),
    ])
    await expect(repository.groups.getTotals('lake-house-weekend')).resolves.toEqual({
      currency: 'USD',
      totalPaid: 75900,
      currentUserPaid: 22600,
      currentUserShare: 18975,
      currentUserNet: 3625,
    })
    await expect(repository.groups.getCharts('lake-house-weekend')).resolves.toEqual({
      categorySpending: [
        { category: 'Lodging', minorAmount: 40000 },
        { category: 'Food', minorAmount: 24300 },
        { category: 'Transport', minorAmount: 11600 },
      ],
      dailySpending: [
        { date: '2026-08-26', minorAmount: 5600 },
        { date: '2026-08-27', minorAmount: 7300 },
        { date: '2026-08-28', minorAmount: 40000 },
        { date: '2026-08-29', minorAmount: 6000 },
        { date: '2026-08-30', minorAmount: 17000 },
      ],
    })
  })

  it('adds an expense to the in-memory journal and emits an activity item', async () => {
    const repository = createDemoRepository()

    const expense = await repository.expenses.add({
      groupId: 'lake-house-weekend',
      description: 'Firewood',
      date: '2026-08-30',
      total: { currency: 'USD', minorAmount: 2400 },
      payerId: 'maya-p',
      allocations: [
        { participantId: 'maya-p', money: { currency: 'USD', minorAmount: 600 } },
        { participantId: 'jordan-k', money: { currency: 'USD', minorAmount: 600 } },
        { participantId: 'alex-r', money: { currency: 'USD', minorAmount: 600 } },
        { participantId: 'taylor-s', money: { currency: 'USD', minorAmount: 600 } },
      ],
      category: 'Supplies',
    })

    expect(expense).toMatchObject({ id: 'demo-expense-006', syncState: 'fresh' })
    await expect(repository.expenses.listForGroup('lake-house-weekend')).resolves.toHaveLength(6)
    await expect(repository.activity.listForGroup('lake-house-weekend')).resolves.toContainEqual(
      expect.objectContaining({ type: 'expense-created', expenseId: 'demo-expense-006' }),
    )
  })
})
