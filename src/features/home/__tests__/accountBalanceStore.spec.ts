import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryCommandStorage } from '../../../data/commandQueue'
import { createDemoRepository } from '../../../data/demoRepository'
import type { Group, GroupBalanceSnapshot, Member } from '../../../data/repositories'
import { createAppSession, setAppSessionForTesting } from '../../../data/session'
import { useAccountBalanceStore } from '../accountBalanceStore'

const maya: Member = { id: 'maya-p', displayName: 'Maya P.', initials: 'MP', isCurrentUser: true }
const alex: Member = { id: 'alex-r', displayName: 'Alex R.', initials: 'AR', isCurrentUser: false }

beforeEach(() => setActivePinia(createPinia()))

describe('account balance store', () => {
  it('loads the real saved demo plan into account, group, and friend positions', async () => {
    const repository = createDemoRepository()
    setAppSessionForTesting(createAppSession({ repository, commandStorage: createMemoryCommandStorage() }))
    const groups = await repository.groups.list()
    const store = useAccountBalanceStore()

    await store.load(groups, 'maya-p')

    expect(store.coverage).toEqual({ status: 'complete', loadedContextIds: ['lake-house-weekend'], failedContextIds: [] })
    expect(store.projection.currencies).toEqual([{ currency: 'USD', netMinor: 3625, owedToUserMinor: 3625, userOwesMinor: 0 }])
    expect(store.projection.groups).toEqual([expect.objectContaining({ groupId: 'lake-house-weekend', positions: [{ currency: 'USD', minorAmount: 3625 }] })])
    expect(store.projection.friends.map(({ id, positions }) => ({ id, positions }))).toEqual([
      { id: 'alex-r', positions: [{ currency: 'USD', minorAmount: 0 }] },
      { id: 'jordan-k', positions: [{ currency: 'USD', minorAmount: 0 }] },
      { id: 'sam-d', positions: [{ currency: 'USD', minorAmount: 0 }] },
      { id: 'taylor-s', positions: [{ currency: 'USD', minorAmount: 3625 }] },
    ])
  })

  it('coalesces duplicate loads, publishes completed contexts progressively, and contains one failed context', async () => {
    const base = createDemoRepository()
    const secondMembers = deferred<readonly Member[]>()
    const first = group('first', 'First trip')
    const second = group('second', 'Second trip')
    const listMembers = vi.fn(async (groupId: string) => groupId === first.id ? [maya, alex] : secondMembers.promise)
    const getBalanceSnapshot = vi.fn(async (groupId: string) => snapshot(groupId, 1250))
    setAppSessionForTesting(createAppSession({
      repository: { ...base, groups: { ...base.groups, listMembers, getBalanceSnapshot } },
      commandStorage: createMemoryCommandStorage(),
    }))
    const store = useAccountBalanceStore()

    const pending = store.load([first, second], maya.id)
    const duplicate = store.load([first, second], maya.id)
    await vi.waitFor(() => expect(store.projection.groups.map(({ groupId }) => groupId)).toEqual(['first']))

    expect(store.isLoading).toBe(true)
    expect(listMembers).toHaveBeenCalledTimes(2)
    expect(getBalanceSnapshot).toHaveBeenCalledTimes(2)
    secondMembers.reject(new Error('temporarily unavailable'))
    await Promise.all([pending, duplicate])

    expect(store.projection.groups.map(({ groupId }) => groupId)).toEqual(['first'])
    expect(store.coverage).toEqual({ status: 'partial', loadedContextIds: ['first'], failedContextIds: ['second'] })
    expect(store.notice).toBe('partial')
  })

  it('does not let an older principal/context request overwrite a newer result', async () => {
    const base = createDemoRepository()
    const oldSnapshot = deferred<GroupBalanceSnapshot>()
    const oldGroup = group('old', 'Old trip')
    const freshGroup = group('fresh', 'Fresh trip')
    setAppSessionForTesting(createAppSession({
      repository: {
        ...base,
        groups: {
          ...base.groups,
          async listMembers() { return [maya, alex] },
          async getBalanceSnapshot(groupId) { return groupId === oldGroup.id ? oldSnapshot.promise : snapshot(groupId, 800) },
        },
      },
      commandStorage: createMemoryCommandStorage(),
    }))
    const store = useAccountBalanceStore()

    const oldLoad = store.load([oldGroup], maya.id)
    await Promise.resolve()
    await store.load([freshGroup], maya.id)
    oldSnapshot.resolve(snapshot(oldGroup.id, 9900))
    await oldLoad

    expect(store.projection.groups).toEqual([expect.objectContaining({ groupId: 'fresh', positions: [{ currency: 'USD', minorAmount: 800 }] })])
    expect(store.coverage.loadedContextIds).toEqual(['fresh'])
  })

  it('retries a context after a forced refresh loses previously cached coverage', async () => {
    const base = createDemoRepository()
    const target = group('retry', 'Retry trip')
    let fail = false
    const getBalanceSnapshot = vi.fn(async (groupId: string) => {
      if (fail) throw new Error('offline')
      return snapshot(groupId, 600)
    })
    setAppSessionForTesting(createAppSession({
      repository: { ...base, groups: { ...base.groups, async listMembers() { return [maya, alex] }, getBalanceSnapshot } },
      commandStorage: createMemoryCommandStorage(),
    }))
    const store = useAccountBalanceStore()

    await store.load([target], maya.id)
    fail = true
    await store.load([target], maya.id, { force: true })
    expect(store.coverage.status).toBe('error')
    fail = false
    await store.load([target], maya.id)

    expect(getBalanceSnapshot).toHaveBeenCalledTimes(3)
    expect(store.coverage.status).toBe('complete')
    expect(store.projection.currencies).toEqual([{ currency: 'USD', netMinor: 600, owedToUserMinor: 600, userOwesMinor: 0 }])
  })
})

describe('refreshing account balances', () => {
  it('keeps confirmed totals steady until a forced refresh has every group', async () => {
    const base = createDemoRepository()
    const first = group('first', 'First trip')
    const second = group('second', 'Second trip')
    let secondServer = Promise.resolve(snapshot('second', 2500))
    const getBalanceSnapshot = vi.fn(async (groupId: string) => groupId === first.id ? snapshot(groupId, 1500) : secondServer)
    setAppSessionForTesting(createAppSession({
      repository: { ...base, groups: { ...base.groups, listMembers: async () => [maya, alex], getBalanceSnapshot } },
      commandStorage: createMemoryCommandStorage(),
    }))
    const store = useAccountBalanceStore()
    await store.load([first, second], maya.id)
    expect(store.projection.currencies[0]?.netMinor).toBe(4000)

    const pending = deferred<GroupBalanceSnapshot>()
    secondServer = pending.promise
    const refreshing = store.load([first, second], maya.id, { force: true })
    await vi.waitFor(() => expect(getBalanceSnapshot).toHaveBeenCalledTimes(4))
    await Promise.resolve()
    // The first group already reloaded, but the total stays whole instead of dipping to it alone.
    expect(store.projection.currencies[0]?.netMinor).toBe(4000)

    pending.resolve(snapshot('second', 3500))
    await refreshing
    expect(store.projection.currencies[0]?.netMinor).toBe(5000)
    expect(store.coverage.status).toBe('complete')
  })
})

describe('cache-first account balances', () => {
  it('shows cached balances immediately and swaps in the complete server result without dipping', async () => {
    const base = createDemoRepository()
    const first = group('first', 'First trip')
    const second = group('second', 'Second trip')
    const secondServer = deferred<GroupBalanceSnapshot>()
    const peekBalanceContext = vi.fn(async (groupId: string) => ({ members: [maya, alex], snapshot: snapshot(groupId, 1000) }))
    const getBalanceSnapshot = vi.fn(async (groupId: string) => groupId === first.id ? snapshot(groupId, 1500) : secondServer.promise)
    setAppSessionForTesting(createAppSession({
      repository: { ...base, groups: { ...base.groups, listMembers: async () => [maya, alex], getBalanceSnapshot, peekBalanceContext } },
      commandStorage: createMemoryCommandStorage(),
    }))
    const store = useAccountBalanceStore()

    await store.peek([first, second], maya.id)
    expect(store.isProvisional).toBe(true)
    expect(store.projection.currencies).toEqual([{ currency: 'USD', netMinor: 2000, owedToUserMinor: 2000, userOwesMinor: 0 }])

    const loading = store.load([first, second], maya.id)
    await vi.waitFor(() => expect(getBalanceSnapshot).toHaveBeenCalledTimes(2))
    await Promise.resolve()
    // The first group's server result is in, but the cached total stays until every group is confirmed.
    expect(store.projection.currencies[0]?.netMinor).toBe(2000)
    expect(store.isProvisional).toBe(true)

    secondServer.resolve(snapshot(second.id, 2500))
    await loading
    expect(store.projection.currencies).toEqual([{ currency: 'USD', netMinor: 4000, owedToUserMinor: 4000, userOwesMinor: 0 }])
    expect(store.isProvisional).toBe(false)
    expect(store.coverage.status).toBe('complete')
  })

  it('shows nothing from the cache unless every group has a synced copy', async () => {
    const base = createDemoRepository()
    const peekBalanceContext = vi.fn(async (groupId: string) => groupId === 'first' ? { members: [maya, alex], snapshot: snapshot(groupId, 1000) } : undefined)
    setAppSessionForTesting(createAppSession({ repository: { ...base, groups: { ...base.groups, peekBalanceContext } }, commandStorage: createMemoryCommandStorage() }))
    const store = useAccountBalanceStore()

    await store.peek([group('first', 'First trip'), group('second', 'Second trip')], maya.id)
    expect(store.isProvisional).toBe(false)
    expect(store.projection.currencies).toEqual([])
  })
})

function group(id: string, name: string): Group {
  return { id, name, kind: 'group', currency: 'USD', memberIds: [maya.id, alex.id], syncState: 'fresh' }
}

function snapshot(groupId: string, minorAmount: number): GroupBalanceSnapshot {
  const debt = { fromParticipantId: alex.id, toParticipantId: maya.id, money: { currency: 'USD' as const, minorAmount } }
  return { groupId, balanceRevision: 1, simplifyDebtsEnabled: false, pairwise: [debt], simplified: [debt] }
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(reason: Error): void } {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((success, failure) => { resolve = success; reject = failure })
  return { promise, resolve, reject }
}
