import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import { createAppRouter } from '../../../app/router'
import { createMemoryCommandStorage } from '../../../data/commandQueue'
import { createDemoRepository } from '../../../data/demoRepository'
import type { Group } from '../../../data/repositories'
import { createAppSession, setAppSessionForTesting } from '../../../data/session'
import HomePage from '../HomePage.vue'

const friendship: Group = { id: 'friend-jordan', kind: 'friendship', name: 'Jordan Lee', currency: 'USD', memberIds: ['maya-p', 'jordan-p'], syncState: 'fresh' }
const stubs = {
  IonPage: { template: '<div><slot /></div>' }, IonHeader: { template: '<header><slot /></header>' },
  IonToolbar: { template: '<div><slot /></div>' }, IonTitle: { template: '<div><slot /></div>' },
  IonButtons: { template: '<div><slot /></div>' }, IonContent: { template: '<main><slot /></main>' },
  IonIcon: { template: '<span />' }, IonButton: { props: ['routerLink'], template: '<a :href="routerLink"><slot /></a>' },
}

beforeEach(() => {
  setActivePinia(createPinia())
  const demo = createDemoRepository()
  setAppSessionForTesting(createAppSession({
    repository: { ...demo, groups: { ...demo.groups, async list() { return [...await demo.groups.list(), friendship] } } },
    commandStorage: createMemoryCommandStorage(),
  }))
})

describe('Home page friendships', () => {
  it('separates friends from recent groups and links to the Friends page', async () => {
    const router = createAppRouter()
    await router.push('/tabs/home')
    await router.isReady()
    const wrapper = mount(HomePage, { global: { plugins: [createPinia(), router], stubs } })
    await flushPromises()

    expect(wrapper.get('[data-testid="friends-link"]').attributes('href')).toBe('/tabs/home/friends')
    expect(wrapper.get('[data-testid="friend-jordan"]').text()).toContain('Jordan Lee')
    expect(wrapper.get('[aria-labelledby="recent-groups-title"]').text()).not.toContain('Jordan Lee')
  })
})
