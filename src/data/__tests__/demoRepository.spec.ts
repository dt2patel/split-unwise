import { describe, expect, it } from 'vitest'
import { CommandConflictError } from '../commandQueue'
import { createDemoRepository } from '../demoRepository'
import type { ExpenseDraft } from '../repositories'
import { lakeHouseGroup } from '../../demo/lakeHouse'

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
      coverImageUrl: lakeHouseGroup.coverImageUrl,
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
    await expect(repository.groups.getBalanceSnapshot('lake-house-weekend')).resolves.toMatchObject({
      balanceRevision: 5,
      simplified: [
        { fromParticipantId: 'jordan-k', toParticipantId: 'alex-r', money: { currency: 'USD', minorAmount: 12975 } },
        { fromParticipantId: 'taylor-s', toParticipantId: 'alex-r', money: { currency: 'USD', minorAmount: 8050 } },
        { fromParticipantId: 'taylor-s', toParticipantId: 'maya-p', money: { currency: 'USD', minorAmount: 3625 } },
      ],
    })
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

  it('creates, catches up, and cancels a recurring series without duplicating ledger effects', async () => {
    const repository = createDemoRepository()
    const draft = firewoodDraft()
    const recurrence = { frequency: 'monthly' as const, anchor: { month: 8, day: 30 }, timeZone: 'America/Chicago' }
    const added = await repository.expenses.add({ kind: 'expense.add', operationId: 'add-recurring-firewood-series', ...draft, recurrence })
    if (added.status !== 'saved') throw new Error('Expected recurring demo expense to save')

    expect(added.expense.recurringTemplateId).toMatch(/^recurring-[a-f0-9]{48}$/)
    await expect(repository.groups.listRecurring('lake-house-weekend')).resolves.toContainEqual(expect.objectContaining({
      id: added.expense.recurringTemplateId, status: 'active', anchorDate: '2026-08-30', nextDate: '2026-09-30', revision: 1,
    }))

    const caughtUp = await repository.groups.materializeDue('lake-house-weekend', '2026-10-30')
    expect({ ...caughtUp, occurrences: caughtUp.occurrences.filter(({ recurringTemplateId }) => recurringTemplateId === added.expense.recurringTemplateId) }).toMatchObject({
      occurrences: [
        { id: `occ_${added.expense.recurringTemplateId}_2026-09-30`, date: '2026-09-30', recurringTemplateId: added.expense.recurringTemplateId },
        { id: `occ_${added.expense.recurringTemplateId}_2026-10-30`, date: '2026-10-30', recurringTemplateId: added.expense.recurringTemplateId },
      ],
      moreRemain: false,
    })
    expect((await repository.expenses.listForGroup('lake-house-weekend')).filter(({ recurringTemplateId }) => recurringTemplateId === added.expense.recurringTemplateId)).toHaveLength(3)
    expect((await repository.activity.listForGroup('lake-house-weekend')).filter(({ expenseId }) => expenseId?.startsWith(`occ_${added.expense.recurringTemplateId}_`))).toHaveLength(2)
    const advanced = (await repository.groups.listRecurring('lake-house-weekend')).find(({ id }) => id === added.expense.recurringTemplateId)!
    expect(advanced).toMatchObject({ nextDate: '2026-11-30', revision: 3, lastOccurrenceDate: '2026-10-30' })

    const cancellation = await repository.commands.execute({
      kind: 'recurrence.cancel', operationId: 'cancel-recurring-firewood-series', groupId: 'lake-house-weekend',
      templateId: advanced.id, expectedRevision: advanced.revision,
    })
    expect(cancellation).toMatchObject({ status: 'saved', template: { id: advanced.id, status: 'cancelled', revision: 4 } })
    const afterCancellation = await repository.groups.materializeDue('lake-house-weekend', '2027-12-31')
    expect(afterCancellation.occurrences.filter(({ recurringTemplateId }) => recurringTemplateId === advanced.id)).toEqual([])
  })

  it('caps recurrence catch-up and reports remaining due work', async () => {
    const repository = createDemoRepository()

    const result = await repository.groups.materializeDue('lake-house-weekend', '2026-11-28', 1)

    expect(result).toMatchObject({ occurrences: [{ id: 'occ_cabin-deposit-monthly_2026-09-28' }], moreRemain: true })
    await expect(repository.groups.materializeDue('lake-house-weekend', '2026-11-28', 25)).rejects.toThrow(/24/)
  })

  it('updates an active template only for a latest future-series edit', async () => {
    const repository = createDemoRepository()
    const materialized = await repository.groups.materializeDue('lake-house-weekend', '2026-09-28')
    const latest = materialized.occurrences[0]!
    const changed = {
      ...firewoodDraft(),
      date: '2026-09-28', description: 'Future cabin payment', category: 'Lodging',
      recurrence: { frequency: 'fortnightly' as const, anchor: { month: 9, day: 28 }, timeZone: 'America/Chicago' },
      occurrenceEditScope: 'future' as const,
    }

    const edited = await repository.expenses.edit({
      kind: 'expense.edit', operationId: 'edit-future-cabin-series', groupId: 'lake-house-weekend', expenseId: latest.id,
      expectedRevision: latest.revision, draft: changed,
    })

    expect(edited).toMatchObject({ status: 'saved', expense: { description: 'Future cabin payment', occurrenceEditScope: 'future' } })
    await expect(repository.groups.listRecurring('lake-house-weekend')).resolves.toContainEqual(expect.objectContaining({
      id: 'cabin-deposit-monthly', description: 'Future cabin payment', recurrence: changed.recurrence, nextDate: '2026-10-12', revision: 3,
    }))
    await expect(repository.expenses.edit({
      kind: 'expense.edit', operationId: 'stale-source-future-edit', groupId: 'lake-house-weekend', expenseId: 'cabin-deposit',
      expectedRevision: 1, draft: changed,
    })).rejects.toThrow(/latest/i)
  })

  it('keeps the recurring template unchanged for an occurrence-only edit', async () => {
    const repository = createDemoRepository()
    const materialized = await repository.groups.materializeDue('lake-house-weekend', '2026-09-28')
    const occurrence = materialized.occurrences[0]!
    const before = await repository.groups.listRecurring('lake-house-weekend')

    await repository.expenses.edit({
      kind: 'expense.edit', operationId: 'edit-only-september-cabin', groupId: 'lake-house-weekend', expenseId: occurrence.id,
      expectedRevision: 1, draft: { ...firewoodDraft(), date: occurrence.date, occurrenceEditScope: 'occurrence' },
    })

    await expect(repository.groups.listRecurring('lake-house-weekend')).resolves.toEqual(before)
  })

  it('semantically replays an occurrence after an occurrence-only date edit', async () => {
    const repository = createDemoRepository()
    const materialize = {
      kind: 'recurrence.materialize' as const, operationId: 'materialize-cabin-before-date-edit', groupId: 'lake-house-weekend',
      templateId: 'cabin-deposit-monthly', occurrenceDate: '2026-09-28',
    }
    const first = await repository.commands.execute(materialize)
    if (first.kind !== 'recurrence.materialize' || first.status !== 'saved') throw new Error('Expected materialized occurrence')
    await repository.expenses.edit({
      kind: 'expense.edit', operationId: 'move-cabin-occurrence-date', groupId: 'lake-house-weekend', expenseId: first.occurrence.id, expectedRevision: 1,
      draft: { ...firewoodDraft(), date: '2026-09-29', occurrenceEditScope: 'occurrence' },
    })

    await expect(repository.commands.execute({ ...materialize, operationId: 'semantic-replay-after-date-edit' })).resolves.toMatchObject({
      status: 'saved', occurrence: { id: 'occ_cabin-deposit-monthly_2026-09-28', date: '2026-09-29', revision: 2 },
      template: { nextDate: '2026-10-28', revision: 2 },
    })
    expect((await repository.expenses.listForGroup('lake-house-weekend')).filter(({ id }) => id === first.occurrence.id)).toHaveLength(1)
    expect((await repository.activity.listForGroup('lake-house-weekend')).filter(({ kind, expenseId }) => kind === 'expense.created' && expenseId === first.occurrence.id)).toHaveLength(1)
  })

  it('keeps the source expense eligible for a future edit before any occurrence exists', async () => {
    const repository = createDemoRepository()
    const source = await repository.expenses.add({
      kind: 'expense.add', operationId: 'add-source-frontier-series', ...firewoodDraft(),
      recurrence: { frequency: 'monthly', anchor: { month: 8, day: 30 }, timeZone: 'America/Chicago' },
    })
    if (source.status !== 'saved' || !source.expense.recurringTemplateId) throw new Error('Expected recurring source expense')

    const occurrenceOnly = await repository.expenses.edit({
      kind: 'expense.edit', operationId: 'edit-source-occurrence-only', groupId: 'lake-house-weekend', expenseId: source.expense.id, expectedRevision: 1,
      draft: { ...firewoodDraft(), date: '2026-08-31', occurrenceEditScope: 'occurrence' },
    })
    if (occurrenceOnly.status !== 'saved') throw new Error('Expected source occurrence edit')
    await expect(repository.expenses.edit({
      kind: 'expense.edit', operationId: 'edit-source-future-after-occurrence', groupId: 'lake-house-weekend', expenseId: source.expense.id, expectedRevision: 2,
      draft: {
        ...firewoodDraft(), date: '2026-08-31', occurrenceEditScope: 'future',
        recurrence: { frequency: 'weekly', anchor: { month: 8, day: 31 }, timeZone: 'America/Chicago' },
      },
    })).resolves.toMatchObject({ status: 'saved', expense: { revision: 3 } })
    await expect(repository.groups.listRecurring('lake-house-weekend')).resolves.toContainEqual(expect.objectContaining({
      id: source.expense.recurringTemplateId, nextDate: '2026-09-07', revision: 2,
    }))
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

  it('clears optional note and recurrence fields on an occurrence-only edit', async () => {
    const repository = createDemoRepository()
    const added = await repository.expenses.add({
      kind: 'expense.add', operationId: 'add-recurring-firewood', ...firewoodDraft(),
      notes: 'Bring a tarp',
      recurrence: { frequency: 'monthly', anchor: { month: 8, day: 30 }, timeZone: 'America/Chicago' },
    })
    if (added.status !== 'saved') throw new Error('Expected demo add to save')

    const edited = await repository.expenses.edit({
      kind: 'expense.edit', operationId: 'clear-recurring-firewood', groupId: 'lake-house-weekend',
      expenseId: added.expense.id, expectedRevision: 1, draft: { ...firewoodDraft(), occurrenceEditScope: 'occurrence' },
    })

    expect(edited).toMatchObject({ status: 'saved', expense: { revision: 2 } })
    if (edited.status !== 'saved') throw new Error('Expected demo edit to save')
    expect(edited.expense.notes).toBeUndefined()
    expect(edited.expense.recurrence).toBeUndefined()
    expect(edited.expense.occurrenceEditScope).toBe('occurrence')
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
