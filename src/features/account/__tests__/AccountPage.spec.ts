import { flushPromises, mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import { createMemoryCommandStorage } from '../../../data/commandQueue'
import { createDemoRepository } from '../../../data/demoRepository'
import { createAppSession, setAppSessionForTesting } from '../../../data/session'
import AccountPage from '../AccountPage.vue'

beforeEach(() => setAppSessionForTesting(createAppSession({ repository: createDemoRepository(), commandStorage: createMemoryCommandStorage() })))

describe('Account page', () => {
  it('composes native grouped profile, preferences, export, offline data, and account controls', async () => {
    const wrapper = mount(AccountPage, { global: { plugins: [createPinia()], stubs: {
      IonPage: { template: '<main><slot /></main>' }, IonHeader: { template: '<header><slot /></header>' }, IonToolbar: { template: '<div><slot /></div>' }, IonTitle: { template: '<div><slot /></div>' }, IonButtons: { template: '<div><slot /></div>' }, IonButton: { template: '<button><slot /></button>' }, IonContent: { template: '<section><slot /></section>' }, IonIcon: { template: '<span />' }, IonAlert: { template: '<div />' }, RouterLink: { props: ['to'], template: '<a :href="to"><slot /></a>' },
    } } })
    await flushPromises()
    expect(wrapper.get('h1').text()).toBe('Account')
    expect(wrapper.text()).toContain('Maya P.')
    expect(wrapper.text()).toContain('Appearance')
    expect(wrapper.text()).toContain('Currencies')
    expect(wrapper.text()).toContain('Export your data')
    expect(wrapper.text()).toContain('Everything on this device is settled')
    expect(wrapper.text()).toContain('Delete account')
  })
})
