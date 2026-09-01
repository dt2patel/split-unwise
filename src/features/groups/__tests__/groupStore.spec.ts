import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { Component } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createAppRouter } from '../../../app/router'
import { createDemoRepository } from '../../../data/demoRepository'
import type { ActivityItem, AppRepository, ExpenseRow, Group, Member } from '../../../data/repositories'
import { useGroupStore } from '../groupStore'

const repositoryHarness = vi.hoisted(() => ({ current: undefined as unknown }))

vi.mock('../../../data', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../data')>()
  const repository = new Proxy({}, {
    get(_target, property) {
      return (repositoryHarness.current as AppRepository)[property as keyof AppRepository]
    },
  }) as AppRepository
  return { ...actual, getAppSession: () => ({ repository, queue: { snapshot: () => [], subscribe: () => () => undefined } }) }
})

interface GroupSnapshot {
  readonly group: Group
  readonly members: readonly Member[]
  readonly expenses: readonly ExpenseRow[]
  readonly activity: readonly ActivityItem[]
}

interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T): void
}

const maya: Member = { id: 'maya-p', displayName: 'Maya P.', initials: 'MP', isCurrentUser: true }
const jordan: Member = { id: 'jordan-k', displayName: 'Jordan K.', initials: 'JK', isCurrentUser: false }

const ionicStubs = {
  IonPage: { template: '<main class="ion-page"><slot /></main>' },
  IonHeader: { template: '<header><slot /></header>' },
  IonToolbar: { template: '<div><slot /></div>' },
  IonTitle: { template: '<div><slot /></div>' },
  IonButtons: { template: '<div><slot /></div>' },
  IonBackButton: { props: ['defaultHref', 'text'], template: '<a :href="defaultHref">{{ text }}</a>' },
  IonContent: { template: '<section><slot /></section>' },
  IonFooter: { template: '<footer><slot /></footer>' },
  IonSegment: { template: '<nav><slot /></nav>' },
  IonSegmentButton: { props: ['value'], template: '<button type="button"><slot /></button>' },
  IonLabel: { template: '<span><slot /></span>' },
  IonButton: { props: ['routerLink', 'ariaLabel'], template: '<a :href="routerLink" :aria-label="ariaLabel"><slot /></a>' },
  IonIcon: { template: '<span aria-hidden="true" />' },
  IonFab: { template: '<div><slot /></div>' },
  IonFabButton: { props: ['routerLink'], template: '<a :href="routerLink"><slot /></a>' },
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('group load identity', () => {
  it('coalesces concurrent reads for the same group', async () => {
    const request = deferred<GroupSnapshot>()
    const base = repositoryFor({ a: request.promise })
    const calls = { group: 0, user: 0, members: 0, expenses: 0, activity: 0 }
    repositoryHarness.current = {
      ...base,
      app: {
        ...base.app,
        async getCurrentUser() {
          calls.user += 1
          return base.app.getCurrentUser()
        },
      },
      groups: {
        ...base.groups,
        async getById(groupId: string) {
          calls.group += 1
          return base.groups.getById(groupId)
        },
        async listMembers(groupId: string) {
          calls.members += 1
          return base.groups.listMembers(groupId)
        },
      },
      expenses: {
        ...base.expenses,
        async listForGroup(groupId: string) {
          calls.expenses += 1
          return base.expenses.listForGroup(groupId)
        },
      },
      activity: {
        ...base.activity,
        async listForGroup(groupId: string) {
          calls.activity += 1
          return base.activity.listForGroup(groupId)
        },
      },
    }
    const store = useGroupStore()

    const first = store.loadGroup('a')
    const second = store.loadGroup('a')
    await Promise.resolve()
    await Promise.resolve()

    expect(calls).toEqual({ group: 1, user: 1, members: 1, expenses: 1, activity: 1 })

    request.resolve(snapshot('a', 'Group A'))
    await Promise.all([first, second])
    expect(store.activeGroup?.id).toBe('a')
  })

  it('reveals the group shell before the slower journal reads finish', async () => {
    const activity = deferred<readonly ActivityItem[]>()
    const base = repositoryFor({ a: Promise.resolve(snapshot('a', 'Group A')) })
    repositoryHarness.current = {
      ...base,
      activity: { ...base.activity, async listForGroup() { return activity.promise } },
    }
    const store = useGroupStore()

    const loading = store.loadGroup('a')
    await flushPromises()

    expect(store.activeGroup?.id).toBe('a')
    expect(store.isLoading).toBe(true)

    activity.resolve([])
    await loading
    expect(store.isLoading).toBe(false)
  })

  it('keeps an already loaded group usable while refreshing it', async () => {
    const requests: Record<string, Promise<GroupSnapshot>> = { a: Promise.resolve(snapshot('a', 'Group A')) }
    repositoryHarness.current = repositoryFor(requests)
    const store = useGroupStore()
    await store.loadGroup('a')
    const refresh = deferred<GroupSnapshot>()
    requests.a = refresh.promise

    const refreshing = store.loadGroup('a')
    await flushPromises()

    expect(store.activeGroup?.id).toBe('a')
    expect(store.isLoading).toBe(true)

    refresh.resolve(snapshot('a', 'Group A refreshed'))
    await refreshing
    expect(store.activeGroup?.name).toBe('Group A refreshed')
  })

  it('clears stale content and lets the latest B request win after delayed A resolves', async () => {
    const requestA = deferred<GroupSnapshot>()
    const requestB = deferred<GroupSnapshot>()
    repositoryHarness.current = repositoryFor({
      stale: Promise.resolve(snapshot('stale', 'Stale group')),
      a: requestA.promise,
      b: requestB.promise,
    })
    const store = useGroupStore()
    await store.loadGroup('stale')
    expect(store.activeGroup?.id).toBe('stale')

    const loadingA = store.loadGroup('a')
    expect(store.activeGroup).toBeUndefined()
    expect(store.journalExpenses).toEqual([])
    expect(store.isLoading).toBe(true)

    const loadingB = store.loadGroup('b')
    requestB.resolve(snapshot('b', 'Group B'))
    await loadingB
    expect(store.activeGroup?.id).toBe('b')
    expect(store.isLoading).toBe(false)

    requestA.resolve(snapshot('a', 'Group A'))
    await loadingA
    expect(store.activeGroup?.id).toBe('b')
    expect(store.error).toBeUndefined()
    expect(store.isLoading).toBe(false)
  })
})

describe('per-currency group balances', () => {
  it('renders USD and EUR nets separately without an implicit conversion', async () => {
    repositoryHarness.current = repositoryFor({ mixed: Promise.resolve(snapshot('mixed', 'Mixed trip', mixedCurrencyExpenses('mixed'))) })
    const wrapper = await mountRoute('/tabs/groups/mixed')

    const balances = wrapper.findAll('[data-testid="group-balance"]')
    expect(balances).toHaveLength(2)
    expect(balances[0].text()).toContain('You are owed')
    expect(balances[0].text()).toContain('$75.00')
    expect(balances[1].text()).toContain('You owe')
    expect(balances[1].text()).toContain('€5.00')
    expect(wrapper.text()).not.toContain('$70.00')
  })

  it('shows a visible error instead of rounding an overflowing aggregate', async () => {
    repositoryHarness.current = repositoryFor({ overflow: Promise.resolve(snapshot('overflow', 'Overflow trip', overflowingExpenses('overflow'))) })
    const wrapper = await mountRoute('/tabs/groups/overflow')

    expect(wrapper.get('[role="alert"]').text()).toContain('Money addition exceeds safe integer range')
    expect(wrapper.find('[data-testid="group-cover"]').exists()).toBe(false)
  })
})

async function mountRoute(path: string): Promise<VueWrapper> {
  const router = createAppRouter()
  await router.push(path)
  await router.isReady()
  const component = router.currentRoute.value.matched.at(-1)?.components?.default as Component | undefined
  if (!component) throw new Error(`No component resolved for ${path}`)
  const wrapper = mount(component, { global: { plugins: [createPinia(), router], stubs: ionicStubs } })
  await flushPromises()
  return wrapper
}

function repositoryFor(requests: Readonly<Record<string, Promise<GroupSnapshot>>>): AppRepository {
  const base = createDemoRepository()
  const read = (groupId: string): Promise<GroupSnapshot> => requests[groupId] ?? Promise.reject(new Error(`Unknown test group: ${groupId}`))
  return {
    ...base,
    app: { ...base.app, async getCurrentUser() { return { ...maya } } },
    groups: {
      ...base.groups,
      async getById(groupId) { return read(groupId).then(({ group }) => group) },
      async listMembers(groupId) { return read(groupId).then(({ members }) => members) },
    },
    expenses: {
      ...base.expenses,
      async listForGroup(groupId) { return read(groupId).then(({ expenses }) => expenses) },
    },
    activity: {
      ...base.activity,
      async listForGroup(groupId) { return read(groupId).then(({ activity }) => activity) },
    },
  }
}

function snapshot(id: string, name: string, expenses: readonly ExpenseRow[] = []): GroupSnapshot {
  return {
    group: { id, name, currency: 'USD', coverImageUrl: '/assets/images/lake-house-cover.png', memberIds: [maya.id, jordan.id], syncState: 'fresh' },
    members: [maya, jordan],
    expenses,
    activity: [],
  }
}

function mixedCurrencyExpenses(groupId: string): readonly ExpenseRow[] {
  return [
    expense(groupId, 'usd', 'USD', 10000, maya.id, 2500, 7500),
    expense(groupId, 'eur', 'EUR', 2000, jordan.id, 500, 1500),
  ]
}

function overflowingExpenses(groupId: string): readonly ExpenseRow[] {
  return [
    expense(groupId, 'max-a', 'USD', Number.MAX_SAFE_INTEGER, maya.id, 0, Number.MAX_SAFE_INTEGER),
    expense(groupId, 'max-b', 'USD', Number.MAX_SAFE_INTEGER, maya.id, 0, Number.MAX_SAFE_INTEGER),
  ]
}

function expense(
  groupId: string,
  id: string,
  currency: 'EUR' | 'USD',
  total: number,
  payerId: string,
  mayaShare: number,
  jordanShare: number,
): ExpenseRow {
  return {
    id,
    groupId,
    description: id,
    date: '2026-08-30',
    total: { currency, minorAmount: total },
    payments: [{ participantId: payerId, money: { currency, minorAmount: total } }],
    allocations: [
      { participantId: maya.id, money: { currency, minorAmount: mayaShare } },
      { participantId: jordan.id, money: { currency, minorAmount: jordanShare } },
    ],
    category: 'Test',
    createdAt: '2026-08-30T12:00:00.000Z',
    updatedAt: '2026-08-30T12:00:00.000Z',
    revision: 1,
    syncState: 'fresh',
    splitMethod: { type: 'exact', allocations: [
      { participantId: maya.id, money: { currency, minorAmount: mayaShare } },
      { participantId: jordan.id, money: { currency, minorAmount: jordanShare } },
    ] },
    attachmentRefs: [],
  }
}

function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void
  const promise = new Promise<T>((resolve) => { resolvePromise = resolve })
  return { promise, resolve: resolvePromise }
}
