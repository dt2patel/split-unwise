import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createAppRouter } from '../../../app/router'
import { createMemoryCommandStorage } from '../../../data/commandQueue'
import { createDemoRepository } from '../../../data/demoRepository'
import type { Group, GroupBalanceSnapshot, Member } from '../../../data/repositories'
import { createAppSession, setAppSessionForTesting } from '../../../data/session'
import HomePage from '../HomePage.vue'

const friendship: Group = { id: 'friend-jordan', kind: 'friendship', name: 'Jordan Lee', currency: 'USD', memberIds: ['maya-p', 'jordan-p'], syncState: 'fresh' }
const jordan: Member = { id: 'jordan-p', displayName: 'Jordan Lee', initials: 'JL', isCurrentUser: false }
const stubs = {
  IonPage: { template: '<div><slot /></div>' }, IonHeader: { template: '<header><slot /></header>' },
  IonToolbar: { template: '<div><slot /></div>' }, IonTitle: { template: '<div><slot /></div>' },
  IonButtons: { template: '<div><slot /></div>' }, IonContent: { template: '<main><slot /></main>' },
  IonIcon: { template: '<span />' }, IonButton: { props: ['routerLink'], template: '<a :href="routerLink"><slot /></a>' },
  IonCard: { template: '<section><slot /></section>' }, IonCardContent: { template: '<div><slot /></div>' },
  IonList: { template: '<div><slot /></div>' }, IonItem: { props: ['routerLink'], template: '<a :href="routerLink"><slot /></a>' },
  IonAvatar: { template: '<span><slot /></span>' }, IonLabel: { template: '<span><slot /></span>' }, IonNote: { template: '<small><slot /></small>' },
  IonSkeletonText: { template: '<span />' },
}

beforeEach(() => {
  setActivePinia(createPinia())
  const demo = createDemoRepository()
  setAppSessionForTesting(createAppSession({
    repository: {
      ...demo,
      groups: {
        ...demo.groups,
        async list() { return [...await demo.groups.list(), friendship] },
        async listMembers(groupId) { return groupId === friendship.id ? [await demo.app.getCurrentUser(), jordan] : demo.groups.listMembers(groupId) },
        async getBalanceSnapshot(groupId): Promise<GroupBalanceSnapshot> {
          if (groupId !== friendship.id) return demo.groups.getBalanceSnapshot(groupId)
          return { groupId, balanceRevision: 1, simplifyDebtsEnabled: false, pairwise: [], simplified: [] }
        },
      },
    },
    commandStorage: createMemoryCommandStorage(),
  }))
})

describe('Home account balances', () => {
  it('shows the saved overall position, prioritizes unsettled friends, and labels each group balance', async () => {
    const router = createAppRouter()
    await router.push('/tabs/home')
    await router.isReady()
    const wrapper = mount(HomePage, { global: { plugins: [createPinia(), router], stubs } })
    await flushPromises()

    expect(wrapper.get('[data-testid="friends-link"]').attributes('href')).toBe('/tabs/home/friends')
    expect(wrapper.get('[data-testid="account-summary"]').text()).toContain('Overall, you are owed')
    expect(wrapper.get('[data-testid="account-summary"]').text()).toContain('$36.25')
    expect(wrapper.get('[data-testid="friend-balance-taylor-s"]').text()).toContain('Taylor S.')
    expect(wrapper.get('[data-testid="friend-balance-taylor-s"]').text()).toContain('$36.25')
    expect(wrapper.get('[data-testid="group-balance-lake-house-weekend"]').text()).toContain('you are owed')
    expect(wrapper.get('[data-testid="group-balance-lake-house-weekend"]').text()).toContain('$36.25')
    expect(wrapper.get('[aria-labelledby="recent-groups-title"]').text()).not.toContain('Jordan Lee')
  })

  it('renders the fast group shell while account balances are still loading', async () => {
    setActivePinia(createPinia())
    const demo = createDemoRepository()
    const savedSnapshot = await demo.groups.getBalanceSnapshot('lake-house-weekend')
    const pendingSnapshot = deferred<GroupBalanceSnapshot>()
    setAppSessionForTesting(createAppSession({
      repository: { ...demo, groups: { ...demo.groups, async getBalanceSnapshot() { return pendingSnapshot.promise } } },
      commandStorage: createMemoryCommandStorage(),
    }))
    const router = createAppRouter()
    await router.push('/tabs/home')
    await router.isReady()
    const wrapper = mount(HomePage, { global: { plugins: [createPinia(), router], stubs } })

    await vi.waitFor(() => expect(wrapper.get('[data-testid="lake-house-link"]').text()).toContain('Lake House Weekend'))
    expect(wrapper.get('[data-testid="account-summary"]').attributes('aria-label')).toBe('Loading account balance')
    expect(wrapper.get('[data-testid="group-balance-lake-house-weekend"]').text()).toContain('Calculating')
    pendingSnapshot.resolve(savedSnapshot)
    await flushPromises()
    expect(wrapper.get('[data-testid="account-summary"]').text()).toContain('$36.25')
  })
})

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((success) => { resolve = success })
  return { promise, resolve }
}
