import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { IonFabButton } from '@ionic/vue'
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
}

const expense: ExpenseRowRecord = {
  id: 'firewood',
  groupId: 'lake-house-weekend',
  description: 'Firewood for the dock',
  date: '2026-08-30',
  total: { currency: 'USD', minorAmount: 2400 },
  payerId: 'maya',
  allocations: [],
  category: 'Supplies',
  createdAt: '2026-08-30T12:00:00.000Z',
  syncState: 'fresh',
}

const expenseRowSource = readFileSync(resolve(process.cwd(), 'src/components/ExpenseRow.vue'), 'utf8')

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

  it('uses shared 62px financial tracks and a reflow class instead of auto-sized columns', () => {
    expect(expenseRowSource).toContain('--su-financial-track: 62px')
    expect(expenseRowSource).toContain('var(--su-financial-track) var(--su-financial-track)')
    expect(expenseRowSource).toContain('.expense-row--reflow')
    expect(expenseRowSource).not.toContain('minmax(4.8rem, auto)')
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
    expect(wrapper.getComponent(IonFabButton).props('routerLink')).toBe('/tabs/home/expenses/new')
    expect(wrapper.get('ion-fab-button').attributes('aria-label')).toBe('Add expense')
  })
})
