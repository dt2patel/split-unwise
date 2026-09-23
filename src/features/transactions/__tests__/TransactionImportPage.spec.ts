import { flushPromises, mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
  document.body.innerHTML = ''
  setAppSessionForTesting(createAppSession({ repository: createDemoRepository(), commandStorage: createMemoryCommandStorage() }))
})
afterEach(() => { vi.unstubAllGlobals() })

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

  it('opens the hidden statement input from an Ionic button row and lists skipped rows in a collapsed accordion', async () => {
    // Ionic's accordion reads prefers-reduced-motion when it toggles; jsdom has no matchMedia.
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query, addEventListener: () => undefined, removeEventListener: () => undefined }))
    const router = createAppRouter(); await router.push('/tabs/account/transactions/import'); await router.isReady()
    const wrapper = mount(TransactionImportPage, { attachTo: document.body, global: { plugins: [createPinia(), router], stubs } })
    await flushPromises()
    const picker = wrapper.get('[data-action="choose-statement"]')
    const input = wrapper.get<HTMLInputElement>('input[type="file"]')
    const openPicker = vi.spyOn(input.element, 'click')

    expect(picker.element.tagName).toBe('ION-ITEM')
    await vi.waitFor(() => expect(picker.element.shadowRoot?.querySelector('button')).toBeTruthy())
    expect(picker.text()).toContain('Choose CSV statement')
    expect(input.attributes('aria-hidden')).toBe('true')
    await picker.trigger('click')
    expect(openPicker).toHaveBeenCalledOnce()

    const file = new File(['Date,Description,Amount,Currency\n2026-08-30,Dinner,-42.50,USD\n2026-08-31,Refund,12.00,USD'], 'statement.csv', { type: 'text/csv' })
    Object.defineProperty(input.element, 'files', { configurable: true, value: [file] })
    await input.trigger('change')
    await vi.waitFor(() => expect(wrapper.find('[data-testid="import-rejections"]').exists()).toBe(true))

    const rejections = wrapper.get('[data-testid="import-rejections"]')
    const group = rejections.element.closest('ion-accordion-group') as (HTMLElement & { value?: unknown }) | null
    expect(rejections.element.tagName).toBe('ION-ACCORDION')
    expect(rejections.get('ion-item[slot="header"]').text()).toBe('1 row not imported')
    expect(rejections.get('[slot="content"]').text()).toContain('Row 3: Credit or refund rows are not imported as expenses.')
    expect(group?.value).toBeUndefined()

    await rejections.get('ion-item[slot="header"]').trigger('click')
    await vi.waitFor(() => expect(group?.value).toBe('rejections'))
    wrapper.unmount()
  })
})

function getSession() {
  // Importing through this helper keeps the test focused on the public session boundary.
  const session = createAppSession({ repository: createDemoRepository(), commandStorage: createMemoryCommandStorage() })
  setAppSessionForTesting(session)
  return session
}
