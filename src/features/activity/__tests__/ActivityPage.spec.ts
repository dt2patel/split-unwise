import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import { createAppRouter } from '../../../app/router'
import { CommandQueue, createMemoryCommandStorage } from '../../../data/commandQueue'
import { createDemoRepository } from '../../../data/demoRepository'
import { appPrincipalKey, createAppSession, setAppSessionForTesting } from '../../../data/session'
import type { ActivityItem } from '../../../data/repositories'
import ActivityPage from '../ActivityPage.vue'
import { activityDestination, useActivityStore } from '../activityStore'

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
    expect(wrapper.findAll('[data-activity-id]').map((row) => row.attributes('data-activity-id'))).toEqual(['activity-cabin-comment'])
    await wrapper.get('[data-filter="expenses"]').trigger('click')
    expect(wrapper.findAll('[data-activity-id]')).toHaveLength(5)
    await wrapper.get('[data-filter="all"]').trigger('click')
    expect(wrapper.findAll('[data-activity-id]')).toHaveLength(6)
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

  it('never derives a destination from invalid structured IDs or arbitrary fields', () => {
    const event = {
      id: 'unsafe', groupId: 'https://evil.example', operationId: 'unsafe', kind: 'expense.updated',
      subject: { kind: 'expense', id: 'groceries', label: 'Groceries' }, actor: { id: 'maya-p', displayName: 'Maya P.' },
      expenseId: '../account', revision: 2, createdAt: '2026-08-31T12:00:00.000Z', syncState: 'fresh', url: 'https://evil.example',
    } as ActivityItem

    expect(activityDestination(event, 'activity')).toBeUndefined()
  })
})

describe('Activity durable projection', () => {
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
