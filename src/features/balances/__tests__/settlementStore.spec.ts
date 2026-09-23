import { createPinia, setActivePinia } from 'pinia'
import { flushPromises } from '@vue/test-utils'
import { beforeEach, describe, expect, it } from 'vitest'
import { createMemoryCommandStorage } from '../../../data/commandQueue'
import { createDemoRepository } from '../../../data/demoRepository'
import { appPrincipalKey, createAppSession, setAppSessionForTesting } from '../../../data/session'
import type { AppRepository, Group, GroupBalanceSnapshot, Member, SettlementRecordCommand } from '../../../data/repositories'
import { useSettlementStore } from '../settlementStore'

const groupId = 'lake-house-weekend'
const principal = { mode: 'demo' as const, projectId: 'split-unwise-demo', uid: 'maya-p' }
const principalKey = appPrincipalKey(principal)

beforeEach(() => {
  setActivePinia(createPinia())
  setAppSessionForTesting(createAppSession({ repository: createDemoRepository(), principal, commandStorage: createMemoryCommandStorage() }))
})

describe('settlement store authority and races', () => {
  it('clears prior state and suppresses a late route completion after a newer group wins', async () => {
    const a = deferred<LoadBundle>()
    const b = deferred<LoadBundle>()
    const repository = repositoryFor({ a: a.promise, b: b.promise })
    setAppSessionForTesting(createAppSession({ repository, principal, commandStorage: createMemoryCommandStorage() }))
    const store = useSettlementStore()

    const loadingA = store.loadGroup('a')
    const loadingB = store.loadGroup('b')
    b.resolve(bundle('b', 'Group B'))
    await loadingB
    expect(store.group?.id).toBe('b')

    a.resolve(bundle('a', 'Group A'))
    await loadingA
    expect(store.group?.id).toBe('b')
    expect(store.error).toBeUndefined()
  })

  it('rehydrates pending records separately without reducing authoritative debt', async () => {
    const repository = createDemoRepository()
    const snapshot = await repository.groups.getBalanceSnapshot(groupId)
    const command = recordCommand('pending-record', snapshot.balanceRevision, 500)
    const storage = createMemoryCommandStorage({
      [principalKey]: {
        version: 6,
        principalKey,
        operations: [{ originPrincipalKey: principalKey, submittedAt: '2026-08-31T20:00:00.000Z', status: 'pending', envelope: command }],
      },
    })
    // Keep the operation pending by making its resumed handler never settle.
    const pendingRepository: AppRepository = {
      ...repository,
      commands: { execute: () => new Promise(() => undefined) },
    }
    setAppSessionForTesting(createAppSession({ repository: pendingRepository, principal, commandStorage: storage }))
    const store = useSettlementStore()

    await store.loadGroup(groupId)

    expect(store.pendingSettlements).toHaveLength(1)
    expect(store.pendingSettlements[0]).toMatchObject({ operationId: 'pending-record', status: 'pending', amountMinor: 500 })
    expect(store.balanceSnapshot?.simplified).toContainEqual(expect.objectContaining({
      fromParticipantId: 'taylor-s', toParticipantId: 'maya-p', money: { currency: 'USD', minorAmount: 3625 },
    }))
  })

  it('refreshes authoritative snapshot and settlements only after a saved queue result', async () => {
    const store = useSettlementStore()
    await store.loadGroup(groupId)
    const revision = store.balanceSnapshot?.balanceRevision
    if (revision === undefined) throw new Error('Expected balance revision')

    const saved = await store.recordPayment(recordCommand('store-record', revision, 500))

    expect(saved).toBe(true)
    expect(store.balanceSnapshot?.balanceRevision).toBe(revision + 1)
    expect(store.settlements).toContainEqual(expect.objectContaining({ settlementId: 'settlement-store-record' }))
    expect(store.pendingSettlements).toEqual([])
  })

  it('retains a saved operation until authoritative reads reach its balance revision', async () => {
    const base = createDemoRepository()
    const staleSnapshot = await base.groups.getBalanceSnapshot(groupId)
    const repository: AppRepository = {
      ...base,
      groups: {
        ...base.groups,
        getBalanceSnapshot: async (id) => {
          if (id !== groupId) return base.groups.getBalanceSnapshot(id)
          return structuredClone(staleSnapshot)
        },
      },
    }
    const session = createAppSession({ repository, principal, commandStorage: createMemoryCommandStorage() })
    setAppSessionForTesting(session)
    const store = useSettlementStore()
    await store.loadGroup(groupId)

    const saved = await store.recordPayment(recordCommand('store-stale-read', staleSnapshot.balanceRevision, 500))

    expect(saved).toBe(false)
    expect(store.balanceSnapshot?.balanceRevision).toBe(staleSnapshot.balanceRevision)
    expect(store.settlements).toEqual([])
    expect(session.queue.get('store-stale-read')).toMatchObject({ status: 'fresh' })
    expect(store.pendingSettlements).toContainEqual(expect.objectContaining({ operationId: 'store-stale-read', status: 'fresh' }))
  })

  it('retains stale-revision conflicts and disables writes when exact revisions are unknown', async () => {
    const repository = createDemoRepository()
    setAppSessionForTesting(createAppSession({ repository, principal, commandStorage: createMemoryCommandStorage() }))
    const store = useSettlementStore()
    await store.loadGroup(groupId)
    const revision = store.balanceSnapshot?.balanceRevision
    if (revision === undefined) throw new Error('Expected balance revision')
    await repository.expenses.add({
      kind: 'expense.add', operationId: 'concurrent-expense', groupId, description: 'Concurrent expense', date: '2026-08-31',
      total: { currency: 'USD', minorAmount: 400 }, payments: [{ participantId: 'maya-p', money: { currency: 'USD', minorAmount: 400 } }],
      allocations: [{ participantId: 'maya-p', money: { currency: 'USD', minorAmount: 400 } }], category: 'Other',
      splitMethod: { type: 'equal', participantIds: ['maya-p'] }, attachmentRefs: [],
    })

    const saved = await store.recordPayment(recordCommand('store-conflict', revision, 500))

    expect(saved).toBe(false)
    expect(store.pendingSettlements).toContainEqual(expect.objectContaining({ operationId: 'store-conflict', status: 'conflicted' }))
    expect(store.balanceSnapshot?.balanceRevision).toBe(revision)

    store.clear()
    expect(store.canRecord).toBe(false)
  })

  it('keeps a deleted member label but refuses a new payment involving that identity', async () => {
    const current = { id: 'maya-p', displayName: 'Maya P.', initials: 'MP', isCurrentUser: true }
    const deleted = { id: 'former-member', displayName: 'Deleted user', initials: 'DU', isCurrentUser: false, accountStatus: 'deleted' as const }
    const load: LoadBundle = {
      group: { id: 'deleted-ledger', kind: 'group', name: 'Deleted ledger', currency: 'USD', memberIds: [current.id], syncState: 'fresh' },
      user: current,
      members: [current, deleted],
      snapshot: {
        groupId: 'deleted-ledger', balanceRevision: 1, simplifyDebtsEnabled: true, pairwise: [],
        simplified: [{ fromParticipantId: deleted.id, toParticipantId: current.id, money: { currency: 'USD', minorAmount: 500 } }],
      },
    }
    const repository = repositoryFor({ 'deleted-ledger': Promise.resolve(load) })
    setAppSessionForTesting(createAppSession({ repository, principal, commandStorage: createMemoryCommandStorage() }))
    const store = useSettlementStore()
    await store.loadGroup('deleted-ledger')

    await expect(store.recordPayment({
      kind: 'settlement.record', operationId: 'deleted-payment', groupId: 'deleted-ledger', expectedBalanceRevision: 1,
      basis: { kind: 'simplified', senderId: deleted.id, recipientId: current.id, currency: 'USD', debtMinor: 500 },
      money: { currency: 'USD', minorAmount: 500 }, method: 'cash', occurredOn: '2026-08-31', outsidePaymentConfirmed: true,
    })).resolves.toBe(false)
    expect(store.memberNames.get(deleted.id)).toBe('Deleted user')
    expect(store.error).toContain('Deleted accounts')
  })
})

describe('settlement store paint without blinking', () => {
  it('refreshes the group already on screen in place instead of blanking it', async () => {
    const requests: Record<string, Promise<LoadBundle>> = { a: Promise.resolve(bundle('a', 'Group A')) }
    setAppSessionForTesting(createAppSession({ repository: repositoryFor(requests), principal, commandStorage: createMemoryCommandStorage() }))
    const store = useSettlementStore()
    await store.loadGroup('a')

    const refresh = deferred<LoadBundle>()
    requests.a = refresh.promise
    const refreshing = store.loadGroup('a')
    await flushPromises()
    expect(store.isLoading).toBe(true)
    expect(store.group?.name).toBe('Group A')
    expect(store.balanceSnapshot?.groupId).toBe('a')
    expect(store.isProvisional).toBe(false)

    refresh.resolve(bundle('a', 'Group A renamed'))
    await refreshing
    expect(store.group?.name).toBe('Group A renamed')
  })

  it('paints the device copy while the server loads and records payments only once it confirms', async () => {
    const server = deferred<LoadBundle>()
    const cached = bundle('a', 'Group A (cached)')
    const repository = withDeviceCopy(repositoryFor({ a: server.promise }), cached)
    setAppSessionForTesting(createAppSession({ repository, principal, commandStorage: createMemoryCommandStorage() }))
    const store = useSettlementStore()

    const loading = store.loadGroup('a')
    await flushPromises()
    expect(store.group?.name).toBe('Group A (cached)')
    expect(store.balanceSnapshot?.groupId).toBe('a')
    expect(store.isProvisional).toBe(true)
    expect(store.canRecord).toBe(false)

    server.resolve(bundle('a', 'Group A'))
    await loading
    expect(store.group?.name).toBe('Group A')
    expect(store.isProvisional).toBe(false)
    expect(store.canRecord).toBe(true)
  })

  it('ignores a device copy that arrives after the server answered or failed', async () => {
    const lateCopy = deferred<{ members: readonly Member[]; snapshot: GroupBalanceSnapshot } | undefined>()
    const cached = bundle('a', 'Group A (cached)')
    const unavailable = Promise.reject(new Error('This group is not available.'))
    unavailable.catch(() => undefined)
    const base = repositoryFor({ a: Promise.resolve(bundle('a', 'Group A')), b: unavailable })
    const repository: AppRepository = { ...base, groups: { ...base.groups, peekBalanceContext: () => lateCopy.promise, peekList: async () => [cached.group, { ...cached.group, id: 'b' }] } }
    setAppSessionForTesting(createAppSession({ repository, principal, commandStorage: createMemoryCommandStorage() }))
    const store = useSettlementStore()

    await store.loadGroup('a')
    lateCopy.resolve({ members: cached.members, snapshot: cached.snapshot })
    await flushPromises()
    expect(store.group?.name).toBe('Group A')
    expect(store.isProvisional).toBe(false)

    await store.loadGroup('b')
    await flushPromises()
    expect(store.error).toBeDefined()
    expect(store.balanceSnapshot).toBeUndefined()
    expect(store.isProvisional).toBe(false)
  })
})

function withDeviceCopy(repository: AppRepository, cached: LoadBundle): AppRepository {
  return {
    ...repository,
    groups: {
      ...repository.groups,
      peekBalanceContext: async (id) => id === cached.group.id ? { members: cached.members, snapshot: cached.snapshot } : undefined,
      peekList: async () => [cached.group],
    },
  }
}

interface LoadBundle {
  readonly group: Group
  readonly user: Member
  readonly members: readonly Member[]
  readonly snapshot: GroupBalanceSnapshot
}

function repositoryFor(requests: Readonly<Record<string, Promise<LoadBundle>>>): AppRepository {
  const base = createDemoRepository()
  const read = (id: string) => requests[id] ?? Promise.reject(new Error(`Unknown group ${id}`))
  return {
    ...base,
    app: { ...base.app, getCurrentUser: async () => ({ id: 'maya-p', displayName: 'Maya P.', initials: 'MP', isCurrentUser: true }) },
    groups: {
      ...base.groups,
      getById: (id) => read(id).then(({ group }) => group),
      listMembers: (id) => read(id).then(({ members }) => members),
      getBalanceSnapshot: (id) => read(id).then(({ snapshot }) => snapshot),
    },
    settlements: {
      ...base.settlements,
      listForGroup: async (id) => { await read(id); return [] },
    },
  }
}

function bundle(id: string, name: string): LoadBundle {
  const user = { id: 'maya-p', displayName: 'Maya P.', initials: 'MP', isCurrentUser: true }
  return {
    group: { id, kind: 'group', name, currency: 'USD', memberIds: [user.id], syncState: 'fresh' },
    user,
    members: [user],
    snapshot: { groupId: id, balanceRevision: 1, simplifyDebtsEnabled: true, pairwise: [], simplified: [] },
  }
}

function recordCommand(operationId: string, expectedBalanceRevision: number, amountMinor: number): SettlementRecordCommand {
  return {
    kind: 'settlement.record', operationId, groupId, expectedBalanceRevision,
    basis: { kind: 'simplified', senderId: 'taylor-s', recipientId: 'maya-p', currency: 'USD', debtMinor: 3625 },
    money: { currency: 'USD', minorAmount: amountMinor }, method: 'cash', occurredOn: '2026-08-31', note: 'Paid', outsidePaymentConfirmed: true,
  }
}

interface Deferred<T> { readonly promise: Promise<T>; resolve(value: T): void }
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  return { promise: new Promise<T>((done) => { resolve = done }), resolve: (value) => resolve(value) }
}
