import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { IonFabButton } from '@ionic/vue'
import { createAppRouter } from '../../../app/router'
import TabsShell from '../TabsShell.vue'

const ionicStubs = {
  IonTabs: { template: '<section data-testid="tabs"><slot /></section>' },
  IonRouterOutlet: { template: '<div data-testid="tab-outlet" />' },
  IonTabBar: { template: '<nav aria-label="Primary navigation"><slot /></nav>' },
  IonTabButton: {
    props: ['tab', 'href'],
    template: '<a :data-tab="tab" :href="href"><slot /></a>',
  },
  IonLabel: { template: '<span><slot /></span>' },
  IonIcon: { template: '<span aria-hidden="true" />' },
  AppFab: { props: ['to'], template: '<a data-testid="add-expense" :href="to">Add expense</a>' },
}

describe('TabsShell', () => {
  it.each([
    ['home', '/tabs/home', 'Home'],
    ['groups', '/tabs/groups', 'Groups'],
    ['activity', '/tabs/activity', 'Activity'],
    ['account', '/tabs/account', 'Account'],
  ])('provides the %s stack root at %s', (tab, href, label) => {
    const wrapper = mount(TabsShell, { global: { stubs: ionicStubs } })

    expect(wrapper.find('[data-testid="tabs"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="tab-outlet"]').exists()).toBe(true)
    expect(wrapper.get(`[data-tab="${tab}"]`).attributes('href')).toBe(href)
    expect(wrapper.get(`[data-tab="${tab}"]`).text()).toBe(label)
  })

  it('keeps Add Expense outside the four-tab bar as a current-stack action', async () => {
    const router = createAppRouter()
    await router.push('/tabs/groups')
    await router.isReady()
    const wrapper = mount(TabsShell, { global: { plugins: [router], stubs: ionicStubs } })

    expect(wrapper.findAll('[data-tab]').map((tab) => tab.attributes('data-tab'))).toEqual(['home', 'groups', 'activity', 'account'])
    expect(wrapper.get('[data-testid="add-expense"]').attributes('href')).toBe('/tabs/groups/expenses/new')
  })

  it('renders the real FAB as a direct IonTabs child above the active stack route', async () => {
    const router = createAppRouter()
    await router.push('/tabs/account')
    await router.isReady()
    const wrapper = mount(TabsShell, { global: { plugins: [router] } })

    expect(wrapper.get('ion-tabs > ion-fab').attributes('slot')).toBeUndefined()
    expect(wrapper.getComponent(IonFabButton).props('routerLink')).toBe('/tabs/account/expenses/new')
    expect(wrapper.find('ion-tabs > ion-tab-bar').exists()).toBe(true)
  })

  it('hides global navigation in group detail and restores it at the Groups root', async () => {
    const router = createAppRouter()
    await router.push('/tabs/groups/lake-house-weekend')
    await router.isReady()
    const wrapper = mount(TabsShell, { global: { plugins: [router], stubs: ionicStubs } })

    expect(wrapper.find('[aria-label="Primary navigation"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="add-expense"]').exists()).toBe(false)

    await router.push('/tabs/groups')
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[aria-label="Primary navigation"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="add-expense"]').attributes('href')).toBe('/tabs/groups/expenses/new')
  })

  it('uses route metadata to hide every piece of global composer chrome', async () => {
    const router = createAppRouter()
    await router.push('/tabs/groups/expenses/new?groupId=lake-house-weekend')
    await router.isReady()
    const wrapper = mount(TabsShell, { global: { plugins: [router], stubs: ionicStubs } })

    expect(wrapper.find('[aria-label="Primary navigation"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="add-expense"]').exists()).toBe(false)
  })
})
