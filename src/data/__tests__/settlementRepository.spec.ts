import { describe, expect, it } from 'vitest'
import { CommandConflictError } from '../commandQueue'
import { createDemoRepository } from '../demoRepository'

const groupId = 'lake-house-weekend'

describe('demo settlement repository', () => {
  it('returns a versioned Lake House pairwise and simplified balance snapshot', async () => {
    const repository = createDemoRepository()

    await expect(repository.groups.getBalanceSnapshot(groupId)).resolves.toEqual({
      groupId,
      balanceRevision: 5,
      simplifyDebtsEnabled: true,
      pairwise: [
        debt('jordan-k', 'alex-r', 'USD', 8500),
        debt('maya-p', 'alex-r', 'USD', 4350),
        debt('taylor-s', 'alex-r', 'USD', 8175),
        debt('jordan-k', 'maya-p', 'USD', 4150),
        debt('jordan-k', 'taylor-s', 'USD', 325),
        debt('taylor-s', 'maya-p', 'USD', 3825),
      ],
      simplified: [
        debt('jordan-k', 'alex-r', 'USD', 12975),
        debt('taylor-s', 'alex-r', 'USD', 8050),
        debt('taylor-s', 'maya-p', 'USD', 3625),
      ],
    })
  })

  it('records a partial simplified-basis payment once and emits atomic activity', async () => {
    const repository = createDemoRepository()
    const before = await repository.groups.getBalanceSnapshot(groupId)
    const command = recordCommand('record-partial', before.balanceRevision, 1000)

    const first = await repository.settlements.record(command)
    const replay = await repository.settlements.record(command)

    expect(first).toEqual(replay)
    expect(first).toMatchObject({
      kind: 'settlement.record', operationId: 'record-partial', status: 'saved',
      settlement: {
        settlementId: 'settlement-record-partial', groupId, senderId: 'taylor-s', recipientId: 'maya-p',
        money: { currency: 'USD', minorAmount: 1000 }, method: 'cash', occurredOn: '2026-08-31',
        note: 'Paid at the dock', revision: 1, syncState: 'fresh', createdBy: { id: 'maya-p', displayName: 'Maya P.' },
      },
      balanceSnapshot: { balanceRevision: before.balanceRevision + 1 },
      activity: { kind: 'settlement.created', settlementId: 'settlement-record-partial' },
    })
    const after = await repository.groups.getBalanceSnapshot(groupId)
    expect(after.balanceRevision).toBe(before.balanceRevision + 1)
    expect(after.simplified).toContainEqual(debt('taylor-s', 'maya-p', 'USD', 2625))
    await expect(repository.settlements.listForGroup(groupId)).resolves.toHaveLength(1)
    await expect(repository.activity.listForGroup(groupId)).resolves.toContainEqual(
      expect.objectContaining({ kind: 'settlement.created', operationId: 'record-partial' }),
    )
  })

  it('supports a full payment without creating a reverse selected debt', async () => {
    const repository = createDemoRepository()
    const before = await repository.groups.getBalanceSnapshot(groupId)

    const result = await repository.settlements.record(recordCommand('record-full', before.balanceRevision, 3625))

    expect(result).toMatchObject({ status: 'saved', balanceSnapshot: { balanceRevision: before.balanceRevision + 1 } })
    const after = await repository.groups.getBalanceSnapshot(groupId)
    expect(after.simplified).not.toContainEqual(expect.objectContaining({ fromParticipantId: 'taylor-s', toParticipantId: 'maya-p', money: expect.objectContaining({ currency: 'USD' }) }))
    expect(after.simplified).not.toContainEqual(expect.objectContaining({ fromParticipantId: 'maya-p', toParticipantId: 'taylor-s', money: expect.objectContaining({ currency: 'USD' }) }))
  })

  it('reduces the exact directed edge selected from the pairwise basis', async () => {
    const repository = createDemoRepository()
    const before = await repository.groups.getBalanceSnapshot(groupId)

    await repository.settlements.record({
      ...recordCommand('record-pairwise', before.balanceRevision, 1000),
      basis: { kind: 'pairwise', senderId: 'maya-p', recipientId: 'alex-r', currency: 'USD', debtMinor: 4350 },
    })

    const after = await repository.groups.getBalanceSnapshot(groupId)
    expect(after.pairwise).toContainEqual(debt('maya-p', 'alex-r', 'USD', 3350))
    expect(after.pairwise).not.toContainEqual(expect.objectContaining({ fromParticipantId: 'alex-r', toParticipantId: 'maya-p', money: expect.objectContaining({ currency: 'USD' }) }))
  })

  it('rejects an overpayment or stale/mismatched basis with zero ledger side effects', async () => {
    const repository = createDemoRepository()
    const before = await repository.groups.getBalanceSnapshot(groupId)
    const activityBefore = await repository.activity.listForGroup(groupId)

    await expect(repository.settlements.record(recordCommand('record-overpay', before.balanceRevision, 3626)))
      .rejects.toThrow('cannot exceed the selected debt')
    await expect(repository.settlements.record(recordCommand('record-stale', before.balanceRevision - 1, 500)))
      .rejects.toBeInstanceOf(CommandConflictError)
    await expect(repository.settlements.record({
      ...recordCommand('record-basis-mismatch', before.balanceRevision, 500),
      basis: { kind: 'simplified', senderId: 'taylor-s', recipientId: 'maya-p', currency: 'USD', debtMinor: 9999 },
    })).rejects.toBeInstanceOf(CommandConflictError)

    await expect(repository.groups.getBalanceSnapshot(groupId)).resolves.toEqual(before)
    await expect(repository.settlements.listForGroup(groupId)).resolves.toEqual([])
    await expect(repository.activity.listForGroup(groupId)).resolves.toEqual(activityBefore)
  })

  it('requires the current user to be sender or recipient and validates manual record fields', async () => {
    const repository = createDemoRepository()
    const before = await repository.groups.getBalanceSnapshot(groupId)

    await expect(repository.settlements.record({
      ...recordCommand('record-third-party', before.balanceRevision, 500),
      basis: { kind: 'simplified', senderId: 'jordan-k', recipientId: 'alex-r', currency: 'USD', debtMinor: 12975 },
    })).rejects.toThrow('sender or recipient')
    await expect(repository.settlements.record({ ...recordCommand('record-unconfirmed', before.balanceRevision, 500), outsidePaymentConfirmed: false }))
      .rejects.toThrow('Confirm that the outside payment already occurred')
    await expect(repository.settlements.record({ ...recordCommand('record-invalid-date', before.balanceRevision, 500), occurredOn: '08/31/2026' }))
      .rejects.toThrow('Occurrence date')
    await expect(repository.settlements.record({ ...recordCommand('record-long-note', before.balanceRevision, 500), note: 'x'.repeat(501) }))
      .rejects.toThrow('500 Unicode code points')
  })

  it('voids by exact settlement and balance revision, restores the plan, and retains the audit record', async () => {
    const repository = createDemoRepository()
    const before = await repository.groups.getBalanceSnapshot(groupId)
    const recorded = await repository.settlements.record(recordCommand('record-for-void', before.balanceRevision, 1000))
    if (recorded.status !== 'saved') throw new Error('Expected demo settlement to save')

    await expect(repository.settlements.void({
      kind: 'settlement.void', operationId: 'void-stale', groupId, settlementId: recorded.settlement.settlementId,
      expectedRevision: 1, expectedBalanceRevision: before.balanceRevision, reason: 'Stale request',
    })).rejects.toBeInstanceOf(CommandConflictError)
    await expect(repository.settlements.getById(groupId, recorded.settlement.settlementId)).resolves.not.toHaveProperty('void')

    const result = await repository.settlements.void({
      kind: 'settlement.void', operationId: 'void-payment', groupId, settlementId: recorded.settlement.settlementId,
      expectedRevision: 1, expectedBalanceRevision: recorded.balanceSnapshot.balanceRevision,
      reason: '  Entered twice by mistake.  ',
    })

    expect(result).toMatchObject({
      kind: 'settlement.void', operationId: 'void-payment', status: 'saved',
      settlement: {
        settlementId: 'settlement-record-for-void', revision: 2,
        void: { operationId: 'void-payment', reason: 'Entered twice by mistake.', actor: { id: 'maya-p' } },
      },
      balanceSnapshot: { balanceRevision: before.balanceRevision + 2 },
      activity: { kind: 'settlement.voided', settlementId: 'settlement-record-for-void' },
    })
    const restored = await repository.groups.getBalanceSnapshot(groupId)
    expect(restored.pairwise).toEqual(before.pairwise)
    expect(restored.simplified).toEqual(before.simplified)
    await expect(repository.settlements.getById(groupId, 'settlement-record-for-void')).resolves.toMatchObject({ revision: 2, void: { reason: 'Entered twice by mistake.' } })
  })

  it('allows creator or manager voids, rejects other members, and keeps denied attempts atomic', async () => {
    let savedState: unknown
    const authorRepository = createDemoRepository({
      currentUserId: 'taylor-s',
      stateStorage: { load: () => undefined, save: (_scope, document) => { savedState = structuredClone(document) } },
    })
    const before = await authorRepository.groups.getBalanceSnapshot(groupId)
    const recorded = await authorRepository.settlements.record(recordCommand('permission-record', before.balanceRevision, 500))
    if (recorded.status !== 'saved' || !savedState) throw new Error('Expected persisted author settlement')

    const memberRepository = repositoryReboundTo(savedState, 'jordan-k', 'Jordan K.', false)
    const memberActivity = await memberRepository.activity.listForGroup(groupId)
    await expect(memberRepository.settlements.void({
      kind: 'settlement.void', operationId: 'denied-void', groupId, settlementId: recorded.settlement.settlementId,
      expectedRevision: 1, expectedBalanceRevision: recorded.balanceSnapshot.balanceRevision, reason: 'Not mine',
    })).rejects.toThrow('creator or an active group manager')
    await expect(memberRepository.groups.getBalanceSnapshot(groupId)).resolves.toEqual(recorded.balanceSnapshot)
    await expect(memberRepository.activity.listForGroup(groupId)).resolves.toEqual(memberActivity)

    const managerRepository = repositoryReboundTo(savedState, 'maya-p', 'Maya P.', true)
    await expect(managerRepository.settlements.void({
      kind: 'settlement.void', operationId: 'blank-void', groupId, settlementId: recorded.settlement.settlementId,
      expectedRevision: 1, expectedBalanceRevision: recorded.balanceSnapshot.balanceRevision, reason: '   ',
    })).rejects.toThrow('Void reason is required')
    await expect(managerRepository.settlements.void({
      kind: 'settlement.void', operationId: 'manager-void', groupId, settlementId: recorded.settlement.settlementId,
      expectedRevision: 1, expectedBalanceRevision: recorded.balanceSnapshot.balanceRevision, reason: 'Manager correction',
    })).resolves.toMatchObject({ status: 'saved', settlement: { createdBy: { id: 'taylor-s' }, void: { actor: { id: 'maya-p' } } } })
  })

  it('advances the balance revision exactly once for expense add, edit, delete, and replay', async () => {
    const repository = createDemoRepository()
    const initial = await repository.groups.getBalanceSnapshot(groupId)
    const add = {
      kind: 'expense.add' as const, operationId: 'revision-add', groupId, description: 'Revision marker', date: '2026-08-31',
      total: { currency: 'USD' as const, minorAmount: 100 }, payments: [{ participantId: 'maya-p', money: { currency: 'USD' as const, minorAmount: 100 } }],
      allocations: [{ participantId: 'maya-p', money: { currency: 'USD' as const, minorAmount: 100 } }], category: 'Other',
      splitMethod: { type: 'equal' as const, participantIds: ['maya-p'] }, attachmentRefs: [],
    }
    const added = await repository.expenses.add(add)
    if (added.status !== 'saved') throw new Error('Expected expense add')
    expect((await repository.groups.getBalanceSnapshot(groupId)).balanceRevision).toBe(initial.balanceRevision + 1)
    await repository.expenses.add(add)
    expect((await repository.groups.getBalanceSnapshot(groupId)).balanceRevision).toBe(initial.balanceRevision + 1)

    const edit = {
      kind: 'expense.edit' as const, operationId: 'revision-edit', groupId, expenseId: added.expense.id, expectedRevision: added.expense.revision,
      draft: {
        groupId, description: 'Edited revision marker', date: add.date, total: add.total, payments: add.payments,
        allocations: add.allocations, category: add.category, splitMethod: add.splitMethod, attachmentRefs: add.attachmentRefs,
      },
    }
    const edited = await repository.expenses.edit(edit)
    if (edited.status !== 'saved') throw new Error('Expected expense edit')
    expect((await repository.groups.getBalanceSnapshot(groupId)).balanceRevision).toBe(initial.balanceRevision + 2)
    await repository.expenses.edit(edit)
    expect((await repository.groups.getBalanceSnapshot(groupId)).balanceRevision).toBe(initial.balanceRevision + 2)

    const remove = { kind: 'expense.delete' as const, operationId: 'revision-delete', groupId, expenseId: edited.expense.id, expectedRevision: edited.expense.revision }
    await repository.expenses.delete(remove)
    expect((await repository.groups.getBalanceSnapshot(groupId)).balanceRevision).toBe(initial.balanceRevision + 3)
    await repository.expenses.delete(remove)
    expect((await repository.groups.getBalanceSnapshot(groupId)).balanceRevision).toBe(initial.balanceRevision + 3)
  })

  it('keeps settlement validation and plans isolated by currency', async () => {
    const repository = createDemoRepository()
    const before = await repository.groups.getBalanceSnapshot(groupId)
    await repository.expenses.add({
      kind: 'expense.add', operationId: 'add-eur-ferry', groupId, description: 'Euro ferry', date: '2026-08-31',
      total: { currency: 'EUR', minorAmount: 800 }, payments: [{ participantId: 'maya-p', money: { currency: 'EUR', minorAmount: 800 } }],
      allocations: [
        { participantId: 'maya-p', money: { currency: 'EUR', minorAmount: 400 } },
        { participantId: 'taylor-s', money: { currency: 'EUR', minorAmount: 400 } },
      ],
      category: 'Transport', splitMethod: { type: 'equal', participantIds: ['maya-p', 'taylor-s'] }, attachmentRefs: [],
    })
    const withEuro = await repository.groups.getBalanceSnapshot(groupId)
    expect(withEuro.balanceRevision).toBe(before.balanceRevision + 1)
    expect(withEuro.simplified).toContainEqual(debt('taylor-s', 'maya-p', 'EUR', 400))

    await expect(repository.settlements.record({
      ...recordCommand('wrong-currency', withEuro.balanceRevision, 100),
      money: { currency: 'EUR', minorAmount: 100 },
    })).rejects.toBeInstanceOf(CommandConflictError)

    const result = await repository.settlements.record({
      ...recordCommand('settle-euro', withEuro.balanceRevision, 100),
      basis: { kind: 'simplified', senderId: 'taylor-s', recipientId: 'maya-p', currency: 'EUR', debtMinor: 400 },
      money: { currency: 'EUR', minorAmount: 100 },
    })
    expect(result).toMatchObject({ status: 'saved' })
    const after = await repository.groups.getBalanceSnapshot(groupId)
    expect(after.simplified).toContainEqual(debt('taylor-s', 'maya-p', 'EUR', 300))
    expect(after.simplified.filter(({ money }) => money.currency === 'USD')).toEqual(before.simplified)
  })
})

function recordCommand(operationId: string, expectedBalanceRevision: number, amountMinor: number) {
  return {
    kind: 'settlement.record' as const,
    operationId,
    groupId,
    expectedBalanceRevision,
    basis: { kind: 'simplified' as const, senderId: 'taylor-s', recipientId: 'maya-p', currency: 'USD' as const, debtMinor: 3625 },
    money: { currency: 'USD' as const, minorAmount: amountMinor },
    method: 'cash' as const,
    occurredOn: '2026-08-31',
    note: '  Paid at the dock  ',
    outsidePaymentConfirmed: true,
  }
}

function debt(fromParticipantId: string, toParticipantId: string, currency: 'EUR' | 'USD', minorAmount: number) {
  return { fromParticipantId, toParticipantId, money: { currency, minorAmount } }
}

function repositoryReboundTo(state: unknown, id: string, displayName: string, canManage: boolean) {
  return createDemoRepository({
    currentUserId: id,
    stateStorage: {
      load: () => {
        const rebound = structuredClone(state) as Record<string, unknown>
        rebound.principalId = id
        rebound.currentUser = { id, displayName, initials: displayName.split(/\s+/).map((part) => part[0]).join(''), isCurrentUser: true, canManage }
        rebound.operationLedger = []
        return rebound
      },
      save: () => undefined,
    },
  })
}
