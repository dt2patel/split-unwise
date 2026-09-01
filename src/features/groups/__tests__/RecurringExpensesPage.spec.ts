import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAppRouter } from '../../../app/router'
import { createMemoryCommandStorage } from '../../../data/commandQueue'
import { createDemoRepository } from '../../../data/demoRepository'
import type { AppRepository, CommandEnvelope, CommandResult, ExpenseRow, Group, MaterializeDueResult, RecurringExpense } from '../../../data/repositories'
import { createAppSession, setAppSessionForTesting } from '../../../data/session'
import { lakeHouseExpenses, lakeHouseGroup, lakeHouseRecurring } from '../../../demo/lakeHouse'
import RecurringExpensesPage from '../RecurringExpensesPage.vue'

const recurringPageSource = readFileSync(resolve(process.cwd(), 'src/features/groups/RecurringExpensesPage.vue'), 'utf8')
const ionicLifecycle = vi.hoisted(() => ({ willEnter: [] as Array<() => void> }))

vi.mock('@ionic/vue', async () => {
  const actual = await vi.importActual<typeof import('@ionic/vue')>('@ionic/vue')
  return {
    ...actual,
    onIonViewWillEnter(callback: () => void) { ionicLifecycle.willEnter.push(callback) },
  }
})

const ionicStubs = {
  IonPage: { template: '<main class="ion-page"><slot /></main>' },
  IonHeader: { template: '<header><slot /></header>' },
  IonToolbar: { template: '<div><slot /></div>' },
  IonTitle: { template: '<div><slot /></div>' },
  IonButtons: { template: '<div><slot /></div>' },
  IonBackButton: { props: ['defaultHref', 'text'], template: '<a data-testid="recurring-back" :href="defaultHref">{{ text }}</a>' },
  IonButton: {
    props: ['routerLink', 'disabled', 'ariaLabel'],
    template: '<a v-if="routerLink" :href="routerLink" :aria-label="ariaLabel" :aria-disabled="disabled || undefined"><slot /></a><button v-else type="button" :disabled="disabled" :aria-label="ariaLabel"><slot /></button>',
  },
  IonContent: { template: '<section><slot /></section>' },
  IonIcon: { props: ['icon'], template: '<span aria-hidden="true" />' },
  IonSkeletonText: { template: '<span class="skeleton-text"><slot /></span>' },
  IonAlert: { name: 'IonAlert', props: ['isOpen', 'header', 'message', 'buttons'], emits: ['didDismiss'], template: '<div v-if="isOpen" data-testid="cancel-recurrence-alert" />' },
}

beforeEach(() => {
  ionicLifecycle.willEnter.length = 0
  const repository = createDemoRepository()
  setSession({
    ...repository,
    groups: {
      ...repository.groups,
      async materializeDue() { return { occurrences: [], moreRemain: false } },
    },
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('recurring expense management page states', () => {
  it('shows native loading skeletons before the first usable group and list state resolves', async () => {
    let releaseGroup!: (group: Group | undefined) => void
    const groupGate = new Promise<Group | undefined>((resolveGate) => { releaseGroup = resolveGate })
    const repository = createDemoRepository()
    setSession({
      ...repository,
      groups: {
        ...repository.groups,
        async getById() { return groupGate },
        async materializeDue() { return { occurrences: [], moreRemain: false } },
      },
    })

    const wrapper = await mountRecurring(false)
    await wrapper.vm.$nextTick()

    expect(wrapper.get('[data-testid="recurring-loading"]').attributes('role')).toBe('status')
    expect(wrapper.findAll('.recurring-skeleton__card')).toHaveLength(3)

    releaseGroup(lakeHouseGroup)
    await flushPromises()
    expect(wrapper.find('[data-testid="recurring-loading"]').exists()).toBe(false)
  })

  it('renders the first usable recurring list while catch-up is still gated', async () => {
    let releaseCatchUp!: (result: MaterializeDueResult) => void
    const catchUpGate = new Promise<MaterializeDueResult>((resolveGate) => { releaseCatchUp = resolveGate })
    const repository = createDemoRepository()
    setSession({
      ...repository,
      groups: {
        ...repository.groups,
        async materializeDue() { return catchUpGate },
      },
    })

    const wrapper = await mountRecurring(false)
    await flushPromises()

    expect(wrapper.find('[data-testid="recurring-loading"]').exists()).toBe(false)
    expect(wrapper.get('[data-template-id="cabin-deposit-monthly"]').text()).toContain('Cabin deposit')
    expect(wrapper.get('.catch-up-message').text()).toContain('Checking for due expenses')

    releaseCatchUp({ occurrences: [], moreRemain: false })
    await flushPromises()
  })

  it('renders an empty state with the exact group-scoped Add expense route and no premium fan-out', async () => {
    const repository = createDemoRepository()
    const activity = vi.fn(repository.activity.listForGroup)
    const listGroups = vi.fn(repository.groups.list)
    const getTotals = vi.fn(repository.groups.getTotals)
    const getCharts = vi.fn(repository.groups.getCharts)
    const getBalanceSnapshot = vi.fn(repository.groups.getBalanceSnapshot)
    setSession({
      ...repository,
      groups: {
        ...repository.groups,
        list: listGroups,
        getTotals,
        getCharts,
        getBalanceSnapshot,
        async listRecurring() { return [] },
        async materializeDue() { return { occurrences: [], moreRemain: false } },
      },
      expenses: { ...repository.expenses, async listForGroup() { return [] } },
      activity: { ...repository.activity, listForGroup: activity },
    })

    const wrapper = await mountRecurring()

    expect(wrapper.get('[data-testid="recurring-empty"]').text()).toContain('No recurring expenses yet')
    expect(wrapper.get('[data-action="add-recurring-expense"]').attributes('href')).toBe('/tabs/groups/expenses/new?groupId=lake-house-weekend')
    expect(wrapper.get('[data-testid="recurring-back"]').attributes('href')).toBe('/tabs/groups/lake-house-weekend')
    expect(activity).not.toHaveBeenCalled()
    expect(listGroups).not.toHaveBeenCalled()
    expect(getTotals).not.toHaveBeenCalled()
    expect(getCharts).not.toHaveBeenCalled()
    expect(getBalanceSnapshot).not.toHaveBeenCalled()
  })

  it('shows an actionable load error and retries the same verified group without an account scan', async () => {
    const repository = createDemoRepository()
    let attempt = 0
    const listRecurring = vi.fn(async () => {
      attempt += 1
      if (attempt === 1) throw new Error('Recurring list is offline')
      return []
    })
    const listGroups = vi.fn(repository.groups.list)
    setSession({
      ...repository,
      groups: {
        ...repository.groups,
        list: listGroups,
        listRecurring,
        async materializeDue() { return { occurrences: [], moreRemain: false } },
      },
      expenses: { ...repository.expenses, async listForGroup() { return [] } },
    })

    const wrapper = await mountRecurring()

    expect(wrapper.get('[data-testid="recurring-load-error"]').attributes('role')).toBe('alert')
    expect(wrapper.get('[data-testid="recurring-load-error"]').text()).toContain('Recurring list is offline')
    await wrapper.get('[data-action="retry-recurring-load"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-testid="recurring-load-error"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="recurring-empty"]').exists()).toBe(true)
    expect(listGroups).not.toHaveBeenCalled()
  })

  it('renders active and stopped cards with ISO-aware money, human frequency, next date, creator, and source/frontier links', async () => {
    const repository = createDemoRepository()
    const templates: readonly RecurringExpense[] = [
      recurringTemplate({
        id: 'weekly-lake-pass', description: 'Lake pass', recurrence: { frequency: 'weekly', anchor: { month: 8, day: 25 }, timeZone: 'America/Chicago' },
        anchorDate: '2026-08-25', nextDate: '2026-09-08', lastOccurrenceId: 'weekly-lake-pass-source', lastOccurrenceDate: '2026-09-01',
      }),
      recurringTemplate({
        id: 'fortnightly-supplies', description: 'Supplies', recurrence: { frequency: 'fortnightly', anchor: { month: 8, day: 26 }, timeZone: 'America/Chicago' },
        anchorDate: '2026-08-26', nextDate: '2026-09-09',
      }),
      recurringTemplate({
        description: 'Cabin deposit', total: { currency: 'BHD', minorAmount: 1234 },
        payments: [{ participantId: 'alex-r', money: { currency: 'BHD', minorAmount: 1234 } }],
        allocations: [{ participantId: 'alex-r', money: { currency: 'BHD', minorAmount: 617 } }, { participantId: 'maya-p', money: { currency: 'BHD', minorAmount: 617 } }],
      }),
      recurringTemplate({
        id: 'yearly-permit', description: 'Yearly permit', status: 'cancelled', recurrence: { frequency: 'yearly', anchor: { month: 8, day: 28 }, timeZone: 'America/Chicago' },
        anchorDate: '2026-08-28', nextDate: '2027-08-28',
      }),
    ]
    setSession({
      ...repository,
      groups: {
        ...repository.groups,
        async listRecurring() { return templates },
        async materializeDue() { return { occurrences: [], moreRemain: false } },
      },
    })

    const wrapper = await mountRecurring()
    const weekly = wrapper.get('[data-template-id="weekly-lake-pass"]')
    const fortnightly = wrapper.get('[data-template-id="fortnightly-supplies"]')
    const monthly = wrapper.get('[data-template-id="cabin-deposit-monthly"]')
    const yearly = wrapper.get('[data-template-id="yearly-permit"]')

    expect(weekly.text()).toContain('Weekly')
    expect(weekly.get('[data-testid="recurring-next-date"]').attributes('datetime')).toBe('2026-09-08')
    expect(weekly.get('[data-testid="recurring-next-date"]').text()).toMatch(/Sep.*8.*2026/)
    expect(weekly.get('[data-action="view-recurring-expense"]').attributes('href')).toBe('/tabs/groups/expenses/weekly-lake-pass-source?groupId=lake-house-weekend')
    expect(fortnightly.text()).toContain('Every 2 weeks')
    expect(monthly.text()).toContain('Monthly')
    expect(monthly.text()).toContain('1.234')
    expect(monthly.text()).not.toContain('12.34')
    expect(monthly.text()).toContain('Created by Alex R.')
    expect(monthly.get('[data-action="view-recurring-expense"]').attributes('href')).toBe('/tabs/groups/expenses/cabin-deposit?groupId=lake-house-weekend')
    expect(monthly.get('[data-action="edit-recurring-expense"]').attributes('href')).toBe('/tabs/groups/expenses/cabin-deposit/edit?groupId=lake-house-weekend')
    expect(yearly.text()).toContain('Yearly')
    expect(yearly.text()).toContain('Stopped')
    expect(yearly.text()).toContain('Past expenses remain')
    expect(yearly.find('[data-testid="recurring-next-date"]').exists()).toBe(false)
  })

  it('does not let the series creator edit when another member owns the current frontier expense', async () => {
    const repository = createDemoRepository({ currentUserId: 'alex-r' })
    const source = recurringSourceExpense()
    const frontier = recurringOccurrenceExpense({ createdBy: { id: 'jordan-k', displayName: 'Jordan K.' }, updatedBy: { id: 'jordan-k', displayName: 'Jordan K.' } })
    const template = recurringTemplate({
      lastOccurrenceId: frontier.id,
      lastOccurrenceDate: frontier.date,
      nextDate: '2026-10-28',
      revision: 2,
    })
    setSession({
      ...repository,
      groups: {
        ...repository.groups,
        async listRecurring() { return [template] },
        async materializeDue() { return { occurrences: [], moreRemain: false } },
      },
      expenses: { ...repository.expenses, async listForGroup() { return [source, frontier] } },
    })

    const wrapper = await mountRecurring()
    const card = wrapper.get(`[data-template-id="${template.id}"]`)

    expect(card.find('[data-action="cancel-recurrence"]').exists()).toBe(true)
    expect(card.find('[data-action="edit-recurring-expense"]').exists()).toBe(false)
  })

  it('lets a non-manager current frontier creator edit future expenses without granting cancellation', async () => {
    const repository = createDemoRepository({ currentUserId: 'jordan-k' })
    const source = recurringSourceExpense()
    const frontier = recurringOccurrenceExpense({ createdBy: { id: 'jordan-k', displayName: 'Jordan K.' }, updatedBy: { id: 'jordan-k', displayName: 'Jordan K.' } })
    const template = recurringTemplate({
      lastOccurrenceId: frontier.id,
      lastOccurrenceDate: frontier.date,
      nextDate: '2026-10-28',
      revision: 2,
    })
    setSession({
      ...repository,
      groups: {
        ...repository.groups,
        async listRecurring() { return [template] },
        async materializeDue() { return { occurrences: [], moreRemain: false } },
      },
      expenses: { ...repository.expenses, async listForGroup() { return [source, frontier] } },
    })

    const wrapper = await mountRecurring()
    const card = wrapper.get(`[data-template-id="${template.id}"]`)

    expect(card.get('[data-action="edit-recurring-expense"]').attributes('href')).toBe(`/tabs/groups/expenses/${frontier.id}/edit?groupId=lake-house-weekend`)
    expect(card.find('[data-action="cancel-recurrence"]').exists()).toBe(false)
  })

  it('fails closed for Edit future when the declared frontier expense is not in the confirmed list', async () => {
    const repository = createDemoRepository({ currentUserId: 'maya-p' })
    const template = recurringTemplate({
      lastOccurrenceId: 'occ_cabin-deposit-monthly_2026-09-28',
      lastOccurrenceDate: '2026-09-28',
      nextDate: '2026-10-28',
      revision: 2,
    })
    setSession({
      ...repository,
      groups: {
        ...repository.groups,
        async listRecurring() { return [template] },
        async materializeDue() { return { occurrences: [], moreRemain: false } },
      },
      expenses: { ...repository.expenses, async listForGroup() { return [recurringSourceExpense()] } },
    })

    const wrapper = await mountRecurring()

    expect(wrapper.find('[data-action="edit-recurring-expense"]').exists()).toBe(false)
  })
})

describe('recurring catch-up and cancellation', () => {
  it('uses the local calendar date, caps catch-up at 24, refreshes templates, and shows a distinct remainder warning', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 8, 1, 23, 30, 0))
    const repository = createDemoRepository()
    const posted = lakeHouseExpenses[0]
    if (!posted) throw new Error('Missing occurrence fixture')
    const listRecurring = vi.fn(async () => lakeHouseRecurring)
    const materializeDue = vi.fn(async (): Promise<MaterializeDueResult> => ({ occurrences: Array.from({ length: 24 }, () => posted), moreRemain: true }))
    setSession({
      ...repository,
      groups: { ...repository.groups, listRecurring, materializeDue },
    })

    const wrapper = await mountRecurring()

    expect(materializeDue).toHaveBeenCalledWith('lake-house-weekend', '2026-09-01', 24)
    expect(listRecurring).toHaveBeenCalledTimes(2)
    const cap = wrapper.get('[data-testid="catch-up-cap"]')
    expect(cap.attributes('role')).toBe('alert')
    expect(cap.text()).toContain('24')
    expect(cap.text()).toContain('More recurring expenses are still due')
  })

  it('announces posted occurrences without claiming that more remain', async () => {
    const repository = createDemoRepository()
    const posted = lakeHouseExpenses[0]
    if (!posted) throw new Error('Missing occurrence fixture')
    setSession({
      ...repository,
      groups: {
        ...repository.groups,
        async materializeDue() { return { occurrences: [posted, posted], moreRemain: false } },
      },
    })

    const wrapper = await mountRecurring()

    expect(wrapper.get('[data-testid="catch-up-status"]').attributes('role')).toBe('status')
    expect(wrapper.get('[data-testid="catch-up-status"]').text()).toContain('2 due expenses were added')
    expect(wrapper.find('[data-testid="catch-up-cap"]').exists()).toBe(false)
  })

  it('reconciles and announces confirmed partial postings when a later due series rejects catch-up', async () => {
    const repository = createDemoRepository()
    const source = recurringSourceExpense()
    const posted = recurringOccurrenceExpense()
    const initialTemplate = recurringTemplate()
    const advancedTemplate: RecurringExpense = {
      ...initialTemplate,
      lastOccurrenceId: posted.id,
      lastOccurrenceDate: posted.date,
      nextDate: '2026-10-28',
      revision: 2,
    }
    let partialPostingConfirmed = false
    const listRecurring = vi.fn(async () => partialPostingConfirmed ? [advancedTemplate] : [initialTemplate])
    const listForGroup = vi.fn(async () => partialPostingConfirmed ? [source, posted] : [source])
    setSession({
      ...repository,
      groups: {
        ...repository.groups,
        listRecurring,
        async materializeDue() {
          partialPostingConfirmed = true
          throw new Error('A later series has a removed participant')
        },
      },
      expenses: { ...repository.expenses, listForGroup },
    })

    const wrapper = await mountRecurring()

    expect(listRecurring).toHaveBeenCalledTimes(2)
    expect(listForGroup).toHaveBeenCalledTimes(2)
    expect(wrapper.get('[data-testid="catch-up-status"]').text()).toContain('1 due expense was added before catch-up stopped')
    const catchUpError = wrapper.get('[data-action="retry-catch-up"]').element.closest('[role="alert"]')
    expect(catchUpError?.textContent).toContain('A later series has a removed participant')
    expect(wrapper.get('[data-action="view-recurring-expense"]').attributes('href')).toBe(`/tabs/groups/expenses/${posted.id}?groupId=lake-house-weekend`)
  })

  it('announces a reconciled recurring-state change without claiming that a new expense posted', async () => {
    const repository = createDemoRepository()
    const source = recurringSourceExpense()
    const initialTemplate = recurringTemplate()
    const cancelledTemplate: RecurringExpense = { ...initialTemplate, status: 'cancelled', revision: 2 }
    let changedRemotely = false
    setSession({
      ...repository,
      groups: {
        ...repository.groups,
        async listRecurring() { return changedRemotely ? [cancelledTemplate] : [initialTemplate] },
        async materializeDue() {
          changedRemotely = true
          throw new Error('The recurring series changed remotely')
        },
      },
      expenses: { ...repository.expenses, async listForGroup() { return [source] } },
    })

    const wrapper = await mountRecurring()

    expect(wrapper.get('[data-template-id="cabin-deposit-monthly"]').text()).toContain('Stopped')
    expect(wrapper.get('[data-testid="catch-up-status"]').text()).toContain('Recurring expenses changed before catch-up stopped')
    expect(wrapper.get('[data-testid="catch-up-status"]').text()).not.toContain('due expense was added')
    expect(wrapper.find('[data-action="retry-catch-up"]').exists()).toBe(true)
  })

  it('lets the creator confirm a durable exact-revision cancellation and refreshes to stopped while preserving history copy', async () => {
    vi.stubGlobal('crypto', { randomUUID: () => '00000000-0000-4000-8000-000000000004' })
    const repository = createDemoRepository({ currentUserId: 'alex-r' })
    const active = recurringTemplate({ revision: 7 })
    const stopped: RecurringExpense = { ...active, status: 'cancelled', revision: 8 }
    let templates: readonly RecurringExpense[] = [active]
    let releaseSave!: () => void
    const saveGate = new Promise<void>((resolveGate) => { releaseSave = resolveGate })
    const execute = vi.fn(async (command: CommandEnvelope): Promise<CommandResult> => {
      if (command.kind !== 'recurrence.cancel') return repository.commands.execute(command)
      await saveGate
      templates = [stopped]
      return { kind: command.kind, operationId: command.operationId, status: 'saved', template: stopped }
    })
    const listRecurring = vi.fn(async () => templates)
    setSession({
      ...repository,
      groups: {
        ...repository.groups,
        listRecurring,
        async materializeDue() { return { occurrences: [], moreRemain: false } },
      },
      commands: { execute },
    })

    const wrapper = await mountRecurring()
    const callsBeforeCancellation = listRecurring.mock.calls.length
    await wrapper.get('[data-action="cancel-recurrence"]').trigger('click')
    const alert = wrapper.getComponent({ name: 'IonAlert' })
    expect(alert.props('message')).toContain('Future expenses will stop')
    expect(alert.props('message')).toContain('Past expenses will remain')
    const stopButton = (alert.props('buttons') as Array<{ role?: string; handler?: () => Promise<void> }>).find(({ role }) => role === 'destructive')
    expect(stopButton).toBeDefined()

    const saving = stopButton?.handler?.()
    await flushPromises()
    expect(wrapper.get('[data-testid="recurrence-operation"]').attributes('role')).toBe('status')
    expect(wrapper.get('[data-testid="recurrence-operation"]').text()).toContain('Stopping future expenses')
    expect(execute).toHaveBeenCalledWith({
      kind: 'recurrence.cancel',
      operationId: 'recurrence-cancel-00000000-0000-4000-8000-000000000004',
      groupId: 'lake-house-weekend',
      templateId: 'cabin-deposit-monthly',
      expectedRevision: 7,
    })

    releaseSave()
    await saving
    await flushPromises()

    expect(listRecurring).toHaveBeenCalledTimes(callsBeforeCancellation + 1)
    expect(wrapper.get('[data-testid="recurrence-operation"]').text()).toContain('Future expenses stopped')
    expect(wrapper.get('[data-testid="recurrence-operation"]').text()).toContain('Past expenses remain')
    expect(wrapper.get('[data-template-id="cabin-deposit-monthly"]').text()).toContain('Stopped')
  })

  it('keeps a saved cancellation truthful when the follow-up list refresh fails', async () => {
    const repository = createDemoRepository({ currentUserId: 'alex-r' })
    const active = recurringTemplate({ revision: 7 })
    const stopped: RecurringExpense = { ...active, status: 'cancelled', revision: 8 }
    let listCalls = 0
    const listRecurring = vi.fn(async () => {
      listCalls += 1
      if (listCalls > 2) throw new Error('Recurring list refresh is offline')
      return [active]
    })
    const execute = vi.fn(async (command: CommandEnvelope): Promise<CommandResult> => {
      if (command.kind !== 'recurrence.cancel') return repository.commands.execute(command)
      return { kind: command.kind, operationId: command.operationId, status: 'saved', template: stopped }
    })
    setSession({
      ...repository,
      groups: {
        ...repository.groups,
        listRecurring,
        async materializeDue() { return { occurrences: [], moreRemain: false } },
      },
      commands: { execute },
    })

    const wrapper = await mountRecurring()
    await wrapper.get('[data-action="cancel-recurrence"]').trigger('click')
    const alert = wrapper.getComponent({ name: 'IonAlert' })
    const stopButton = (alert.props('buttons') as Array<{ role?: string; handler?: () => Promise<void> }>).find(({ role }) => role === 'destructive')
    await stopButton?.handler?.()
    await flushPromises()

    expect(wrapper.get('[data-template-id="cabin-deposit-monthly"]').text()).toContain('Stopped')
    expect(wrapper.find('[data-action="cancel-recurrence"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="recurrence-operation"]').text()).toContain('Future expenses stopped')
    expect(wrapper.get('[data-testid="recurrence-operation-error"]').attributes('role')).toBe('alert')
    expect(wrapper.get('[data-testid="recurrence-operation-error"]').text()).toContain('latest recurring list could not be refreshed')
  })

  it('permits a current manager but gives another active member a read-only explanation', async () => {
    const managerRepository = createDemoRepository({ currentUserId: 'maya-p' })
    setSession({
      ...managerRepository,
      groups: { ...managerRepository.groups, async materializeDue() { return { occurrences: [], moreRemain: false } } },
    })
    const manager = await mountRecurring()
    expect(manager.find('[data-action="cancel-recurrence"]').exists()).toBe(true)
    manager.unmount()

    const memberRepository = createDemoRepository({ currentUserId: 'jordan-k' })
    setSession({
      ...memberRepository,
      groups: { ...memberRepository.groups, async materializeDue() { return { occurrences: [], moreRemain: false } } },
    })
    const member = await mountRecurring()
    expect(member.find('[data-action="cancel-recurrence"]').exists()).toBe(false)
    expect(member.get('[data-testid="recurrence-permission"]').text()).toContain('Only the series creator or a group manager')
  })

  it('surfaces a failed durable cancellation accessibly and makes the active action available again', async () => {
    const repository = createDemoRepository({ currentUserId: 'alex-r' })
    const execute = vi.fn(async (command: CommandEnvelope): Promise<CommandResult> => {
      if (command.kind === 'recurrence.cancel') throw new Error('Connection lost while stopping the series')
      return repository.commands.execute(command)
    })
    setSession({
      ...repository,
      groups: { ...repository.groups, async materializeDue() { return { occurrences: [], moreRemain: false } } },
      commands: { execute },
    })

    const wrapper = await mountRecurring()
    await wrapper.get('[data-action="cancel-recurrence"]').trigger('click')
    const alert = wrapper.getComponent({ name: 'IonAlert' })
    const stopButton = (alert.props('buttons') as Array<{ role?: string; handler?: () => Promise<void> }>).find(({ role }) => role === 'destructive')
    await stopButton?.handler?.()
    await flushPromises()

    expect(wrapper.get('[data-testid="recurrence-operation-error"]').attributes('role')).toBe('alert')
    expect(wrapper.get('[data-testid="recurrence-operation-error"]').text()).toContain('Connection lost while stopping the series')
    expect(wrapper.get('[data-action="cancel-recurrence"]').attributes('disabled')).toBeUndefined()
  })

  it('clears an open cancellation alert when a new group route enters the reused page', async () => {
    const repository = createDemoRepository({ currentUserId: 'alex-r' })
    const secondGroup: Group = { ...lakeHouseGroup, id: 'ski-trip', name: 'Ski Trip' }
    const members = await repository.groups.listMembers(lakeHouseGroup.id)
    const source = recurringSourceExpense()
    setSession({
      ...repository,
      groups: {
        ...repository.groups,
        async getById(id) { return id === secondGroup.id ? secondGroup : id === lakeHouseGroup.id ? lakeHouseGroup : undefined },
        async listMembers() { return members },
        async listRecurring(id) { return id === lakeHouseGroup.id ? [recurringTemplate()] : [] },
        async materializeDue() { return { occurrences: [], moreRemain: false } },
      },
      expenses: { ...repository.expenses, async listForGroup(id) { return id === lakeHouseGroup.id ? [source] : [] } },
    })

    const wrapper = await mountRecurring()
    await wrapper.get('[data-action="cancel-recurrence"]').trigger('click')
    expect(wrapper.find('[data-testid="cancel-recurrence-alert"]').exists()).toBe(true)

    await wrapper.vm.$router.push('/tabs/groups/ski-trip/recurring')
    await flushPromises()

    expect(wrapper.find('[data-testid="cancel-recurrence-alert"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('Ski Trip')
  })

  it('does not refresh or publish status from a cancellation submitted on an earlier group entry', async () => {
    const repository = createDemoRepository({ currentUserId: 'alex-r' })
    const secondGroup: Group = { ...lakeHouseGroup, id: 'ski-trip', name: 'Ski Trip' }
    const members = await repository.groups.listMembers(lakeHouseGroup.id)
    const source = recurringSourceExpense()
    const active = recurringTemplate({ revision: 7 })
    const stopped: RecurringExpense = { ...active, status: 'cancelled', revision: 8 }
    let releaseSave!: () => void
    const saveGate = new Promise<void>((resolveGate) => { releaseSave = resolveGate })
    const execute = vi.fn(async (command: CommandEnvelope): Promise<CommandResult> => {
      if (command.kind !== 'recurrence.cancel') return repository.commands.execute(command)
      await saveGate
      return { kind: command.kind, operationId: command.operationId, status: 'saved', template: stopped }
    })
    const listRecurring = vi.fn(async (id: string) => id === lakeHouseGroup.id ? [active] : [])
    setSession({
      ...repository,
      groups: {
        ...repository.groups,
        async getById(id) { return id === secondGroup.id ? secondGroup : id === lakeHouseGroup.id ? lakeHouseGroup : undefined },
        async listMembers() { return members },
        listRecurring,
        async materializeDue() { return { occurrences: [], moreRemain: false } },
      },
      expenses: { ...repository.expenses, async listForGroup(id) { return id === lakeHouseGroup.id ? [source] : [] } },
      commands: { execute },
    })

    const wrapper = await mountRecurring()
    await wrapper.get('[data-action="cancel-recurrence"]').trigger('click')
    const alert = wrapper.getComponent({ name: 'IonAlert' })
    const stopButton = (alert.props('buttons') as Array<{ role?: string; handler?: () => Promise<void> }>).find(({ role }) => role === 'destructive')
    const saving = stopButton?.handler?.()
    await flushPromises()
    expect(wrapper.get('[data-testid="recurrence-operation"]').text()).toContain('Stopping future expenses')

    await wrapper.vm.$router.push('/tabs/groups/ski-trip/recurring')
    await flushPromises()
    const secondGroupListCalls = listRecurring.mock.calls.filter(([id]) => id === secondGroup.id).length
    expect(wrapper.find('[data-testid="recurrence-operation"]').exists()).toBe(false)

    releaseSave()
    await saving
    await flushPromises()

    expect(listRecurring.mock.calls.filter(([id]) => id === secondGroup.id)).toHaveLength(secondGroupListCalls)
    expect(wrapper.find('[data-testid="recurrence-operation"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="recurrence-operation-error"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('Ski Trip')
  })
})

describe('recurring page mobile contract', () => {
  it('keeps 390px content overflow-safe with 44px targets, safe areas, and reduced motion', () => {
    expect(recurringPageSource).toMatch(/overflow-x:\s*hidden/)
    expect(recurringPageSource).toMatch(/minmax\(0,\s*1fr\)/)
    expect(recurringPageSource).toMatch(/min-height:\s*44px/)
    expect(recurringPageSource).toContain('env(safe-area-inset-bottom)')
    expect(recurringPageSource).toContain('@media (prefers-reduced-motion: reduce)')
    expect(recurringPageSource).not.toContain('toISOString(')
  })
})

async function mountRecurring(settle = true): Promise<VueWrapper> {
  const router = createAppRouter()
  await router.push('/tabs/groups/lake-house-weekend/recurring')
  await router.isReady()
  const wrapper = mount(RecurringExpensesPage, {
    global: { plugins: [createPinia(), router], stubs: ionicStubs },
  })
  if (settle) await flushPromises()
  return wrapper
}

function setSession(repository: AppRepository): void {
  setAppSessionForTesting(createAppSession({ repository, commandStorage: createMemoryCommandStorage() }))
}

function recurringTemplate(overrides: Partial<RecurringExpense> = {}): RecurringExpense {
  const source = lakeHouseRecurring[0]
  if (!source) throw new Error('Missing recurring fixture')
  return { ...structuredClone(source), ...structuredClone(overrides) }
}

function recurringSourceExpense(): ExpenseRow {
  const source = lakeHouseExpenses.find(({ recurringTemplateId }) => recurringTemplateId === 'cabin-deposit-monthly')
  if (!source) throw new Error('Missing recurring source fixture')
  return structuredClone(source)
}

function recurringOccurrenceExpense(overrides: Partial<ExpenseRow> = {}): ExpenseRow {
  const source = recurringSourceExpense()
  return {
    ...source,
    id: 'occ_cabin-deposit-monthly_2026-09-28',
    date: '2026-09-28',
    createdAt: '2026-09-28T14:00:00.000Z',
    updatedAt: '2026-09-28T14:00:00.000Z',
    createdBy: { id: 'maya-p', displayName: 'Maya P.' },
    updatedBy: { id: 'maya-p', displayName: 'Maya P.' },
    ...structuredClone(overrides),
  }
}
