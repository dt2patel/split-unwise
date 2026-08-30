import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
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
})
