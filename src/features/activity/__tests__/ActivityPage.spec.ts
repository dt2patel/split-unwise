import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createAppRouter } from '../../../app/router'
import { CommandQueue, createMemoryCommandStorage } from '../../../data/commandQueue'
import { createDemoRepository } from '../../../data/demoRepository'
import { appPrincipalKey, createAppSession, setAppSessionForTesting } from '../../../data/session'
import type { ActivityItem } from '../../../data/repositories'
import ActivityPage from '../ActivityPage.vue'
import { activityDestination, newestActivityFirst, useActivityStore } from '../activityStore'

const principalKey = appPrincipalKey({ mode: 'demo', projectId: 'split-unwise-demo', uid: 'maya-p' })
const ionicStubs = {
  IonPage: { template: '<div class="ion-page"><slot /></div>' },
  IonHeader: { template: '<header><slot /></header>' },
  IonToolbar: { template: '<div><slot /></div>' },
  IonTitle: { template: '<div><slot /></div>' },
  IonContent: { template: '<section><slot /></section>' },
  IonSegment: { template: '<div role="group"><slot /></div>' },
  IonSegmentButton: { props: ['value'], emits: ['click'], template: '<button type="button" :data-filter="value" @click="$emit(\'click\')"><slot /></button>' },
  IonLabel: { template: '<span><slot /></span>' },
  IonButton: { template: '<button type="button"><slot /></button>' },
  IonButtons: { template: '<div><slot /></div>' },
  IonModal: { name: 'IonModal', props: ['isOpen', 'canDismiss', 'presentingElement'], emits: ['didDismiss'], template: '<aside v-if="isOpen"><slot /></aside>' },
  IonToggle: { props: ['modelValue'], template: '<input type="checkbox" :checked="modelValue" />' },
}

beforeEach(() => {
  setActivePinia(createPinia())
  setAppSessionForTesting(createAppSession({ repository: createDemoRepository(), commandStorage: createMemoryCommandStorage() }))
})

describe('global Activity page', () => {
  it('renders immutable self-actions in stable newest-first order with semantic times and validated expense links', async () => {
    const wrapper = await mountActivity()
    const rows = wrapper.findAll('[data-activity-id]')

    expect(wrapper.get('h1').text()).toBe('Activity')
    expect(rows.map((row) => row.attributes('data-activity-id'))).toEqual([
      'activity-groceries', 'activity-kayak', 'activity-cabin-comment', 'activity-cabin', 'activity-dinner', 'activity-gas',
    ])
    expect(rows[0].text()).toContain('Maya P. added Groceries')
    expect(rows[0].get('a').attributes('href')).toBe('/tabs/activity/expenses/groceries?groupId=lake-house-weekend')
    expect(rows.every((row) => row.get('time').attributes('datetime')?.endsWith('Z'))).toBe(true)
    expect(wrapper.findAll('h1')).toHaveLength(1)
  })

  it('filters without mutating canonical history', async () => {
    const wrapper = await mountActivity()

    await wrapper.get('[data-filter="comments"]').trigger('click')
    await flushPromises()
    expect(wrapper.findAll('[data-activity-id]').map((row) => row.attributes('data-activity-id'))).toEqual(['activity-cabin-comment'])
    await wrapper.get('[data-filter="expenses"]').trigger('click')
    await flushPromises()
    expect(wrapper.findAll('[data-activity-id]')).toHaveLength(5)
    await wrapper.get('[data-filter="all"]').trigger('click')
    await flushPromises()
    expect(wrapper.findAll('[data-activity-id]')).toHaveLength(6)
  })

  it('restores a deleted group and its ledger from a native card modal', async () => {
    const repository = createDemoRepository()
    await repository.commands.execute({ kind: 'group.delete', operationId: 'delete-for-restore', groupId: 'lake-house-weekend' })
    setAppSessionForTesting(createAppSession({ repository, commandStorage: createMemoryCommandStorage() }))

    const wrapper = await mountActivity()
    expect(wrapper.text()).toContain('Maya P. deleted Lake House Weekend')
    await wrapper.get('[data-action="restore-group"]').trigger('click')
    expect(wrapper.get('[data-testid="restore-group-modal"]').text()).toContain('Restore Lake House Weekend?')
    expect(wrapper.get('[data-testid="restore-group-modal"]').text()).toContain('expenses and payments')
    await wrapper.get('[data-testid="confirm-group-restore"]').trigger('click')

    await vi.waitFor(async () => expect(await repository.groups.list()).toHaveLength(1))
    await vi.waitFor(() => expect(wrapper.text()).toContain('Maya P. restored Lake House Weekend'))
  })

  it('orders timestamp ties by descending ID', async () => {
    const repository = createDemoRepository({ now: () => '2026-08-31T21:00:00.000Z' })
    const groceries = await repository.expenses.getById('lake-house-weekend', 'groceries')
    if (!groceries) throw new Error('Missing fixture')
    await repository.comments.add({ kind: 'comment.add', operationId: 'tie-comment', groupId: groceries.groupId, expenseId: groceries.id, body: 'Tie', attachmentRefs: [] })
    await repository.expenses.edit({
      kind: 'expense.edit', operationId: 'tie-edit', groupId: groceries.groupId, expenseId: groceries.id, expectedRevision: 1,
      draft: { groupId: groceries.groupId, description: 'Tie groceries', date: groceries.date, total: groceries.total, payments: groceries.payments, allocations: groceries.allocations, category: groceries.category, splitMethod: groceries.splitMethod, attachmentRefs: [] },
    })
    setAppSessionForTesting(createAppSession({ repository, commandStorage: createMemoryCommandStorage() }))

    const wrapper = await mountActivity()
    expect(wrapper.findAll('[data-activity-id]').slice(0, 2).map((row) => row.attributes('data-activity-id'))).toEqual(['activity-tie-edit', 'activity-tie-comment'])
  })

  it('orders punctuation and case ties with locale-independent Firestore byte ordering', () => {
    const base = {
      groupId: 'lake-house-weekend', operationId: 'tie', kind: 'group.event' as const,
      subject: { kind: 'group' as const, id: 'lake-house-weekend' }, actor: { id: 'maya-p', displayName: 'Maya P.' },
      createdAt: '2026-08-31T12:00:00.000Z', syncState: 'fresh' as const,
    }
    const ids = ['activity_a', 'activity.Z', 'activity-A'].map((id) => ({ ...base, id })).sort(newestActivityFirst).map(({ id }) => id)
    expect(ids).toEqual(['activity_a', 'activity.Z', 'activity-A'])
  })

  it('never derives a destination from invalid structured IDs or arbitrary fields', () => {
    const event = {
      id: 'unsafe', groupId: 'https://evil.example', operationId: 'unsafe', kind: 'expense.updated',
      subject: { kind: 'expense', id: 'groceries', label: 'Groceries' }, actor: { id: 'maya-p', displayName: 'Maya P.' },
      expenseId: '../account', revision: 2, createdAt: '2026-08-31T12:00:00.000Z', syncState: 'fresh', url: 'https://evil.example',
    } as ActivityItem

    expect(activityDestination(event, 'activity')).toBeUndefined()
  })

  it.each(['settlement.created', 'settlement.voided'] as const)('links %s activity to its durable settlement detail route', (kind) => {
    const event: ActivityItem = {
      id: `activity-${kind}`, groupId: 'lake-house-weekend', operationId: `operation-${kind}`, kind,
      subject: { kind: 'settlement', id: 'settlement-record-a', label: 'Payment' }, actor: { id: 'maya-p', displayName: 'Maya P.' },
      settlementId: 'settlement-record-a', createdAt: '2026-08-31T12:00:00.000Z', syncState: 'fresh',
    }

    expect(activityDestination(event, 'activity')).toBe('/tabs/groups/lake-house-weekend/settlements/settlement-record-a')
  })
})

describe('Activity durable projection', () => {
  it('uses the persisted queue submission timestamp for pending and failed activity', async () => {
    let release!: () => void
    const blocked = new Promise<void>((resolve) => { release = resolve })
    const repository = createDemoRepository()
    const queue = new CommandQueue({
      originPrincipalKey: principalKey,
      now: () => '2026-08-31T22:34:56.000Z',
      storage: createMemoryCommandStorage(),
      handlers: { 'comment.add': async (command) => { if (command.kind !== 'comment.add') throw new Error('Wrong command'); await blocked; return repository.comments.add(command) } },
    })
    setAppSessionForTesting({ ...createAppSession({ repository, commandStorage: createMemoryCommandStorage() }), queue })
    queue.submit({ kind: 'comment.add', operationId: 'pending-time', groupId: 'lake-house-weekend', expenseId: 'groceries', body: 'Queued now', attachmentRefs: [] })

    const store = useActivityStore()
    await store.load()
    expect(store.items.find(({ operationId }) => operationId === 'pending-time')?.createdAt).toBe('2026-08-31T22:34:56.000Z')
    release()
  })

  it('loads the next authoritative page without duplicating prior activity', async () => {
    const source = createDemoRepository()
    const all = (await source.activity.listForAccount({ filter: 'all', limit: 100 })).items
    const calls: Array<string | undefined> = []
    const repository = {
      ...source,
      activity: {
        ...source.activity,
        async listForAccount(query: { readonly cursor?: { readonly createdAt: string; readonly id: string } }) {
          calls.push(query.cursor?.id)
          if (!query.cursor) return { items: [all[0]], nextCursor: { createdAt: all[0].createdAt, id: all[0].id } }
          return { items: [all[1]] }
        },
      },
    }
    setAppSessionForTesting(createAppSession({ repository, commandStorage: createMemoryCommandStorage() }))
    const wrapper = await mountActivity()

    expect(wrapper.findAll('[data-activity-id]')).toHaveLength(1)
    await wrapper.get('[data-action="load-more-activity"]').trigger('click')
    await flushPromises()
    expect(wrapper.findAll('[data-activity-id]')).toHaveLength(2)
    expect(new Set(wrapper.findAll('[data-activity-id]').map((row) => row.attributes('data-activity-id'))).size).toBe(2)
    expect(calls).toEqual([undefined, all[0].id])
  })

  it('queries and paginates the selected server filter so matches beyond the first all-page are not falsely empty', async () => {
    const source = createDemoRepository()
    const all = (await source.activity.listForAccount({ filter: 'all', limit: 100 })).items
    const expense = all.find(({ kind }) => kind.startsWith('expense.'))!
    const comment = all.find(({ kind }) => kind === 'comment.added')!
    const olderComment = { ...comment, id: 'activity-older-comment', operationId: 'older-comment', createdAt: '2026-08-20T12:00:00.000Z' }
    const calls: Array<{ readonly filter: string; readonly cursor?: string }> = []
    const repository = {
      ...source,
      activity: {
        ...source.activity,
        async listForAccount(query: { readonly filter: string; readonly cursor?: { readonly createdAt: string; readonly id: string } }) {
          calls.push({ filter: query.filter, cursor: query.cursor?.id })
          if (query.filter === 'all') return { items: [expense] }
          if (!query.cursor) return { items: [comment], nextCursor: { createdAt: comment.createdAt, id: comment.id } }
          return { items: [olderComment] }
        },
      },
    }
    setAppSessionForTesting(createAppSession({ repository, commandStorage: createMemoryCommandStorage() }))
    const wrapper = await mountActivity()
    expect(wrapper.findAll('[data-activity-id]')).toHaveLength(1)

    await wrapper.get('[data-filter="comments"]').trigger('click')
    await flushPromises()
    expect(wrapper.findAll('[data-activity-id]').map((row) => row.attributes('data-activity-id'))).toEqual([comment.id])
    await wrapper.get('[data-action="load-more-activity"]').trigger('click')
    await flushPromises()
    expect(wrapper.findAll('[data-activity-id]').map((row) => row.attributes('data-activity-id'))).toEqual([comment.id, olderComment.id])
    expect(calls).toEqual([
      { filter: 'all', cursor: undefined },
      { filter: 'comments', cursor: undefined },
      { filter: 'comments', cursor: comment.id },
    ])
  })

  it('invalidates a deferred old-filter page and its cursor synchronously when the filter changes', async () => {
    const source = createDemoRepository()
    const all = (await source.activity.listForAccount({ filter: 'all', limit: 100 })).items
    const expense = all.find(({ kind }) => kind.startsWith('expense.'))!
    const comment = all.find(({ kind }) => kind === 'comment.added')!
    let releaseOldPage!: () => void
    const oldPageGate = new Promise<void>((resolve) => { releaseOldPage = resolve })
    let releaseComments!: () => void
    const commentsGate = new Promise<void>((resolve) => { releaseComments = resolve })
    const calls: Array<{ readonly filter: string; readonly cursor?: string }> = []
    const repository = {
      ...source,
      activity: {
        ...source.activity,
        async listForAccount(query: { readonly filter: string; readonly cursor?: { readonly createdAt: string; readonly id: string } }) {
          calls.push({ filter: query.filter, cursor: query.cursor?.id })
          if (query.filter === 'all' && query.cursor) {
            await oldPageGate
            return { items: [all[1]] }
          }
          if (query.filter === 'comments') {
            await commentsGate
            return { items: [comment], nextCursor: { createdAt: comment.createdAt, id: comment.id } }
          }
          return { items: [expense], nextCursor: { createdAt: expense.createdAt, id: expense.id } }
        },
      },
    }
    setAppSessionForTesting(createAppSession({ repository, commandStorage: createMemoryCommandStorage() }))
    const store = useActivityStore()
    await store.load()
    const oldPage = store.loadMore()
    await flushPromises()

    store.setFilter('comments')
    expect(store.nextCursor).toBeUndefined()
    expect(store.isLoadingMore).toBe(false)
    expect(store.isFiltering).toBe(true)
    await store.loadMore()
    expect(calls).toEqual([
      { filter: 'all', cursor: undefined },
      { filter: 'all', cursor: expense.id },
      { filter: 'comments', cursor: undefined },
    ])

    releaseOldPage()
    await oldPage
    expect(store.allItems.some(({ id }) => id === all[1].id)).toBe(false)
    releaseComments()
    await flushPromises()
    expect(store.items.map(({ id }) => id)).toEqual([comment.id])
    expect(store.nextCursor?.id).toBe(comment.id)
  })

  it('projects one pending event across store recreation and leaves an ID-less add noninteractive', async () => {
    let release!: () => void
    const blocked = new Promise<void>((resolve) => { release = resolve })
    const repository = createDemoRepository()
    const queue = new CommandQueue({
      originPrincipalKey: principalKey, storage: createMemoryCommandStorage(),
      handlers: { 'expense.add': async (command) => { if (command.kind !== 'expense.add') throw new Error('Wrong command'); await blocked; return repository.expenses.add(command) } },
    })
    setAppSessionForTesting({ ...createAppSession({ repository, commandStorage: createMemoryCommandStorage() }), queue })
    queue.submit({
      kind: 'expense.add', operationId: 'pending-activity-add', groupId: 'lake-house-weekend', description: 'Pending firewood', date: '2026-08-31', total: { currency: 'USD', minorAmount: 400 },
      payments: [{ participantId: 'maya-p', money: { currency: 'USD', minorAmount: 400 } }],
      allocations: [
        { participantId: 'maya-p', money: { currency: 'USD', minorAmount: 100 } }, { participantId: 'jordan-k', money: { currency: 'USD', minorAmount: 100 } },
        { participantId: 'alex-r', money: { currency: 'USD', minorAmount: 100 } }, { participantId: 'taylor-s', money: { currency: 'USD', minorAmount: 100 } },
      ], category: 'Supplies', splitMethod: { type: 'equal', participantIds: ['maya-p', 'jordan-k', 'alex-r', 'taylor-s'] }, attachmentRefs: [],
    })

    const first = useActivityStore()
    await first.load()
    expect(first.items.filter(({ operationId }) => operationId === 'pending-activity-add')).toHaveLength(1)
    expect(activityDestination(first.items.find(({ operationId }) => operationId === 'pending-activity-add')!, 'activity')).toBeUndefined()

    setActivePinia(createPinia())
    const recreated = useActivityStore()
    await recreated.load()
    expect(recreated.items.filter(({ operationId }) => operationId === 'pending-activity-add')).toHaveLength(1)

    release()
  })

  it('projects distinct source and target events for a pending expense move', async () => {
    let release!: () => void
    const blocked = new Promise<void>((resolve) => { release = resolve })
    const repository = createDemoRepository()
    const groceries = await repository.expenses.getById('lake-house-weekend', 'groceries')
    if (!groceries) throw new Error('Missing fixture')
    const queue = new CommandQueue({
      originPrincipalKey: principalKey, storage: createMemoryCommandStorage(),
      handlers: { 'expense.edit': async (command) => {
        if (command.kind !== 'expense.edit') throw new Error('Wrong command')
        await blocked
        throw new Error('The pending test should release only during cleanup')
      } },
    })
    setAppSessionForTesting({ ...createAppSession({ repository, commandStorage: createMemoryCommandStorage() }), queue })
    queue.submit({
      kind: 'expense.edit', operationId: 'pending-activity-move', groupId: groceries.groupId, expenseId: groceries.id, expectedRevision: groceries.revision,
      draft: { groupId: 'target-trip', description: 'Moved groceries', date: groceries.date, total: groceries.total, payments: groceries.payments, allocations: groceries.allocations, category: groceries.category, splitMethod: groceries.splitMethod, attachmentRefs: [] },
    })

    const store = useActivityStore()
    await store.load()

    expect(store.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ operationId: 'pending-activity-move', groupId: groceries.groupId, kind: 'expense.deleted', expenseId: groceries.id, syncState: 'pending' }),
      expect.objectContaining({ operationId: 'pending-activity-move.move-target', groupId: 'target-trip', kind: 'expense.created', syncState: 'pending' }),
    ]))
    expect(store.items.filter(({ operationId }) => operationId.startsWith('pending-activity-move'))).toHaveLength(2)
    expect(activityDestination(store.items.find(({ operationId }) => operationId === 'pending-activity-move.move-target')!, 'activity')).toBeUndefined()
    release()
  })

  it('suppresses conflicted expense audit projections', async () => {
    const repository = createDemoRepository()
    const groceries = await repository.expenses.getById('lake-house-weekend', 'groceries')
    if (!groceries) throw new Error('Missing fixture')
    const queue = new CommandQueue({
      originPrincipalKey: principalKey, storage: createMemoryCommandStorage(),
      handlers: { 'expense.edit': async (command) => { if (command.kind !== 'expense.edit') throw new Error('Wrong command'); return repository.expenses.edit(command) } },
    })
    setAppSessionForTesting({ ...createAppSession({ repository, commandStorage: createMemoryCommandStorage() }), queue })
    await expect(queue.submit({
      kind: 'expense.edit', operationId: 'conflicted-activity', groupId: groceries.groupId, expenseId: groceries.id, expectedRevision: 0,
      draft: { groupId: groceries.groupId, description: 'Conflict', date: groceries.date, total: groceries.total, payments: groceries.payments, allocations: groceries.allocations, category: groceries.category, splitMethod: groceries.splitMethod, attachmentRefs: [] },
    }).result()).rejects.toThrow('changed remotely')

    const store = useActivityStore()
    await store.load()
    expect(store.items.some(({ operationId }) => operationId === 'conflicted-activity')).toBe(false)
  })
})

async function mountActivity() {
  const router = createAppRouter()
  await router.push('/tabs/activity')
  await router.isReady()
  const wrapper = mount(ActivityPage, { global: { plugins: [createPinia(), router], stubs: ionicStubs } })
  await flushPromises()
  return wrapper
}
