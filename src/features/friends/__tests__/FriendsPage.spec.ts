import { flushPromises, mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import { createAppRouter } from '../../../app/router'
import { createMemoryCommandStorage } from '../../../data/commandQueue'
import { createDemoRepository } from '../../../data/demoRepository'
import type { Group, GroupBalanceSnapshot } from '../../../data/repositories'
import { createAppSession, setAppSessionForTesting } from '../../../data/session'
import FriendsPage from '../FriendsPage.vue'

const friendship: Group = { id: 'friend-jordan', kind: 'friendship', name: 'Jordan Lee', currency: 'USD', memberIds: ['maya-p'], syncState: 'fresh' }
const stubs = {
  IonPage: { template: '<div><slot /></div>' }, IonHeader: { template: '<header><slot /></header>' },
  IonToolbar: { template: '<div><slot /></div>' }, IonTitle: { template: '<div><slot /></div>' },
  IonButtons: { template: '<div><slot /></div>' }, IonContent: { template: '<main><slot /></main>' },
  IonIcon: { template: '<span />' }, IonButton: { emits: ['click'], template: '<button type="button" @click="$emit(\'click\')"><slot /></button>' },
  IonList: { template: '<div><slot /></div>' },
  IonItem: { props: ['routerLink'], emits: ['click'], template: '<component :is="routerLink ? \'a\' : \'button\'" :href="routerLink" @click="$emit(\'click\')"><slot /></component>' },
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
        async list() { return [friendship] },
        async listMembers() { return [await demo.app.getCurrentUser()] },
        async getBalanceSnapshot(groupId): Promise<GroupBalanceSnapshot> {
          return { groupId, balanceRevision: 1, simplifyDebtsEnabled: false, pairwise: [], simplified: [] }
        },
      },
    },
    commandStorage: createMemoryCommandStorage(),
  }))
})

describe('Friends page', () => {
  it('shows pending two-person contexts and a mobile add-friend form', async () => {
    const router = createAppRouter()
    await router.push('/tabs/home/friends')
    await router.isReady()
    const wrapper = mount(FriendsPage, { global: { plugins: [createPinia(), router], stubs } })
    await flushPromises()

    expect(wrapper.get('h1').text()).toBe('Friends')
    expect(wrapper.get('[data-friend-id="friend-jordan"]').text()).toContain('Invitation pending')
    await wrapper.get('[data-friend-id="friend-jordan"]').trigger('click')
    await nextTick()
    expect(wrapper.get('[data-breakdown-for="pending:friend-jordan"] a').attributes('href')).toBe('/tabs/groups/friend-jordan')
    await wrapper.get('[aria-label="Add friend"]').trigger('click')
    expect(wrapper.get('form').text()).toContain('Friend’s name')
    expect(wrapper.get('input[type="email"]').attributes('inputmode')).toBe('email')
  })

  it('includes friends from shared groups and expands their per-group balance', async () => {
    setActivePinia(createPinia())
    const repository = createDemoRepository()
    setAppSessionForTesting(createAppSession({ repository, commandStorage: createMemoryCommandStorage() }))
    const router = createAppRouter()
    await router.push('/tabs/home/friends')
    await router.isReady()
    const wrapper = mount(FriendsPage, { global: { plugins: [createPinia(), router], stubs } })
    await flushPromises()

    expect(wrapper.get('[aria-labelledby="friend-list-title"]').text()).toContain('4')
    expect(wrapper.get('[data-friend-id="taylor-s"]').text()).toContain('Taylor S.')
    expect(wrapper.get('[data-friend-id="taylor-s"]').text()).toContain('$36.25')
    await wrapper.get('[data-friend-id="taylor-s"]').trigger('click')
    await nextTick()

    const breakdown = wrapper.get('[data-breakdown-for="taylor-s"]')
    expect(breakdown.text()).toContain('Lake House Weekend')
    expect(breakdown.text()).toContain('$36.25')
    expect(breakdown.get('a').attributes('href')).toBe('/tabs/groups/lake-house-weekend')
  })

  it('keeps a pending invitation reachable when its balance read is temporarily unavailable', async () => {
    setActivePinia(createPinia())
    const repository = createDemoRepository()
    setAppSessionForTesting(createAppSession({
      repository: {
        ...repository,
        groups: {
          ...repository.groups,
          async list() { return [friendship] },
          async listMembers() { throw new Error('offline') },
          async getBalanceSnapshot() { throw new Error('offline') },
        },
      },
      commandStorage: createMemoryCommandStorage(),
    }))
    const router = createAppRouter()
    await router.push('/tabs/home/friends')
    await router.isReady()
    const wrapper = mount(FriendsPage, { global: { plugins: [createPinia(), router], stubs } })
    await flushPromises()

    const row = wrapper.get('[data-friend-id="friend-jordan"]')
    expect(row.text()).toContain('Invitation pending')
    await row.trigger('click')
    await nextTick()
    expect(wrapper.get('[data-breakdown-for="pending:friend-jordan"] a').attributes('href')).toBe('/tabs/groups/friend-jordan')
  })
})
