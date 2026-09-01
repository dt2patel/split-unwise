import { flushPromises, mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAppRouter } from '../../../app/router'
import { createMemoryCommandStorage } from '../../../data/commandQueue'
import { createDemoRepository } from '../../../data/demoRepository'
import { createAppSession, setAppSessionForTesting } from '../../../data/session'
import CurrencyConversionPage from '../CurrencyConversionPage.vue'

const stubs = {
  IonPage: { template: '<div class="ion-page"><slot /></div>' }, IonHeader: { template: '<header><slot /></header>' },
  IonToolbar: { template: '<div><slot /></div>' }, IonTitle: { template: '<div><slot /></div>' }, IonButtons: { template: '<div><slot /></div>' },
  IonBackButton: { props: ['defaultHref', 'text'], template: '<a data-testid="back" :href="defaultHref">{{ text }}</a>' },
  IonContent: { template: '<section><slot /></section>' }, IonButton: { template: '<button type="button"><slot /></button>' },
  IonIcon: { template: '<span aria-hidden="true" />' },
}

beforeEach(() => {
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    clear: () => values.clear(),
  })
  setAppSessionForTesting(createAppSession({ repository: createDemoRepository(), commandStorage: createMemoryCommandStorage() }))
})
afterEach(() => vi.unstubAllGlobals())

describe('reference currency conversion page', () => {
  it('shows a dated ECB preview in the first useful preferred currency without changing the ledger', async () => {
    const providerFetch = vi.fn(async () => new Response(JSON.stringify({ date: '2026-08-29', base: 'USD', quote: 'EUR', rate: 0.86237 }), { status: 200 }))
    vi.stubGlobal('fetch', providerFetch)
    const wrapper = await mountPage()

    await vi.waitFor(() => expect(wrapper.find('[data-testid="conversion-USD"]').exists()).toBe(true))
    expect(wrapper.get('h1').text()).toBe('Convert currencies')
    expect((wrapper.get('#target-currency').element as HTMLSelectElement).value).toBe('EUR')
    expect(wrapper.get('[data-testid="conversion-USD"]').text()).toContain('$759.00')
    expect(wrapper.get('[data-testid="conversion-USD"]').text()).toContain('€654.54')
    expect(wrapper.get('[data-testid="conversion-USD"]').text()).toContain('Aug 29, 2026')
    expect(wrapper.text()).toContain('European Central Bank via Frankfurter')
    expect(wrapper.text()).toContain('reference preview only')
    expect(wrapper.text()).toContain('never changes or combines your saved currencies')
    expect(providerFetch).toHaveBeenCalledTimes(1)
  })

  it('uses exact ISO exponents when the target changes and avoids the network for an identity preview', async () => {
    const providerFetch = vi.fn(async (url: string) => new Response(JSON.stringify({
      date: '2026-08-29', base: 'USD', quote: url.includes('/JPY') ? 'JPY' : 'EUR', rate: url.includes('/JPY') ? 150 : 0.86237,
    }), { status: 200 }))
    vi.stubGlobal('fetch', providerFetch)
    const wrapper = await mountPage()
    await vi.waitFor(() => expect(wrapper.find('[data-testid="conversion-USD"]').exists()).toBe(true))

    await wrapper.get('#target-currency').setValue('JPY')
    await vi.waitFor(() => expect(wrapper.get('[data-testid="conversion-USD"]').text()).toContain('¥113,850'))
    expect(providerFetch).toHaveBeenCalledTimes(2)

    await wrapper.get('#target-currency').setValue('USD')
    await vi.waitFor(() => expect(wrapper.get('[data-testid="conversion-USD"]').text()).toContain('$759.00'))
    expect(wrapper.get('[data-testid="conversion-USD"]').text()).toContain('Same currency')
    expect(providerFetch).toHaveBeenCalledTimes(2)
  })
})

async function mountPage() {
  const router = createAppRouter(); await router.push('/tabs/groups/lake-house-weekend/convert'); await router.isReady()
  const wrapper = mount(CurrencyConversionPage, { global: { plugins: [createPinia(), router], stubs } })
  await flushPromises()
  return wrapper
}
