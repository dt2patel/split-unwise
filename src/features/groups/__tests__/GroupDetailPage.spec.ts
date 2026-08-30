import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia } from 'pinia'
import type { Component } from 'vue'
import { describe, expect, it } from 'vitest'
import { createAppRouter } from '../../../app/router'

const ionicStubs = {
  IonPage: { template: '<main class="ion-page"><slot /></main>' },
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
}

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
  it('renders the selected group hierarchy with one newest-first August journal', async () => {
    const wrapper = await mountRoute('/tabs/groups/lake-house-weekend')

    expect(wrapper.get('h1').text()).toBe('Lake House Weekend')
    expect(wrapper.get('[data-testid="group-cover"]').attributes('src')).toBe('/assets/images/lake-house-cover.png')
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
    expect(wrapper.get('[data-action="totals"]').attributes('href')).toBe('/tabs/groups/lake-house-weekend/totals')
    expect(wrapper.get('[data-action="charts"]').attributes('href')).toBe('/tabs/groups/lake-house-weekend/charts')
    expect(wrapper.get('[data-action="export"]').attributes('href')).toBe('/tabs/groups/lake-house-weekend/export')
    expect(wrapper.get('[aria-label="Add expense"]').attributes('href')).toBe('/tabs/groups/lake-house-weekend/expenses/new')
  })

  it('switches between the expense journal and repository activity', async () => {
    const wrapper = await mountRoute('/tabs/groups/lake-house-weekend')

    expect(wrapper.find('[data-testid="expense-journal"]').exists()).toBe(true)
    await wrapper.get('[data-view="activity"]').trigger('click')
    expect(wrapper.find('[data-testid="expense-journal"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="group-activity"]').text()).toContain('Maya P. added Groceries')

    await wrapper.get('[data-view="expenses"]').trigger('click')
    expect(wrapper.find('[data-testid="expense-journal"]').exists()).toBe(true)
  })

  it('marks the hero collapsed after the journal scroll threshold', async () => {
    const wrapper = await mountRoute('/tabs/groups/lake-house-weekend')

    wrapper.getComponent({ name: 'IonContent' }).vm.$emit('ionScroll', { detail: { scrollTop: 96 } })
    await wrapper.vm.$nextTick()
    expect(wrapper.get('[data-testid="group-detail"]').classes()).toContain('group-detail--collapsed')
  })
})

describe('route-specific browse pages', () => {
  it.each([
    ['/tabs/home', 'Home'],
    ['/tabs/groups', 'Groups'],
    ['/tabs/activity', 'Activity'],
    ['/tabs/account', 'Account'],
    ['/tabs/groups/lake-house-weekend/expenses/new', 'Add expense'],
  ])('renders %s with its own accessible heading', async (path, heading) => {
    const wrapper = await mountRoute(path)

    expect(wrapper.get('h1').text()).toBe(heading)
  })

  it.each(['/tabs/home', '/tabs/groups'])('links the Lake House group from %s', async (path) => {
    const wrapper = await mountRoute(path)

    expect(wrapper.get('[data-testid="lake-house-link"]').attributes('href')).toBe('/tabs/groups/lake-house-weekend')
  })
})
