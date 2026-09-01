import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createAppRouter } from '../../../app/router'
import { CommandConflictError, CommandQueue, createMemoryCommandStorage } from '../../../data/commandQueue'
import { createDemoRepository } from '../../../data/demoRepository'
import { createMemoryReceiptStore } from '../../../data/receipts'
import { appPrincipalKey, createAppSession, setAppSessionForTesting } from '../../../data/session'
import type { AppRepository } from '../../../data/repositories'
import ExpenseDetailPage from '../ExpenseDetailPage.vue'

const ionicStubs = {
  IonPage: { template: '<div class="ion-page"><slot /></div>' },
  IonHeader: { template: '<header><slot /></header>' },
  IonToolbar: { template: '<div><slot /></div>' },
  IonTitle: { template: '<div><slot /></div>' },
  IonButtons: { template: '<div><slot /></div>' },
  IonBackButton: { props: ['defaultHref', 'text'], template: '<a data-testid="back" :href="defaultHref">{{ text }}</a>' },
  IonButton: { props: ['routerLink', 'disabled'], template: '<a v-if="routerLink" :href="routerLink" :aria-disabled="disabled || undefined"><slot /></a><button v-else type="button" :disabled="disabled"><slot /></button>' },
  IonContent: { template: '<section><slot /></section>' },
  IonIcon: { template: '<span aria-hidden="true" />' },
  IonAlert: { name: 'IonAlert', props: ['isOpen', 'header', 'message', 'buttons'], emits: ['didDismiss'], template: '<div v-if="isOpen" data-testid="delete-alert" />' },
}
const principalKey = appPrincipalKey({ mode: 'demo', projectId: 'split-unwise-demo', uid: 'maya-p' })

beforeEach(() => {
  setAppSessionForTesting(createAppSession({ repository: createDemoRepository(), commandStorage: createMemoryCommandStorage() }))
})

describe('expense detail route context', () => {
  it.each([
    ['/tabs/home/expenses/groceries?groupId=lake-house-weekend', '/tabs/home'],
    ['/tabs/groups/expenses/groceries?groupId=lake-house-weekend', '/tabs/groups/lake-house-weekend'],
    ['/tabs/activity/expenses/groceries?groupId=lake-house-weekend', '/tabs/activity'],
    ['/tabs/account/expenses/groceries?groupId=lake-house-weekend', '/tabs/account'],
  ])('loads %s through the exact group and preserves its origin return', async (path, back) => {
    const wrapper = await mountRoute(path)

    expect(wrapper.get('h1').text()).toBe('Groceries')
    expect(wrapper.get('[data-testid="back"]').attributes('href')).toBe(back)
    expect(wrapper.get('[data-action="edit-expense"]').attributes('href')).toContain(path.split('/expenses/')[0] + '/expenses/groceries/edit?groupId=lake-house-weekend')
    expect(wrapper.get('[data-testid="expense-total"]').text()).toContain('$170.00')
    expect(wrapper.get('[aria-labelledby="payers-title"]').findAll('li')).toHaveLength(1)
    expect(wrapper.get('[aria-labelledby="allocations-title"]').findAll('li')).toHaveLength(4)
    expect(wrapper.get('[aria-labelledby="audit-title"]').findAll('li')).toHaveLength(1)
    expect(wrapper.findAll('h1')).toHaveLength(1)
  })

  it('fails closed on a repeated group query without attempting an expense scan', async () => {
    const source = createDemoRepository()
    const getById = vi.fn(source.expenses.getById)
    setAppSessionForTesting(createAppSession({
      repository: { ...source, expenses: { ...source.expenses, getById } },
      commandStorage: createMemoryCommandStorage(),
    }))

    const wrapper = await mountRoute('/tabs/home/expenses/groceries?groupId=lake-house-weekend&groupId=another-group')

    expect(wrapper.get('[role="alert"]').text()).toContain('valid group link')
    expect(wrapper.get('[data-action="safe-return"]').attributes('href')).toBe('/tabs/home')
    expect(getById).not.toHaveBeenCalled()
  })

  it('rejects an inaccessible or mismatched expense with an actionable safe return', async () => {
    const wrapper = await mountRoute('/tabs/groups/expenses/groceries?groupId=another-group')

    expect(wrapper.get('[role="alert"]').text()).toContain('not available')
    expect(wrapper.get('[data-action="safe-return"]').attributes('href')).toBe('/tabs/groups')
    expect(wrapper.find('[data-action="edit-expense"]').exists()).toBe(false)
  })

  it('retains a deleted expense with prior audit and disables edit, delete, and new comments', async () => {
    const repository = createDemoRepository()
    await repository.expenses.delete({ kind: 'expense.delete', operationId: 'detail-delete-seed', groupId: 'lake-house-weekend', expenseId: 'cabin-deposit', expectedRevision: 1 })
    setAppSessionForTesting(createAppSession({ repository, commandStorage: createMemoryCommandStorage() }))

    const wrapper = await mountRoute('/tabs/groups/expenses/cabin-deposit?groupId=lake-house-weekend')

    expect(wrapper.get('[data-testid="deleted-state"]').text()).toContain('deleted')
    expect(wrapper.find('[data-action="edit-expense"]').exists()).toBe(false)
    expect(wrapper.find('[data-action="delete-expense"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="comments"]').text()).toContain('Booked the refundable rate')
    expect(wrapper.get('[data-testid="comments"]').text()).toContain('Comments are closed')
    expect(wrapper.get('[aria-labelledby="audit-title"]').findAll('li')).toHaveLength(2)
  })
})

describe('expense detail financial and destructive states', () => {
  it('renders plural payments, attribution, recurrence, notes, and durable attachments', async () => {
    const repository = createDemoRepository({ now: () => '2026-08-31T19:00:00.000Z' })
    const added = await repository.expenses.add({
      kind: 'expense.add', operationId: 'detail-plural', groupId: 'lake-house-weekend', description: 'Shared lodge', date: '2026-08-31',
      total: { currency: 'USD', minorAmount: 10000 },
      payments: [
        { participantId: 'maya-p', money: { currency: 'USD', minorAmount: 6000 } },
        { participantId: 'alex-r', money: { currency: 'USD', minorAmount: 4000 } },
      ],
      allocations: [
        { participantId: 'maya-p', money: { currency: 'USD', minorAmount: 5000 } },
        { participantId: 'alex-r', money: { currency: 'USD', minorAmount: 5000 } },
      ],
      category: 'Lodging', splitMethod: { type: 'equal', participantIds: ['maya-p', 'alex-r'] },
      notes: 'Lake view', attachmentRefs: ['receipts/lodge.jpg'],
      recurrence: { frequency: 'monthly', anchor: { month: 8, day: 31 }, timeZone: 'America/Chicago' },
    })
    if (added.status !== 'saved') throw new Error('Expected demo save')
    setAppSessionForTesting(createAppSession({ repository, commandStorage: createMemoryCommandStorage() }))

    const wrapper = await mountRoute(`/tabs/activity/expenses/${added.expense.id}?groupId=lake-house-weekend`)

    expect(wrapper.get('[aria-labelledby="payers-title"]').text()).toContain('Maya P.')
    expect(wrapper.get('[aria-labelledby="payers-title"]').text()).toContain('$60.00')
    expect(wrapper.get('[aria-labelledby="payers-title"]').text()).toContain('Alex R.')
    expect(wrapper.text()).toContain('Lake view')
    expect(wrapper.text()).toContain('Monthly')
    expect(wrapper.text()).toContain('America/Chicago')
    expect(wrapper.text()).toContain('Receipt attachment')
    expect(wrapper.text()).toContain('Preview unavailable on this device')
    expect(wrapper.text()).not.toContain('receipts/lodge.jpg')
    expect(wrapper.text()).toContain('Created by Maya P.')
    expect(wrapper.get('time').attributes('datetime')).toMatch(/^2026-/)
  })

  it('shows the series creator as author and the materializing manager as the creation-history actor', async () => {
    const source = createDemoRepository()
    const baseExpense = await source.expenses.getById('lake-house-weekend', 'groceries')
    const baseRevision = (await source.expenses.listRevisions('lake-house-weekend', 'groceries'))[0]
    if (!baseExpense || !baseRevision) throw new Error('Expected demo audit fixture')
    const expense = {
      ...baseExpense, id: 'recurring-history', recurringTemplateId: 'monthly-rent',
      recurrence: { frequency: 'monthly' as const, anchor: { month: 8, day: 30 }, timeZone: 'UTC' },
      createdBy: { id: 'series-creator', displayName: 'Series Creator' },
      updatedBy: { id: 'series-manager', displayName: 'Series Manager' },
    }
    const repository: AppRepository = {
      ...source,
      expenses: {
        ...source.expenses,
        getById: async (groupId, expenseId) => groupId === expense.groupId && expenseId === expense.id ? expense : undefined,
        listRevisions: async () => [{
          ...baseRevision, id: 'materialize-token', expenseId: expense.id, operationId: 'materialize-rent',
          actor: { id: 'series-manager', displayName: 'Series Manager' }, expense,
        }],
      },
    }
    setAppSessionForTesting(createAppSession({ repository, commandStorage: createMemoryCommandStorage() }))

    const wrapper = await mountRoute('/tabs/groups/expenses/recurring-history?groupId=lake-house-weekend')

    expect(wrapper.text()).toContain('Created by Series Creator.')
    expect(wrapper.get('[aria-labelledby="audit-title"]').text()).toContain('Series Manager created this expense')
    expect(wrapper.get('[aria-labelledby="audit-title"]').text()).not.toContain('Series Creator created this expense')
  })

  it('renders attachment filename, durability, and a preview action without exposing its internal reference', async () => {
    const repository = createDemoRepository({ now: () => '2026-08-31T19:00:00.000Z' })
    const receipts = createMemoryReceiptStore({ id: () => 'detail-local-receipt' })
    const reference = await receipts.put(new File(['receipt'], 'lake-lodge.jpg', { type: 'image/jpeg' }), { fileName: 'lake-lodge.jpg' })
    const added = await repository.expenses.add({
      kind: 'expense.add', operationId: 'detail-local-file', groupId: 'lake-house-weekend', description: 'Local receipt', date: '2026-08-31',
      total: { currency: 'USD', minorAmount: 1000 }, payments: [{ participantId: 'maya-p', money: { currency: 'USD', minorAmount: 1000 } }],
      allocations: [{ participantId: 'maya-p', money: { currency: 'USD', minorAmount: 1000 } }], category: 'Other',
      splitMethod: { type: 'equal', participantIds: ['maya-p'] }, attachmentRefs: [reference],
    })
    if (added.status !== 'saved') throw new Error('Expected demo save')
    setAppSessionForTesting(createAppSession({ repository, commandStorage: createMemoryCommandStorage(), receipts }))

    const wrapper = await mountRoute(`/tabs/groups/expenses/${added.expense.id}?groupId=lake-house-weekend`)
    expect(wrapper.text()).toContain('lake-lodge.jpg')
    expect(wrapper.text()).toContain('stored only on this device')
    expect(wrapper.find('[data-action="open-expense-attachment"]').exists()).toBe(true)
    expect(wrapper.text()).not.toContain(reference)
  })

  it('summarizes each audit revision diff and keeps the full snapshot expandable', async () => {
    const repository = createDemoRepository({ now: () => '2026-08-31T19:00:00.000Z' })
    const added = await repository.expenses.add({
      kind: 'expense.add', operationId: 'audit-diff-add', groupId: 'lake-house-weekend', description: 'Old lodge', date: '2026-08-31',
      total: { currency: 'USD', minorAmount: 1000 }, payments: [{ participantId: 'maya-p', money: { currency: 'USD', minorAmount: 1000 } }],
      allocations: [{ participantId: 'maya-p', money: { currency: 'USD', minorAmount: 1000 } }], category: 'Lodging',
      splitMethod: { type: 'equal', participantIds: ['maya-p'] }, attachmentRefs: [],
    })
    if (added.status !== 'saved') throw new Error('Expected demo save')
    await repository.expenses.edit({
      kind: 'expense.edit', operationId: 'audit-diff-edit', groupId: 'lake-house-weekend', expenseId: added.expense.id, expectedRevision: 1,
      draft: { groupId: 'lake-house-weekend', description: 'New lodge', date: '2026-08-31', total: { currency: 'USD', minorAmount: 2000 },
        payments: [{ participantId: 'maya-p', money: { currency: 'USD', minorAmount: 2000 } }], allocations: [{ participantId: 'maya-p', money: { currency: 'USD', minorAmount: 2000 } }],
        category: 'Lodging', splitMethod: { type: 'equal', participantIds: ['maya-p'] }, attachmentRefs: [] },
    })
    setAppSessionForTesting(createAppSession({ repository, commandStorage: createMemoryCommandStorage() }))

    const wrapper = await mountRoute(`/tabs/activity/expenses/${added.expense.id}?groupId=lake-house-weekend`)
    const diffs = wrapper.findAll('[data-testid="revision-diff"]')
    expect(diffs.at(-1)?.text()).toContain('description')
    expect(diffs.at(-1)?.text()).toContain('total')
    expect(wrapper.findAll('[data-testid="revision-snapshot"]')).toHaveLength(2)
    expect(wrapper.findAll('[data-testid="revision-snapshot"]').at(-1)?.text()).toContain('Paid by')
    expect(wrapper.findAll('[data-testid="revision-snapshot"]').at(-1)?.text()).toContain('Allocated to')
    expect(wrapper.findAll('[data-testid="revision-snapshot"]').at(-1)?.text()).toContain('Recurrence')
  })

  it.each([
    ['JPY' as const, 1200, '1,200'],
    ['BHD' as const, 1234, '1.234'],
    ['CLF' as const, 12345, '1.2345'],
  ])('formats %s audit snapshot money with its ISO currency exponent', async (currency, minorAmount, expected) => {
    const repository = createDemoRepository({ now: () => '2026-08-31T19:00:00.000Z' })
    const added = await repository.expenses.add({
      kind: 'expense.add', operationId: `audit-${currency.toLowerCase()}`, groupId: 'lake-house-weekend', description: `${currency} audit`, date: '2026-08-31',
      total: { currency, minorAmount }, payments: [{ participantId: 'maya-p', money: { currency, minorAmount } }],
      allocations: [{ participantId: 'maya-p', money: { currency, minorAmount } }], category: 'Other',
      splitMethod: { type: 'equal', participantIds: ['maya-p'] }, attachmentRefs: [],
    })
    if (added.status !== 'saved') throw new Error('Expected demo save')
    setAppSessionForTesting(createAppSession({ repository, commandStorage: createMemoryCommandStorage() }))

    const wrapper = await mountRoute(`/tabs/activity/expenses/${added.expense.id}?groupId=lake-house-weekend`)
    const snapshot = wrapper.get('[data-testid="revision-snapshot"]').text()
    expect(snapshot).toContain(expected)
    expect(snapshot).not.toContain((minorAmount / 100).toFixed(2))
  })

  it('rehydrates the exact failed deletion with Retry and Discard and does not submit a duplicate', async () => {
    const repository = createDemoRepository()
    const queue = new CommandQueue({ originPrincipalKey: principalKey, storage: createMemoryCommandStorage(), handlers: {
      'expense.delete': async () => { throw Object.assign(new Error('offline'), { code: 'unavailable' }) },
    } })
    setAppSessionForTesting({ ...createAppSession({ repository, commandStorage: createMemoryCommandStorage() }), queue })
    const first = await mountRoute('/tabs/groups/expenses/groceries?groupId=lake-house-weekend')
    await first.get('[data-action="delete-expense"]').trigger('click')
    const alert = first.getComponent({ name: 'IonAlert' })
    await alert.props('buttons').find((button: { role?: string }) => button.role === 'destructive').handler()
    await flushPromises()
    first.unmount()

    const recreated = await mountRoute('/tabs/groups/expenses/groceries?groupId=lake-house-weekend')
    expect(recreated.get('[data-testid="delete-state"]').text()).toContain('Deletion failed')
    expect(recreated.find('[data-action="delete-expense"]').exists()).toBe(false)
    expect(recreated.find('[data-action="retry-expense-delete"]').exists()).toBe(true)
    expect(recreated.find('[data-action="discard-expense-delete"]').exists()).toBe(true)
    expect(queue.snapshot().filter(({ envelope }) => envelope.kind === 'expense.delete')).toHaveLength(1)
  })

  it('reconciles a rehydrated pending deletion when it becomes fresh and closes the comment composer', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const repository = createDemoRepository()
    const queue = new CommandQueue({ originPrincipalKey: principalKey, storage: createMemoryCommandStorage(), handlers: {
      'expense.delete': async (command) => {
        if (command.kind !== 'expense.delete') throw new Error('Wrong command')
        await gate
        return repository.expenses.delete(command)
      },
    } })
    setAppSessionForTesting({ ...createAppSession({ repository, commandStorage: createMemoryCommandStorage() }), queue })
    const first = await mountRoute('/tabs/groups/expenses/groceries?groupId=lake-house-weekend')
    await first.get('[data-action="delete-expense"]').trigger('click')
    const alert = first.getComponent({ name: 'IonAlert' })
    void alert.props('buttons').find((button: { role?: string }) => button.role === 'destructive').handler()
    await vi.waitFor(() => expect(queue.snapshot()[0]?.status).toBe('pending'))
    first.unmount()

    const recreated = await mountRoute('/tabs/groups/expenses/groceries?groupId=lake-house-weekend')
    expect(recreated.get('[data-testid="delete-state"]').text()).toContain('Saving deletion')
    release()
    await vi.waitFor(() => expect(queue.snapshot()[0]?.status).toBe('fresh'))
    await vi.waitFor(() => expect(recreated.get('[data-testid="delete-state"]').text()).toContain('Deleted'))
    expect(recreated.get('[data-testid="deleted-state"]').text()).toContain('deleted')
    expect(recreated.get('[data-testid="comments"]').text()).toContain('Comments are closed')
    expect(recreated.find('[data-testid="comments"] form').exists()).toBe(false)
  })

  it('rehydrates a deletion conflict with explicit reload and delete-latest resolution choices', async () => {
    const repository = createDemoRepository()
    const queue = new CommandQueue({ originPrincipalKey: principalKey, storage: createMemoryCommandStorage(), handlers: {
      'expense.delete': async () => { throw new CommandConflictError('Expense changed remotely', { groupId: 'lake-house-weekend', expenseId: 'groceries' }) },
    } })
    setAppSessionForTesting({ ...createAppSession({ repository, commandStorage: createMemoryCommandStorage() }), queue })
    const first = await mountRoute('/tabs/groups/expenses/groceries?groupId=lake-house-weekend')
    await first.get('[data-action="delete-expense"]').trigger('click')
    const alert = first.getComponent({ name: 'IonAlert' })
    await alert.props('buttons').find((button: { role?: string }) => button.role === 'destructive').handler()
    await flushPromises()
    first.unmount()

    const recreated = await mountRoute('/tabs/groups/expenses/groceries?groupId=lake-house-weekend')
    expect(recreated.get('[data-testid="delete-state"]').text()).toContain('Deletion conflict')
    expect(recreated.find('[data-action="reload-expense-delete-conflict"]').exists()).toBe(true)
    expect(recreated.find('[data-action="delete-latest-expense"]').exists()).toBe(true)
    await recreated.get('[data-action="reload-expense-delete-conflict"]').trigger('click')
    await flushPromises()
    expect(queue.snapshot()).toEqual([])
    expect(recreated.find('[data-action="delete-expense"]').exists()).toBe(true)
  })

  it('names the expense in confirmation, defaults to cancel, restores focus, and suppresses duplicate deletion', async () => {
    const wrapper = await mountRoute('/tabs/groups/expenses/groceries?groupId=lake-house-weekend')
    const trigger = wrapper.get('[data-action="delete-expense"]')
    const focus = vi.spyOn(trigger.element as HTMLElement, 'focus')

    await trigger.trigger('click')
    const alert = wrapper.getComponent({ name: 'IonAlert' })
    expect(alert.props('header')).toBe('Delete Groceries?')
    expect(alert.props('buttons')[0]).toMatchObject({ text: 'Cancel', role: 'cancel' })
    alert.vm.$emit('didDismiss', { detail: { role: 'cancel' } })
    await wrapper.vm.$nextTick()
    expect(focus).toHaveBeenCalled()

    await trigger.trigger('click')
    const destructive = alert.props('buttons').find((button: { role?: string }) => button.role === 'destructive')
    const first = destructive.handler()
    const second = destructive.handler()
    await Promise.all([first, second])
    await flushPromises()
    expect(wrapper.get('[data-testid="delete-state"]').text()).toMatch(/Deleted|Saving deletion/)
    expect(wrapper.find('[data-action="delete-expense"]').exists()).toBe(false)
  })
})

async function mountRoute(path: string): Promise<VueWrapper> {
  const router = createAppRouter()
  await router.push(path)
  await router.isReady()
  const wrapper = mount(ExpenseDetailPage, { global: { plugins: [createPinia(), router], stubs: ionicStubs } })
  await flushPromises()
  return wrapper
}
