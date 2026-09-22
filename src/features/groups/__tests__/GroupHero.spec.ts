import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import GroupHero from '../components/GroupHero.vue'

const group = {
  id: 'live-account-proof',
  kind: 'group' as const,
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

  it('names the other person in direct balance copy', () => {
    const wrapper = mount(GroupHero, {
      props: {
        group: { ...group, kind: 'friendship', name: 'Jordan Lee' },
        balances: [{ currency: 'USD', minorAmount: 1250 }], collapsed: false,
      },
      global: { stubs: { IonIcon: true } },
    })

    expect(wrapper.get('[data-testid="group-balance"]').text()).toContain('Jordan Lee owes you')
    expect(wrapper.get('[data-testid="group-balance"]').text()).toContain('$12.50')
  })

  it('shows a pending balance instead of a settled-up guess while expenses load', async () => {
    const wrapper = mount(GroupHero, {
      props: { group, balances: [], collapsed: false, balancesPending: true },
      global: { stubs: { IonIcon: true } },
    })

    expect(wrapper.get('[data-testid="group-balance-pending"]').text()).toBe('Checking balance…')
    expect(wrapper.find('[data-testid="group-balance"]').exists()).toBe(false)

    await wrapper.setProps({ balancesPending: false, balances: [{ currency: 'USD', minorAmount: -2000 }] })
    expect(wrapper.find('[data-testid="group-balance-pending"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="group-balance"]').text()).toContain('$20.00')
  })

  it('marks cached balances as updating', () => {
    const wrapper = mount(GroupHero, {
      props: { group, balances: [{ currency: 'USD', minorAmount: 2000 }], collapsed: false, provisional: true },
      global: { stubs: { IonIcon: true } },
    })
    expect(wrapper.get('[data-testid="group-balance"]').text()).toContain('$20.00')
    expect(wrapper.get('[data-testid="group-balance-updating"]').text()).toBe('Updating…')
  })
})
