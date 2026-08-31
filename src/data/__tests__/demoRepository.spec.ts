import { describe, expect, it } from 'vitest'
import { CommandConflictError } from '../commandQueue'
import { createDemoRepository } from '../demoRepository'
import type { ExpenseDraft } from '../repositories'

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
    await expect(repository.comments.listForExpense('lake-house-weekend', 'cabin-deposit')).resolves.toEqual([
      expect.objectContaining({ author: expect.objectContaining({ id: 'alex-r' }), body: 'Booked the refundable rate for us.' }),
      expect.objectContaining({ author: expect.objectContaining({ id: 'maya-p' }), body: 'Perfect, thank you!' }),
    ])
    await expect(repository.groups.getTotals('lake-house-weekend')).resolves.toEqual([{ currency: 'USD', totalPaid: 75900, currentUserPaid: 22600, currentUserShare: 18975, currentUserNet: 3625 }])
    await expect(repository.groups.getCharts('lake-house-weekend')).resolves.toEqual({
      categorySpending: [
        { currency: 'USD', category: 'Lodging', minorAmount: 40000 },
        { currency: 'USD', category: 'Food', minorAmount: 24300 },
        { currency: 'USD', category: 'Transport', minorAmount: 11600 },
      ],
      dailySpending: [
        { currency: 'USD', date: '2026-08-26', minorAmount: 5600 },
        { currency: 'USD', date: '2026-08-27', minorAmount: 7300 },
        { currency: 'USD', date: '2026-08-28', minorAmount: 40000 },
        { currency: 'USD', date: '2026-08-29', minorAmount: 6000 },
        { currency: 'USD', date: '2026-08-30', minorAmount: 17000 },
      ],
    })
  })

  it('adds an expense to the in-memory journal and emits an activity item', async () => {
    const repository = createDemoRepository()

    const result = await repository.expenses.add({
      kind: 'expense.add', operationId: 'add-firewood',
      ...firewoodDraft(),
    })

    expect(result).toMatchObject({ status: 'saved', expense: { id: 'demo-expense-006', syncState: 'fresh' } })
    await expect(repository.expenses.add({
      kind: 'expense.add', operationId: 'add-firewood', ...firewoodDraft(), description: 'Changed duplicate',
    })).rejects.toThrow('different request context')
    await expect(repository.expenses.listForGroup('lake-house-weekend')).resolves.toHaveLength(6)
    await expect(repository.activity.listForGroup('lake-house-weekend')).resolves.toContainEqual(
      expect.objectContaining({ kind: 'expense.created', expenseId: 'demo-expense-006' }),
    )
  })

  it('persists add allocations recomputed from the split method', async () => {
    const repository = createDemoRepository()
    const draft = firewoodDraft()

    const result = await repository.expenses.add({
      kind: 'expense.add', operationId: 'add-canonical-firewood',
      ...draft, allocations: [...draft.allocations].reverse(),
    })

    expect(result).toMatchObject({
      status: 'saved',
      expense: {
        allocations: [
          { participantId: 'maya-p', money: { currency: 'USD', minorAmount: 600 } },
          { participantId: 'jordan-k', money: { currency: 'USD', minorAmount: 600 } },
          { participantId: 'alex-r', money: { currency: 'USD', minorAmount: 600 } },
          { participantId: 'taylor-s', money: { currency: 'USD', minorAmount: 600 } },
        ],
      },
    })
  })

  it('rejects add allocations that contradict the split method', async () => {
    const repository = createDemoRepository()

    await expect(repository.expenses.add({
      kind: 'expense.add', operationId: 'add-contradictory-firewood', ...firewoodDraft(),
      allocations: [
        { participantId: 'maya-p', money: { currency: 'USD', minorAmount: 700 } },
        { participantId: 'jordan-k', money: { currency: 'USD', minorAmount: 500 } },
        { participantId: 'alex-r', money: { currency: 'USD', minorAmount: 600 } },
        { participantId: 'taylor-s', money: { currency: 'USD', minorAmount: 600 } },
      ],
    })).rejects.toThrow('allocations do not match split method')
  })

  it('hydrates an edit, enforces the expected revision, and returns the updated expense', async () => {
    const repository = createDemoRepository()
    const original = await repository.expenses.getById('lake-house-weekend', 'groceries')
    expect(original).toMatchObject({ revision: 1, updatedAt: '2026-08-30T10:00:00.000Z', splitMethod: { type: 'equal' } })

    const result = await repository.expenses.edit({
      kind: 'expense.edit', operationId: 'edit-groceries', groupId: 'lake-house-weekend', expenseId: 'groceries', expectedRevision: 1,
      draft: { ...firewoodDraft(), description: 'Groceries and ice' },
    })

    expect(result).toMatchObject({ status: 'saved', expense: { id: 'groceries', revision: 2, description: 'Groceries and ice' } })
    await expect(repository.expenses.getById('lake-house-weekend', 'groceries')).resolves.toMatchObject({ revision: 2, description: 'Groceries and ice' })
    await expect(repository.expenses.edit({
      kind: 'expense.edit', operationId: 'stale-edit', groupId: 'lake-house-weekend', expenseId: 'groceries', expectedRevision: 1,
      draft: firewoodDraft(),
    })).rejects.toBeInstanceOf(CommandConflictError)
  })

  it('persists edit allocations recomputed from the split method', async () => {
    const repository = createDemoRepository()
    const draft = firewoodDraft()

    const result = await repository.expenses.edit({
      kind: 'expense.edit', operationId: 'edit-canonical-groceries', groupId: 'lake-house-weekend', expenseId: 'groceries', expectedRevision: 1,
      draft: { ...draft, allocations: [...draft.allocations].reverse() },
    })

    expect(result).toMatchObject({
      status: 'saved',
      expense: {
        allocations: [
          { participantId: 'maya-p', money: { currency: 'USD', minorAmount: 600 } },
          { participantId: 'jordan-k', money: { currency: 'USD', minorAmount: 600 } },
          { participantId: 'alex-r', money: { currency: 'USD', minorAmount: 600 } },
          { participantId: 'taylor-s', money: { currency: 'USD', minorAmount: 600 } },
        ],
      },
    })
  })

  it('rejects edit allocations that contradict the split method', async () => {
    const repository = createDemoRepository()

    await expect(repository.expenses.edit({
      kind: 'expense.edit', operationId: 'edit-contradictory-groceries', groupId: 'lake-house-weekend', expenseId: 'groceries', expectedRevision: 1,
      draft: {
        ...firewoodDraft(),
        allocations: [
          { participantId: 'maya-p', money: { currency: 'USD', minorAmount: 700 } },
          { participantId: 'jordan-k', money: { currency: 'USD', minorAmount: 500 } },
          { participantId: 'alex-r', money: { currency: 'USD', minorAmount: 600 } },
          { participantId: 'taylor-s', money: { currency: 'USD', minorAmount: 600 } },
        ],
      },
    })).rejects.toThrow('allocations do not match split method')

    await expect(repository.expenses.getById('lake-house-weekend', 'groceries')).resolves.toMatchObject({ revision: 1, description: 'Groceries' })
  })

  it('clears optional note, recurrence, and occurrence-scope fields when an edit removes them', async () => {
    const repository = createDemoRepository()
    const added = await repository.expenses.add({
      kind: 'expense.add', operationId: 'add-recurring-firewood', ...firewoodDraft(),
      notes: 'Bring a tarp',
      recurrence: { frequency: 'monthly', anchor: { month: 8, day: 30 }, timeZone: 'America/Chicago' },
      occurrenceEditScope: 'future',
    })
    if (added.status !== 'saved') throw new Error('Expected demo add to save')

    const edited = await repository.expenses.edit({
      kind: 'expense.edit', operationId: 'clear-recurring-firewood', groupId: 'lake-house-weekend',
      expenseId: added.expense.id, expectedRevision: 1, draft: firewoodDraft(),
    })

    expect(edited).toMatchObject({ status: 'saved', expense: { revision: 2 } })
    if (edited.status !== 'saved') throw new Error('Expected demo edit to save')
    expect(edited.expense.notes).toBeUndefined()
    expect(edited.expense.recurrence).toBeUndefined()
    expect(edited.expense.occurrenceEditScope).toBeUndefined()
  })

  it('returns a durable tombstone when deleting an expense', async () => {
    const repository = createDemoRepository()
    await expect(repository.expenses.delete({ kind: 'expense.delete', operationId: 'delete-gas', groupId: 'lake-house-weekend', expenseId: 'gas-for-the-boat', expectedRevision: 1 })).resolves.toMatchObject({
      status: 'saved', tombstone: { id: 'gas-for-the-boat', groupId: 'lake-house-weekend', revision: 2, deletedAt: '2026-08-30T12:00:00.000Z' },
    })
    await expect(repository.expenses.getById('lake-house-weekend', 'gas-for-the-boat')).resolves.toMatchObject({
      id: 'gas-for-the-boat', revision: 2, deletedAt: '2026-08-30T12:00:00.000Z',
    })
    await expect(repository.expenses.listForGroup('lake-house-weekend')).resolves.not.toContainEqual(expect.objectContaining({ id: 'gas-for-the-boat' }))
  })

  it('rejects editing a deleted expense while keeping its tombstone audit-visible', async () => {
    const repository = createDemoRepository()
    await repository.expenses.delete({ kind: 'expense.delete', operationId: 'delete-before-edit', groupId: 'lake-house-weekend', expenseId: 'gas-for-the-boat', expectedRevision: 1 })

    await expect(repository.expenses.edit({
      kind: 'expense.edit', operationId: 'edit-deleted-gas', groupId: 'lake-house-weekend', expenseId: 'gas-for-the-boat', expectedRevision: 2,
      draft: { ...firewoodDraft(), description: 'Restored gas' },
    })).rejects.toThrow('Cannot edit deleted demo expense')
    await expect(repository.expenses.getById('lake-house-weekend', 'gas-for-the-boat')).resolves.toMatchObject({
      id: 'gas-for-the-boat', description: 'Gas for the boat', revision: 2, deletedAt: '2026-08-30T12:00:00.000Z',
    })
  })

  it('rejects deleting an already-deleted expense without advancing its tombstone', async () => {
    const repository = createDemoRepository()
    await repository.expenses.delete({ kind: 'expense.delete', operationId: 'delete-once', groupId: 'lake-house-weekend', expenseId: 'gas-for-the-boat', expectedRevision: 1 })

    await expect(repository.expenses.delete({
      kind: 'expense.delete', operationId: 'delete-twice', groupId: 'lake-house-weekend', expenseId: 'gas-for-the-boat', expectedRevision: 2,
    })).rejects.toThrow('Demo expense is already deleted')
    await expect(repository.expenses.getById('lake-house-weekend', 'gas-for-the-boat')).resolves.toMatchObject({
      id: 'gas-for-the-boat', revision: 2, deletedAt: '2026-08-30T12:00:00.000Z',
    })
  })

  it('reports a stale delete as a conflict with the local intent and remote expense', async () => {
    const repository = createDemoRepository()
    const command = {
      kind: 'expense.delete', operationId: 'stale-delete-gas', groupId: 'lake-house-weekend', expenseId: 'gas-for-the-boat', expectedRevision: 0,
    } as const

    await expect(repository.expenses.delete(command)).rejects.toMatchObject({
      name: 'CommandConflictError',
      conflict: {
        local: command,
        remote: { id: 'gas-for-the-boat', groupId: 'lake-house-weekend', revision: 1, description: 'Gas for the boat' },
      },
    })
    const retained = await repository.expenses.getById('lake-house-weekend', 'gas-for-the-boat')
    expect(retained).toMatchObject({ revision: 1 })
    expect(retained?.deletedAt).toBeUndefined()
  })

  it('keeps totals and chart values partitioned when an expense uses another currency', async () => {
    const repository = createDemoRepository()
    await repository.expenses.add({
      kind: 'expense.add', operationId: 'add-eur-expense', groupId: 'lake-house-weekend', description: 'Euro ferry', date: '2026-08-30',
      total: { currency: 'EUR', minorAmount: 800 }, payments: [{ participantId: 'maya-p', money: { currency: 'EUR', minorAmount: 800 } }], category: 'Transport',
      allocations: [
        { participantId: 'maya-p', money: { currency: 'EUR', minorAmount: 200 } },
        { participantId: 'jordan-k', money: { currency: 'EUR', minorAmount: 200 } },
        { participantId: 'alex-r', money: { currency: 'EUR', minorAmount: 200 } },
        { participantId: 'taylor-s', money: { currency: 'EUR', minorAmount: 200 } },
      ],
      splitMethod: { type: 'equal', participantIds: ['maya-p', 'jordan-k', 'alex-r', 'taylor-s'] }, attachmentRefs: [],
    })

    await expect(repository.groups.getTotals('lake-house-weekend')).resolves.toEqual([
      { currency: 'EUR', totalPaid: 800, currentUserPaid: 800, currentUserShare: 200, currentUserNet: 600 },
      { currency: 'USD', totalPaid: 75900, currentUserPaid: 22600, currentUserShare: 18975, currentUserNet: 3625 },
    ])
    await expect(repository.groups.getCharts('lake-house-weekend')).resolves.toMatchObject({
      dailySpending: expect.arrayContaining([{ currency: 'EUR', date: '2026-08-30', minorAmount: 800 }]),
    })
  })
})

function firewoodDraft(): ExpenseDraft {
  const participantIds = ['maya-p', 'jordan-k', 'alex-r', 'taylor-s'] as const
  return {
    groupId: 'lake-house-weekend', description: 'Firewood', date: '2026-08-30', total: { currency: 'USD', minorAmount: 2400 },
    payments: [{ participantId: 'maya-p', money: { currency: 'USD', minorAmount: 2400 } }],
    allocations: participantIds.map((participantId) => ({ participantId, money: { currency: 'USD' as const, minorAmount: 600 } })),
    category: 'Supplies', splitMethod: { type: 'equal', participantIds }, attachmentRefs: [],
  }
}
