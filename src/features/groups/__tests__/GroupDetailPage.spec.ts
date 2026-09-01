import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia } from 'pinia'
import type { Component } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAppRouter } from '../../../app/router'
import { CommandQueue, createMemoryCommandStorage } from '../../../data/commandQueue'
import { createDemoRepository } from '../../../data/demoRepository'
import type { ExpenseRow } from '../../../data/repositories'
import { appPrincipalKey, createAppSession, setAppSessionForTesting } from '../../../data/session'
import { lakeHouseGroup } from '../../../demo/lakeHouse'

const ORIGIN_UID = 'maya-p'
const PRINCIPAL_KEY = appPrincipalKey({ mode: 'demo', projectId: 'split-unwise-demo', uid: ORIGIN_UID })
const groupDetailSource = readFileSync(resolve(process.cwd(), 'src/features/groups/GroupDetailPage.vue'), 'utf8')

const ionicStubs = {
  IonPage: { template: '<main class="ion-page"><slot /></main>' },
  IonSplitPane: { template: '<div data-testid="split-pane"><slot /></div>' },
  IonMenu: { template: '<aside><slot /></aside>' },
  IonList: { template: '<div><slot /></div>' },
  IonHeader: { template: '<header><slot /></header>' },
  IonToolbar: { template: '<div><slot /></div>' },
  IonTitle: { template: '<div><slot /></div>' },
  IonButtons: { template: '<div><slot /></div>' },
  IonBackButton: {
    props: ['defaultHref', 'text'],
    template: '<a data-testid="back-button" :href="defaultHref">{{ text }}</a>',
  },
  IonContent: {
    name: 'IonContent',
    emits: ['ionScroll'],
    template: '<section data-testid="content"><slot /></section>',
  },
  IonFooter: { template: '<footer><slot /></footer>' },
  IonSegment: { template: '<nav aria-label="Group view"><slot /></nav>' },
  IonSegmentButton: {
    props: ['value'],
    template: '<button type="button" :data-view="value"><slot /></button>',
  },
  IonLabel: { template: '<span><slot /></span>' },
  IonButton: {
    props: ['routerLink', 'ariaLabel', 'disabled'],
    template: '<a :href="routerLink" :aria-label="ariaLabel" :aria-disabled="disabled || undefined"><slot /></a>',
  },
  IonIcon: { props: ['icon'], template: '<span data-testid="ion-icon" aria-hidden="true" />' },
  IonFab: { template: '<div><slot /></div>' },
  IonFabButton: {
    props: ['routerLink'],
    template: '<a :href="routerLink"><slot /></a>',
  },
  IonSkeletonText: { template: '<span class="skeleton-text"><slot /></span>' },
}

beforeEach(() => {
  setAppSessionForTesting(createAppSession({ repository: createDemoRepository(), commandStorage: createMemoryCommandStorage() }))
})
afterEach(() => { vi.unstubAllGlobals() })

async function mountRoute(path: string): Promise<VueWrapper> {
  const router = createAppRouter()
  await router.push(path)
  await router.isReady()
  const component = router.currentRoute.value.matched.at(-1)?.components?.default as Component | undefined
  if (!component) throw new Error(`No component resolved for ${path}`)

  const wrapper = mount(component, {
    global: {
      plugins: [createPinia(), router],
      stubs: ionicStubs,
    },
  })
  await flushPromises()
  return wrapper
}

describe('Lake House group journal', () => {
  it('does not fetch the desktop group menu on a mobile viewport', async () => {
    const repository = createDemoRepository()
    const list = vi.fn(() => repository.groups.list())
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })))
    setAppSessionForTesting(createAppSession({
      repository: { ...repository, groups: { ...repository.groups, list } },
      commandStorage: createMemoryCommandStorage(),
    }))

    await mountRoute('/tabs/groups/lake-house-weekend')

    expect(list).not.toHaveBeenCalled()
  })

  it('shows the usable group shell while the slower journal is still loading', async () => {
    let releaseActivity!: () => void
    const activityGate = new Promise<readonly never[]>((resolve) => { releaseActivity = () => resolve([]) })
    const repository = createDemoRepository()
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })))
    setAppSessionForTesting(createAppSession({
      repository: {
        ...repository,
        expenses: { ...repository.expenses, async listForGroup() { return activityGate } },
      },
      commandStorage: createMemoryCommandStorage(),
    }))

    const wrapper = await mountRoute('/tabs/groups/lake-house-weekend')

    expect(wrapper.find('[data-testid="group-cover"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="journal-loading"]').attributes('role')).toBe('status')

    releaseActivity()
    await flushPromises()
    expect(wrapper.find('[data-testid="journal-loading"]').exists()).toBe(false)
  })

  it('renders the selected group hierarchy with one newest-first August journal', async () => {
    const wrapper = await mountRoute('/tabs/groups/lake-house-weekend')

    expect(wrapper.get('h1').text()).toBe('Lake House Weekend')
    expect(wrapper.get('[data-testid="group-cover"]').attributes('src')).toBe(lakeHouseGroup.coverImageUrl)
    expect(wrapper.find('[data-testid="group-split-pane"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="group-monogram"]').text()).toBe('LW')
    expect(wrapper.get('[data-testid="group-balance"]').text()).toContain('You are owed')
    expect(wrapper.get('[data-testid="group-balance"]').text()).toContain('$36.25')
    expect(wrapper.text()).not.toContain('$137.07')

    const dividers = wrapper.findAll('[data-testid="month-divider"]')
    expect(dividers).toHaveLength(1)
    expect(dividers[0].text()).toBe('August 2026')
    expect(wrapper.findAll('[data-expense-id]').map((row) => row.attributes('data-expense-id'))).toEqual([
      'groceries',
      'kayak-rental',
      'cabin-deposit',
      'dinner',
      'gas-for-the-boat',
    ])
  })

  it.each([
    ['groceries', 'you lent', '$127.50'],
    ['kayak-rental', 'you borrowed', '$15.00'],
    ['cabin-deposit', 'you borrowed', '$100.00'],
    ['dinner', 'you borrowed', '$18.25'],
    ['gas-for-the-boat', 'you lent', '$42.00'],
  ])('derives Maya’s truthful position for %s from payer and allocations', async (expenseId, direction, amount) => {
    const wrapper = await mountRoute('/tabs/groups/lake-house-weekend')
    const row = wrapper.get(`[data-expense-id="${expenseId}"]`)

    expect(row.text()).toContain(direction)
    expect(row.text()).toContain(amount)
  })

  it('provides working group actions and an accessible group-scoped add action', async () => {
    const wrapper = await mountRoute('/tabs/groups/lake-house-weekend')

    expect(wrapper.get('[data-action="settle-up"]').attributes('href')).toBe('/tabs/groups/lake-house-weekend/settle-up')
    expect(wrapper.get('[data-action="balances"]').attributes('href')).toBe('/tabs/groups/lake-house-weekend/balances')
    expect(wrapper.get('[data-action="invite"]').attributes('href')).toBe('/tabs/groups/lake-house-weekend/invite')
    expect(wrapper.find('[data-action="totals"]').exists()).toBe(false)
    await wrapper.get('[data-action="more"]').trigger('click')
    expect(wrapper.get('[data-action="totals"]').attributes('href')).toBe('/tabs/groups/lake-house-weekend/totals')
    expect(wrapper.get('[data-action="charts"]').attributes('href')).toBe('/tabs/groups/lake-house-weekend/charts')
    expect(wrapper.get('[data-action="convert"]').attributes('href')).toBe('/tabs/groups/lake-house-weekend/convert')
    expect(wrapper.get('[data-action="export"]').attributes('href')).toBe('/tabs/groups/lake-house-weekend/export')
    expect(wrapper.get('[aria-label="Add expense"]').attributes('href')).toBe('/tabs/groups/expenses/new?groupId=lake-house-weekend')
  })

  it('links durable journal expenses to the Groups-origin detail route', async () => {
    const wrapper = await mountRoute('/tabs/groups/lake-house-weekend')

    expect(wrapper.get('[data-expense-id="groceries"] a.expense-row__body').attributes('href')).toBe('/tabs/groups/expenses/groceries?groupId=lake-house-weekend')
  })

  it('switches between the expense journal and repository activity', async () => {
    const wrapper = await mountRoute('/tabs/groups/lake-house-weekend')

    expect(wrapper.find('[data-testid="expense-journal"]').exists()).toBe(true)
    await wrapper.get('[data-view="activity"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="expense-journal"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="group-activity"]').text()).toContain('Maya P. added Groceries')

    await wrapper.get('[data-view="expenses"]').trigger('click')
    expect(wrapper.find('[data-testid="expense-journal"]').exists()).toBe(true)
  })

  it('shares the durable queue projection and groups Activity by its own submission date', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolveGate) => { release = resolveGate })
    const repository = createDemoRepository()
    const queue = new CommandQueue({
      originPrincipalKey: PRINCIPAL_KEY,
      storage: createMemoryCommandStorage(),
      now: () => '2026-09-02T18:30:00.000Z',
      handlers: { 'comment.add': async (command) => {
        if (command.kind !== 'comment.add') throw new Error('Unexpected command')
        await gate
        return repository.comments.add(command)
      } },
    })
    setAppSessionForTesting({ ...createAppSession({ repository, commandStorage: createMemoryCommandStorage() }), queue })
    const wrapper = await mountRoute('/tabs/groups/lake-house-weekend')
    const handle = queue.submit({ kind: 'comment.add', operationId: 'group-pending-comment', groupId: 'lake-house-weekend', expenseId: 'groceries', body: 'Pending group note', attachmentRefs: [] })
    await vi.waitFor(() => expect(queue.get('group-pending-comment')?.status).toBe('pending'))
    await wrapper.get('[data-view="activity"]').trigger('click')
    await flushPromises()

    const pending = wrapper.get('[data-activity-id="pending:group-pending-comment"]')
    expect(pending.attributes('data-sync-state')).toBe('pending')
    expect(pending.get('time').attributes('datetime')).toBe('2026-09-02T18:30:00.000Z')
    expect(wrapper.get('[data-testid="activity-date-divider"]').text()).toContain('September 2, 2026')
    expect(wrapper.find('[data-testid="month-divider"]').exists()).toBe(false)

    release()
    await handle.result()
  })

  it('refreshes on Ionic view entry and gives linked Activity rows a full tap target', () => {
    expect(groupDetailSource).toContain('onIonViewWillEnter')
    expect(groupDetailSource).toContain('class="activity-list__body"')
    expect(groupDetailSource).toMatch(/\.activity-list__body\s*\{[^}]*min-height:\s*44px/s)
  })

  it('keeps the routed Ionic page as the native navigation root', () => {
    expect(groupDetailSource).not.toContain('<ion-split-pane')
    expect(groupDetailSource).not.toContain('class="ion-page group-detail__detail"')
    expect(groupDetailSource).toMatch(/<ion-page[^>]*>\s*<ion-header/s)
  })

  it('marks the hero collapsed after the journal scroll threshold', async () => {
    const wrapper = await mountRoute('/tabs/groups/lake-house-weekend')

    wrapper.findAllComponents({ name: 'IonContent' })[0].vm.$emit('ionScroll', { detail: { scrollTop: 96 } })
    await wrapper.vm.$nextTick()
    expect(wrapper.get('[data-testid="group-detail"]').classes()).toContain('group-detail--collapsed')
  })

  it('uses the mode-aware selected foreground for the journal segment', () => {
    expect(groupDetailSource).toContain('--color-checked: var(--ion-color-primary)')
    expect(groupDetailSource).not.toContain('--color-checked: var(--su-accent)')
  })

  it('renders both conflict versions and wires Reload remote to the journal store resolution', async () => {
    const repository = createDemoRepository()
    const groceries = await repository.expenses.getById('lake-house-weekend', 'groceries')
    if (!groceries) throw new Error('Missing fixture expense')
    const queue = new CommandQueue({
      originPrincipalKey: PRINCIPAL_KEY,
      storage: createMemoryCommandStorage(),
      handlers: { 'expense.edit': async (envelope) => {
        if (envelope.kind !== 'expense.edit') throw new Error('Unexpected command')
        return repository.expenses.edit(envelope)
      } },
    })
    setAppSessionForTesting({ ...createAppSession({ repository, commandStorage: createMemoryCommandStorage() }), queue })
    await expect(queue.submit({
      kind: 'expense.edit', operationId: 'page-conflict', groupId: groceries.groupId, expenseId: groceries.id, expectedRevision: 0, draft: expenseDraft(groceries, 'My page draft'),
    }).result()).rejects.toThrow('changed remotely')

    const wrapper = await mountRoute('/tabs/groups/lake-house-weekend')
    const conflicted = wrapper.get('[data-expense-id="groceries"]')
    expect(conflicted.get('[data-testid="local-conflict-version"]').text()).toContain('My page draft')
    expect(conflicted.get('[data-testid="remote-conflict-version"]').text()).toContain('Groceries')
    expect(conflicted.find('[data-action="retry-expense"]').exists()).toBe(false)
    expect(conflicted.find('[data-action="discard-expense"]').exists()).toBe(false)

    await conflicted.get('[data-action="reload-remote"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-expense-id="groceries"]').text()).toContain('Groceries')
    expect(wrapper.find('[data-testid="local-conflict-version"]').exists()).toBe(false)
  })

  it('renders a delete conflict as delete intent and wires deleting the latest version', async () => {
    const repository = createDemoRepository({ now: () => '2026-08-30T14:00:00.000Z' })
    const groceries = await repository.expenses.getById('lake-house-weekend', 'groceries')
    if (!groceries) throw new Error('Missing fixture expense')
    await repository.expenses.edit({
      kind: 'expense.edit', operationId: 'page-remote-edit', groupId: groceries.groupId, expenseId: groceries.id, expectedRevision: 1, draft: expenseDraft(groceries, 'Remote page groceries'),
    })
    const queue = new CommandQueue({
      originPrincipalKey: PRINCIPAL_KEY,
      storage: createMemoryCommandStorage(),
      handlers: { 'expense.delete': async (envelope) => {
        if (envelope.kind !== 'expense.delete') throw new Error('Unexpected command')
        return repository.expenses.delete(envelope)
      } },
    })
    setAppSessionForTesting({ ...createAppSession({ repository, commandStorage: createMemoryCommandStorage() }), queue })
    await expect(queue.submit({ kind: 'expense.delete', operationId: 'page-delete-conflict', groupId: groceries.groupId, expenseId: groceries.id, expectedRevision: 1 }).result()).rejects.toThrow('changed remotely')

    const wrapper = await mountRoute('/tabs/groups/lake-house-weekend')
    const conflicted = wrapper.get('[data-expense-id="groceries"]')
    expect(conflicted.get('[data-testid="local-conflict-version"]').text()).toContain('Delete requested')
    expect(conflicted.find('[data-action="retain-save-local"]').exists()).toBe(false)

    await conflicted.get('[data-action="delete-remote"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-expense-id="groceries"]').exists()).toBe(false)
  })
})

describe('route-specific browse pages', () => {
  it.each([
    ['/tabs/home', 'Home'],
    ['/tabs/groups', 'Groups'],
    ['/tabs/activity', 'Activity'],
    ['/tabs/account', 'Account'],
    ['/tabs/groups/expenses/new?groupId=lake-house-weekend', 'Add expense'],
  ])('renders %s with its own accessible heading', async (path, heading) => {
    const wrapper = await mountRoute(path)

    expect(wrapper.get('h1').text()).toBe(heading)
  })

  it.each(['/tabs/home', '/tabs/groups'])('links the Lake House group from %s', async (path) => {
    const wrapper = await mountRoute(path)

    expect(wrapper.get('[data-testid="lake-house-link"]').attributes('href')).toBe('/tabs/groups/lake-house-weekend')
  })
})

function expenseDraft(expense: ExpenseRow, description: string) {
  return {
    groupId: expense.groupId,
    description,
    date: expense.date,
    total: { ...expense.total },
    payments: expense.payments.map((payment) => ({ participantId: payment.participantId, money: { ...payment.money } })),
    allocations: expense.allocations.map((allocation) => ({ participantId: allocation.participantId, money: { ...allocation.money } })),
    category: expense.category,
    splitMethod: JSON.parse(JSON.stringify(expense.splitMethod)) as ExpenseRow['splitMethod'],
    attachmentRefs: [...expense.attachmentRefs],
  }
}
