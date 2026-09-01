import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import { createAppRouter } from '../../../app/router'
import { createMemoryCommandStorage } from '../../../data/commandQueue'
import { createDemoRepository } from '../../../data/demoRepository'
import type { Group } from '../../../data/repositories'
import { createAppSession, setAppSessionForTesting } from '../../../data/session'
import FriendsPage from '../FriendsPage.vue'

const friendship: Group = { id: 'friend-jordan', kind: 'friendship', name: 'Jordan Lee', currency: 'USD', memberIds: ['maya-p'], syncState: 'fresh' }
const stubs = {
  IonPage: { template: '<div><slot /></div>' }, IonHeader: { template: '<header><slot /></header>' },
  IonToolbar: { template: '<div><slot /></div>' }, IonTitle: { template: '<div><slot /></div>' },
  IonButtons: { template: '<div><slot /></div>' }, IonContent: { template: '<main><slot /></main>' },
  IonIcon: { template: '<span />' }, IonButton: { emits: ['click'], template: '<button type="button" @click="$emit(\'click\')"><slot /></button>' },
}

beforeEach(() => {
  setActivePinia(createPinia())
  const demo = createDemoRepository()
  setAppSessionForTesting(createAppSession({
    repository: { ...demo, groups: { ...demo.groups, async list() { return [friendship] } } },
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
    expect(wrapper.get('[data-friend-id="friend-jordan"]').attributes('href')).toBe('/tabs/groups/friend-jordan')
    await wrapper.get('[aria-label="Add friend"]').trigger('click')
    expect(wrapper.get('form').text()).toContain('Friend’s name')
    expect(wrapper.get('input[type="email"]').attributes('inputmode')).toBe('email')
  })
})
