import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { IonFab, IonFabButton } from '@ionic/vue'
import AppFab from '../AppFab.vue'
import ExpenseRow from '../ExpenseRow.vue'
import MemberAvatar from '../MemberAvatar.vue'
import MoneyAmount from '../MoneyAmount.vue'
import SyncStatus from '../SyncStatus.vue'
import type { ExpenseRow as ExpenseRowRecord, Member, SyncState } from '../../data/repositories'

const ionicStubs = {
  IonFab: { template: '<div data-testid="fab"><slot /></div>' },
  IonFabButton: { props: ['routerLink', 'ariaLabel'], template: '<a :href="routerLink" :aria-label="ariaLabel"><slot /></a>' },
  IonIcon: { template: '<span aria-hidden="true" />' },
  RouterLink: { props: ['to'], template: '<a :href="to"><slot /></a>' },
}

const expense: ExpenseRowRecord = {
  id: 'firewood',
  groupId: 'lake-house-weekend',
  description: 'Firewood for the dock',
  date: '2026-08-30',
  total: { currency: 'USD', minorAmount: 2400 },
  payments: [{ participantId: 'maya', money: { currency: 'USD', minorAmount: 2400 } }],
  allocations: [],
  category: 'Supplies',
  createdAt: '2026-08-30T12:00:00.000Z',
  updatedAt: '2026-08-30T12:00:00.000Z',
  revision: 1,
  syncState: 'fresh',
  splitMethod: { type: 'exact', allocations: [] },
  attachmentRefs: [],
}

const expenseRowSource = readFileSync(resolve(process.cwd(), 'src/components/ExpenseRow.vue'), 'utf8')
const syncStatusSource = readFileSync(resolve(process.cwd(), 'src/components/SyncStatus.vue'), 'utf8')

describe('MoneyAmount', () => {
  it('formats ISO minor units without rolling glyphs and makes owed direction explicit', () => {
    const wrapper = mount(MoneyAmount, {
      props: { money: { currency: 'USD', minorAmount: 2400 }, direction: 'owed' },
    })

    expect(wrapper.text()).toContain('$24.00')
    expect(wrapper.text()).toContain('You are owed')
    expect(wrapper.get('.money-amount__context').text()).toContain('You are owed $24.00')
    expect(wrapper.classes()).toContain('money-amount--owed')
    expect(wrapper.attributes('data-money-motion')).toBe('none')
  })

  it('uses the ISO exponent for zero-decimal currency values', () => {
    const wrapper = mount(MoneyAmount, {
      props: { money: { currency: 'JPY', minorAmount: 1200 }, direction: 'settled' },
    })

    expect(wrapper.text()).toContain('¥1,200')
    expect(wrapper.text()).toContain('Settled')
  })

  it.each([
    [{ currency: 'USD', minorAmount: Number.MAX_SAFE_INTEGER }, '$90,071,992,547,409.91'],
    [{ currency: 'BHD', minorAmount: Number.MAX_SAFE_INTEGER }, 'BHD 9,007,199,254,740.991'],
    [{ currency: 'CLF', minorAmount: Number.MAX_SAFE_INTEGER }, 'CLF 900,719,925,474.0991'],
    [{ currency: 'USD', minorAmount: -1 }, '-$0.01'],
  ] as const)('formats %s with exact minor-unit digits', (money, expected) => {
    const wrapper = mount(MoneyAmount, { props: { money, direction: 'settled', locale: 'en-US' } })

    expect(wrapper.get('.money-amount__value').text()).toBe(expected)
  })

  it('matches the native Spanish grouping threshold for an exact EUR amount', () => {
    const wrapper = mount(MoneyAmount, { props: { money: { currency: 'EUR', minorAmount: 100000 }, locale: 'es-ES' } })
    const native = new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(1000)

    expect(wrapper.get('.money-amount__value').text()).toBe(native)
    expect(wrapper.get('.money-amount__value').text()).not.toContain('.')
  })
})

describe('ExpenseRow', () => {
  it('keeps paid and balance amounts in separate right-aligned columns with a textual debt direction', () => {
    const wrapper = mount(ExpenseRow, {
      props: {
        expense,
        balance: { currency: 'USD', minorAmount: 600 },
        balanceDirection: 'owing',
      },
    })

    expect(wrapper.get('.expense-row__amount--paid').text()).toContain('$24.00')
    expect(wrapper.get('.expense-row__amount--paid').classes()).toContain('expense-row__amount--aligned')
    expect(wrapper.get('.expense-row__amount--balance').classes()).toContain('expense-row__amount--aligned')
    expect(wrapper.text()).toContain('You owe')
    expect(wrapper.find('ion-button').exists()).toBe(false)
    expect(wrapper.get('.expense-row__category').text()).toContain('Category: Supplies')
  })

  it('shows pending state in a journal row and exposes Retry/Discard only for failed drafts', async () => {
    const pending = mount(ExpenseRow, { props: { expense: { ...expense, syncState: 'pending' }, balance: { currency: 'USD', minorAmount: 0 }, balanceDirection: 'settled', journal: true } })
    expect(pending.text()).toContain('Saving')
    expect(pending.find('[data-action="retry-expense"]').exists()).toBe(false)

    const failed = mount(ExpenseRow, { props: { expense: { ...expense, syncState: 'failed' }, balance: { currency: 'USD', minorAmount: 0 }, balanceDirection: 'settled', journal: true, retryable: true } })
    await failed.get('[data-action="retry-expense"]').trigger('click')
    await failed.get('[data-action="discard-expense"]').trigger('click')
    expect(failed.emitted('retry')).toHaveLength(1)
    expect(failed.emitted('discard')).toHaveLength(1)

    const finalFailure = mount(ExpenseRow, { props: { expense: { ...expense, syncState: 'failed' }, balance: { currency: 'USD', minorAmount: 0 }, balanceDirection: 'settled', journal: true, retryable: false } })
    expect(finalFailure.find('[data-action="retry-expense"]').exists()).toBe(false)
    expect(finalFailure.find('[data-action="discard-expense"]').exists()).toBe(true)
    await finalFailure.get('[data-action="discard-expense"]').trigger('click')
    expect(finalFailure.emitted('discard')).toHaveLength(1)
  })

  it('renders local and remote conflict versions with explicit resolution actions', async () => {
    const remote = { ...expense, description: 'Remote firewood', revision: 2, total: { currency: 'USD' as const, minorAmount: 2800 } }
    const wrapper = mount(ExpenseRow, {
      props: {
        expense: { ...expense, description: 'My firewood draft', syncState: 'conflicted' },
        conflictRemote: remote,
        balance: { currency: 'USD', minorAmount: 0 },
        balanceDirection: 'settled',
        journal: true,
        retryable: true,
      },
    })

    expect(wrapper.get('[data-testid="local-conflict-version"]').text()).toContain('My firewood draft')
    expect(wrapper.get('[data-testid="remote-conflict-version"]').text()).toContain('Remote firewood')
    expect(wrapper.get('[data-testid="remote-conflict-version"]').text()).toContain('$28.00')
    expect(wrapper.find('[data-action="retry-expense"]').exists()).toBe(false)
    expect(wrapper.find('[data-action="discard-expense"]').exists()).toBe(false)
    await wrapper.get('[data-action="reload-remote"]').trigger('click')
    await wrapper.get('[data-action="retain-save-local"]').trigger('click')
    expect(wrapper.emitted('reloadRemote')).toHaveLength(1)
    expect(wrapper.emitted('retainLocal')).toHaveLength(1)
  })

  it('renders a delete conflict as an explicit delete intent with a delete-again resolution', async () => {
    const remote = { ...expense, description: 'Remote firewood', revision: 3 }
    const wrapper = mount(ExpenseRow, {
      props: {
        expense: { ...expense, syncState: 'conflicted' },
        conflictRemote: remote,
        conflictIntent: 'delete',
        balance: { currency: 'USD', minorAmount: 0 },
        balanceDirection: 'settled',
        journal: true,
      } as never,
    })

    expect(wrapper.get('[data-testid="local-conflict-version"]').text()).toContain('Delete requested')
    expect(wrapper.get('[data-testid="local-conflict-version"]').text()).not.toContain('Your draft')
    expect(wrapper.find('[data-action="retain-save-local"]').exists()).toBe(false)
    expect(wrapper.get('[data-action="delete-remote"]').text()).toBe('Delete latest version')

    await wrapper.get('[data-action="delete-remote"]').trigger('click')
    expect(wrapper.emitted('deleteRemote')).toHaveLength(1)
  })

  it('links only the non-action row body and leaves failed/conflict controls outside the link', async () => {
    const wrapper = mount(ExpenseRow, {
      props: {
        expense: { ...expense, syncState: 'failed' },
        balance: { currency: 'USD', minorAmount: 0 },
        balanceDirection: 'settled',
        journal: true,
        retryable: true,
        detailTo: '/tabs/groups/expenses/firewood?groupId=lake-house-weekend',
      },
      global: { stubs: ionicStubs },
    })

    expect(wrapper.get('a.expense-row__body').attributes('href')).toBe('/tabs/groups/expenses/firewood?groupId=lake-house-weekend')
    expect(wrapper.get('a.expense-row__body').text()).toContain('Firewood for the dock')
    expect(wrapper.findAll('[data-action]').every((button) => button.element.closest('a') === null)).toBe(true)

    await wrapper.setProps({ detailTo: undefined })
    expect(wrapper.find('a').exists()).toBe(false)
  })

  it('uses a restrained pending-row entrance and removes transforms for reduced motion', () => {
    expect(expenseRowSource).toContain('pending-row-enter 200ms')
    expect(expenseRowSource).toContain('translateY(10px)')
    expect(expenseRowSource).toContain('animation: none')
  })

  it('uses the mode-aware primary foreground for journal actions and directions', () => {
    expect(expenseRowSource).not.toContain('color: var(--su-accent)')
    expect(expenseRowSource.match(/color: var\(--ion-color-primary\)/g)).toHaveLength(2)
  })

  it('uses shared 62px financial tracks and a reflow class instead of auto-sized columns', () => {
    expect(expenseRowSource).toContain('--su-financial-track: 62px')
    expect(expenseRowSource).toContain('var(--su-financial-track) var(--su-financial-track)')
    expect(expenseRowSource).toContain('.expense-row--reflow')
    expect(expenseRowSource).not.toContain('minmax(4.8rem, auto)')
    expect(expenseRowSource).toContain('useExpenseRowLayout')
    expect(expenseRowSource).toContain("'expense-row--reflow': isReflow")
  })
})

describe('SyncStatus', () => {
  it.each<[SyncState, string]>([
    ['fresh', 'Saved'],
    ['stale', 'Saved copy may be out of date'],
    ['pending', 'Saving'],
    ['failed', 'Save failed'],
    ['conflicted', 'Conflict needs review'],
  ])('announces %s as %s with a live status', (state, label) => {
    const wrapper = mount(SyncStatus, { props: { state } })

    expect(wrapper.text()).toContain(label)
    expect(wrapper.attributes('role')).toBe('status')
    expect(wrapper.attributes('aria-live')).toBe('polite')
  })

  it('uses the mode-aware Ionic primary token for pending status', () => {
    expect(syncStatusSource).toContain('.sync-status--pending { color: var(--ion-color-primary); }')
  })
})

describe('MemberAvatar', () => {
  it('uses deterministic initials when no avatar image is available', () => {
    const member: Member = { id: 'maya', displayName: 'Maya Patel', initials: 'MP', isCurrentUser: true }
    const wrapper = mount(MemberAvatar, { props: { member } })

    expect(wrapper.text()).toContain('MP')
    expect(wrapper.attributes('role')).toBe('img')
    expect(wrapper.attributes('aria-label')).toBe('Maya Patel')
    expect(wrapper.get('.member-avatar__initials').attributes('aria-hidden')).toBe('true')
  })
})

describe('AppFab', () => {
  it('exposes Add Expense as a labelled action without an unassigned fixed slot', () => {
    const wrapper = mount(AppFab, { props: { to: '/tabs/home/expenses/new' } })

    expect(wrapper.get('ion-fab').attributes('slot')).toBeUndefined()
    expect(wrapper.getComponent(IonFab).props('vertical')).toBe('bottom')
    expect(wrapper.getComponent(IonFab).props('horizontal')).toBe('end')
    expect(wrapper.getComponent(IonFabButton).props('routerLink')).toBe('/tabs/home/expenses/new')
    expect(wrapper.get('ion-fab-button').attributes('aria-label')).toBe('Add expense')
    const source = readFileSync(resolve(process.cwd(), 'src/components/AppFab.vue'), 'utf8')
    expect(source).not.toContain('position: fixed')
    expect(source).not.toContain('right:')
    expect(source).not.toContain('bottom:')
  })
})
