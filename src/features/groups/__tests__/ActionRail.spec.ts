import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import ActionRail from '../components/ActionRail.vue'

const stubs = {
  IonIcon: true,
  IonButton: { props: ['routerLink', 'disabled'], emits: ['click'], template: '<a :href="routerLink" :aria-disabled="disabled ? \'true\' : undefined" @click="$emit(\'click\', $event)"><slot /></a>' },
  IonPopover: { name: 'IonPopover', props: ['isOpen', 'event', 'side', 'alignment'], emits: ['didDismiss'], template: '<div v-if="isOpen" data-testid="more-popover"><slot /></div>' },
}

describe('ActionRail', () => {
  it('disables Settle up while balances are provisional and restores it once confirmed', async () => {
    const wrapper = mount(ActionRail, { props: { groupId: 'trips', settleDisabled: true }, global: { stubs } })
    const settle = () => wrapper.get('[data-action="settle-up"]')
    expect(settle().attributes('aria-disabled')).toBe('true')
    expect(settle().attributes('href')).toBeUndefined()
    expect(wrapper.get('[data-action="balances"]').attributes('href')).toBe('/tabs/groups/trips/balances')

    await wrapper.setProps({ settleDisabled: false })
    expect(settle().attributes('aria-disabled')).toBeUndefined()
    expect(settle().attributes('href')).toBe('/tabs/groups/trips/settle-up')
  })

  it('opens More as an anchored popover without adding anything to the page layout', async () => {
    const wrapper = mount(ActionRail, { props: { groupId: 'trips' }, global: { stubs } })
    expect(wrapper.find('[data-testid="more-popover"]').exists()).toBe(false)
    const more = wrapper.get('[data-action="more"]')
    expect(more.attributes('aria-expanded')).toBe('false')

    await more.trigger('click')
    const popover = wrapper.getComponent({ name: 'IonPopover' })
    expect(popover.props('isOpen')).toBe(true)
    expect(popover.props('event')).toBeInstanceOf(Event)
    expect(popover.props('side')).toBe('bottom')
    expect(more.attributes('aria-expanded')).toBe('true')
    expect(['search', 'totals', 'charts', 'recurring', 'convert', 'export'].map((id) => wrapper.get(`[data-action="${id}"]`).attributes('href')))
      .toEqual(['search', 'totals', 'charts', 'recurring', 'convert', 'export'].map((suffix) => `/tabs/groups/trips/${suffix}`))
  })

  it('closes the popover when an action is chosen or it is dismissed', async () => {
    const wrapper = mount(ActionRail, { props: { groupId: 'trips' }, global: { stubs } })
    await wrapper.get('[data-action="more"]').trigger('click')
    await wrapper.get('[data-action="totals"]').trigger('click')
    expect(wrapper.getComponent({ name: 'IonPopover' }).props('isOpen')).toBe(false)

    await wrapper.get('[data-action="more"]').trigger('click')
    wrapper.getComponent({ name: 'IonPopover' }).vm.$emit('didDismiss')
    await wrapper.vm.$nextTick()
    expect(wrapper.getComponent({ name: 'IonPopover' }).props('isOpen')).toBe(false)
    expect(wrapper.get('[data-action="more"]').attributes('aria-expanded')).toBe('false')
  })
})
