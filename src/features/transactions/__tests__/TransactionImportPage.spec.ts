import { flushPromises, mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createAppRouter } from '../../../app/router'
import { createMemoryCommandStorage } from '../../../data/commandQueue'
import { createDemoRepository } from '../../../data/demoRepository'
import { createAppSession, setAppSessionForTesting } from '../../../data/session'
import TransactionImportPage from '../TransactionImportPage.vue'

const stubs = {
  IonPage: { template: '<main><slot /></main>' }, IonHeader: { template: '<header><slot /></header>' }, IonToolbar: { template: '<div><slot /></div>' }, IonTitle: { template: '<div><slot /></div>' },
  IonButtons: { template: '<div><slot /></div>' }, IonBackButton: { template: '<a><slot /></a>' }, IonContent: { template: '<section><slot /></section>' }, IonIcon: { template: '<span />' },
  IonButton: { props: ['disabled'], emits: ['click'], template: '<button type="button" :disabled="disabled" @click="$emit(\'click\')"><slot /></button>' },
}

beforeEach(() => {
  sessionStorage.clear()
  setAppSessionForTesting(createAppSession({ repository: createDemoRepository(), commandStorage: createMemoryCommandStorage() }))
})

describe('TransactionImportPage', () => {
  it('keeps a CSV on-device and routes one selected proposal through the existing composer', async () => {
    const router = createAppRouter(); await router.push('/tabs/account/transactions/import'); await router.isReady()
    const session = getSession()
    const wrapper = mount(TransactionImportPage, { global: { plugins: [createPinia(), router], stubs } })
    await flushPromises()

    expect(wrapper.get('h1').text()).toBe('Import transactions')
    expect(wrapper.text()).toMatch(/stays on this device/i)
    const file = new File(['Date,Description,Amount,Currency\n2026-08-30,Dinner,-42.50,USD'], 'statement.csv', { type: 'text/csv' })
    const input = wrapper.get('input[type="file"]')
    Object.defineProperty(input.element, 'files', { configurable: true, value: [file] })
    await input.trigger('change')
    await vi.waitFor(() => expect(wrapper.find('[data-testid="import-summary"]').exists()).toBe(true))

    expect(wrapper.get('[data-testid="import-summary"]').text()).toContain('1 transaction ready')
    expect(wrapper.get('[data-testid="import-transaction"]').text()).toContain('Dinner')
    await wrapper.get('[data-action="split-imported-transaction"]').trigger('click')
    await flushPromises()

    expect(router.currentRoute.value.path).toBe('/tabs/account/expenses/new')
    expect(router.currentRoute.value.query.importDraft).toMatch(/^[A-Za-z0-9._:-]+$/)
    expect(router.currentRoute.value.fullPath).not.toMatch(/Dinner|42\.50|USD/)
    expect(session.queue.snapshot()).toEqual([])
  })
})

function getSession() {
  // Importing through this helper keeps the test focused on the public session boundary.
  const session = createAppSession({ repository: createDemoRepository(), commandStorage: createMemoryCommandStorage() })
  setAppSessionForTesting(session)
  return session
}
