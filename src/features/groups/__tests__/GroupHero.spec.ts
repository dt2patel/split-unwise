import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import GroupHero from '../components/GroupHero.vue'

const group = {
  id: 'live-account-proof',
  name: 'Live Account Proof',
  currency: 'USD' as const,
  memberIds: ['owner', 'friend'],
  syncState: 'fresh' as const,
}

describe('GroupHero', () => {
  it('uses the real group initials and an icon fallback when no cover was saved', () => {
    const wrapper = mount(GroupHero, {
      props: { group, balances: [], collapsed: false },
      global: { stubs: { IonIcon: { template: '<span data-testid="fallback-icon" />' } } },
    })

    expect(wrapper.get('[data-testid="group-monogram"]').text()).toBe('LP')
    expect(wrapper.find('[data-testid="group-cover"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="group-cover-fallback"]').exists()).toBe(true)
  })

  it('renders a saved cover as a decorative image', () => {
    const wrapper = mount(GroupHero, {
      props: { group: { ...group, coverImageUrl: '/cover.jpg' }, balances: [], collapsed: false },
      global: { stubs: { IonIcon: true } },
    })

    expect(wrapper.get('[data-testid="group-cover"]').attributes()).toMatchObject({ src: '/cover.jpg', alt: '' })
    expect(wrapper.find('[data-testid="group-cover-fallback"]').exists()).toBe(false)
  })
})
