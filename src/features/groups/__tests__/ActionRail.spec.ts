import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import ActionRail from '../components/ActionRail.vue'

const stubs = {
  IonIcon: true,
  IonButton: { props: ['routerLink', 'disabled'], template: '<a :href="routerLink" :aria-disabled="disabled ? \'true\' : undefined"><slot /></a>' },
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
})
