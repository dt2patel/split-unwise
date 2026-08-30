import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
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

describe('MoneyAmount', () => {
  it('formats ISO minor units without rolling glyphs and makes owed direction explicit', () => {
    const wrapper = mount(MoneyAmount, {
      props: { money: { currency: 'USD', minorAmount: 2400 }, direction: 'owed' },
    })

    expect(wrapper.text()).toContain('$24.00')
    expect(wrapper.text()).toContain('You are owed')
    expect(wrapper.attributes('aria-label')).toContain('You are owed')
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
    expect(wrapper.get('.expense-row__category').attributes('aria-label')).toContain('Supplies')
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
    expect(wrapper.attributes('aria-label')).toBe('Maya Patel')
  })
})

describe('AppFab', () => {
  it('exposes Add Expense as a labelled action instead of a tab destination', () => {
    const wrapper = mount(AppFab, {
      props: { to: '/tabs/home/expenses/new' },
      global: { stubs: ionicStubs },
    })

    expect(wrapper.get('[data-testid="fab"] a').attributes('href')).toBe('/tabs/home/expenses/new')
    expect(wrapper.get('[data-testid="fab"] a').attributes('aria-label')).toBe('Add expense')
  })
})
