import { flushPromises, mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, ref, watch } from 'vue'
import { createAppRouter } from '../../../app/router'
import { createMemoryCommandStorage } from '../../../data/commandQueue'
import { createDemoRepository } from '../../../data/demoRepository'
import { createAppSession, setAppSessionForTesting } from '../../../data/session'
import CurrencyConversionPage from '../CurrencyConversionPage.vue'

const GuardedIonModal = defineComponent({
  name: 'IonModal',
  props: ['isOpen', 'canDismiss', 'presentingElement', 'initialBreakpoint', 'breakpoints'],
  emits: ['didDismiss'],
  setup(props, { emit }) {
    const presented = ref(props.isOpen === true)
    watch(() => props.isOpen, async (isOpen) => {
      if (isOpen) presented.value = true
      else if (!props.canDismiss || await props.canDismiss()) {
        presented.value = false
        emit('didDismiss')
      }
    })
    return { presented }
  },
  template: '<aside v-if="presented" data-testid="conversion-modal"><slot /></aside>',
})

const stubs = {
  IonPage: { template: '<div class="ion-page"><slot /></div>' }, IonHeader: { template: '<header><slot /></header>' },
  IonToolbar: { template: '<div><slot /></div>' }, IonTitle: { template: '<div><slot /></div>' }, IonButtons: { template: '<div><slot /></div>' },
  IonBackButton: { props: ['defaultHref', 'text'], template: '<a data-testid="back" :href="defaultHref">{{ text }}</a>' },
  IonContent: { template: '<section><slot /></section>' }, IonButton: { template: '<button type="button"><slot /></button>' },
  IonModal: GuardedIonModal,
  IonIcon: { template: '<span aria-hidden="true" />' },
}

let session: ReturnType<typeof createAppSession>

beforeEach(() => {
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    clear: () => values.clear(),
  })
  installSession()
})
afterEach(() => vi.unstubAllGlobals())

describe('applied currency conversion page', () => {
  it('shows a dated ECB preview in the first useful preferred currency', async () => {
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
    expect(wrapper.text()).toContain('rate snapshot')
    expect(wrapper.text()).toContain('original amounts stay in the audit history')
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

  it('uses an Ionic card modal and applies one manager-only conversion command', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ date: '2026-08-29', base: 'USD', quote: 'EUR', rate: 0.86237 }), { status: 200 })))
    const wrapper = await mountPage()
    await vi.waitFor(() => expect(wrapper.get('[data-testid="apply-conversion"]').attributes('disabled')).toBeUndefined())

    await wrapper.get('[data-testid="apply-conversion"]').trigger('click')
    const modal = wrapper.getComponent({ name: 'IonModal' })
    expect(modal.props('isOpen')).toBe(true)
    expect(wrapper.get('[data-testid="apply-modal-title"]').text()).toBe('Apply')
    expect(modal.props('presentingElement')).toBe(wrapper.get('.ion-page').element)
    expect(modal.props('initialBreakpoint')).toBeUndefined()
    expect(modal.props('breakpoints')).toBeUndefined()
    expect(modal.props('canDismiss')).toBeTypeOf('function')

    await wrapper.get('[data-testid="confirm-conversion"]').trigger('click')
    await vi.waitFor(() => expect(wrapper.text()).toContain('Existing group activity now uses EUR'))
    await vi.waitFor(() => expect(wrapper.find('[data-testid="conversion-modal"]').exists()).toBe(false))
    const settings = await session.repository.groups.getSettings('lake-house-weekend')
    expect(settings.currencyConversion).toMatchObject({ targetCurrency: 'EUR', rates: [{ baseCurrency: 'USD', quoteCurrency: 'EUR' }] })
    expect((await session.repository.expenses.getById('lake-house-weekend', 'dinner'))?.total.currency).toBe('EUR')
  })

  it('keeps apply controls manager-only', async () => {
    installSession('jordan-k')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ date: '2026-08-29', base: 'USD', quote: 'EUR', rate: 0.86237 }), { status: 200 })))
    const wrapper = await mountPage()
    await vi.waitFor(() => expect(wrapper.find('[data-testid="conversion-USD"]').exists()).toBe(true))
    expect(wrapper.find('[data-testid="apply-conversion"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('Only a group manager can apply')
  })

  it('disables applying when a required rate is unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 503 })))
    const wrapper = await mountPage()
    await vi.waitFor(() => expect(wrapper.get('[data-testid="conversion-USD"]').text()).toContain('Unavailable'))
    expect(wrapper.get('[data-testid="apply-conversion"]').attributes('disabled')).toBeDefined()
  })
})

function installSession(currentUserId?: string): void {
  session = createAppSession({ repository: createDemoRepository({ currentUserId }), commandStorage: createMemoryCommandStorage() })
  setAppSessionForTesting(session)
}

async function mountPage() {
  const router = createAppRouter(); await router.push('/tabs/groups/lake-house-weekend/convert'); await router.isReady()
  const wrapper = mount(CurrencyConversionPage, { global: { plugins: [createPinia(), router], stubs } })
  await flushPromises()
  return wrapper
}
