import { flushPromises, mount } from '@vue/test-utils'
import { IonicVue } from '@ionic/vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { APPEARANCE_STORAGE_KEY, bootstrapAppearance, installAppearanceController, type AppearanceController } from '../../../app/appearance'
import AppearancePage from '../AppearancePage.vue'

const stubs = {
  IonPage: { template: '<main><slot /></main>' },
  IonHeader: { template: '<header><slot /></header>' },
  IonToolbar: { template: '<div><slot /></div>' },
  IonButtons: { template: '<div><slot /></div>' },
  IonBackButton: { template: '<button>Account</button>' },
  IonTitle: { template: '<h2><slot /></h2>' },
  IonContent: { template: '<section><slot /></section>' },
  IonList: { props: ['inset', 'lines'], template: '<div :data-inset="inset"><slot /></div>' },
  IonItem: { template: '<div><slot /></div>' },
  IonIcon: { template: '<i />' },
  IonLabel: { template: '<span><slot /></span>' },
  IonNote: { template: '<small><slot /></small>' },
  IonRadio: { props: ['value'], template: '<input type="radio" :value="value">' },
  IonRadioGroup: { name: 'IonRadioGroup', props: ['value'], emits: ['ionChange'], template: '<div role="radiogroup"><slot /></div>' },
}

let controller: AppearanceController
let stored: Map<string, string>

// Stencil renders Ionic's custom elements asynchronously after Vue mounts them.
async function settleIonic(): Promise<void> {
  await flushPromises()
  await new Promise((resolve) => setTimeout(resolve, 20))
  await flushPromises()
}

beforeEach(() => {
  stored = new Map([[APPEARANCE_STORAGE_KEY, 'light']])
  const media = { matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }
  controller = bootstrapAppearance({
    document,
    storage: { getItem: (key) => stored.get(key) ?? null, setItem: (key, value) => { stored.set(key, value) } },
    matchMedia: () => media,
  })
  installAppearanceController(controller)
})

describe('Appearance page', () => {
  it('renders an inset iOS radio list bound to the saved preference', () => {
    const wrapper = mount(AppearancePage, { global: { stubs } })

    expect(wrapper.get('h1').text()).toBe('Appearance')
    expect(wrapper.find('[data-inset]').exists()).toBe(true)
    const group = wrapper.getComponent({ name: 'IonRadioGroup' })
    expect(group.props('value')).toBe('light')
    expect(group.attributes('aria-label')).toBe('Appearance preference')
    expect(wrapper.findAll('[data-appearance]').map((row) => row.attributes('data-appearance'))).toEqual(['system', 'light', 'dark'])
    expect(wrapper.findAll('input[type="radio"]').map((radio) => radio.attributes('aria-label'))).toEqual(['Automatic', 'Light', 'Dark'])
    expect(wrapper.get('[data-appearance="system"]').text()).toContain('Match this iPhone or device')
    expect(wrapper.get('[data-appearance="dark"]').text()).toContain('Always use the dark appearance')
  })

  it('selects an appearance by tapping a real Ionic radio row', async () => {
    const wrapper = mount(AppearancePage, { attachTo: document.body, global: { plugins: [[IonicVue, { mode: 'ios' }]], stubs: {
      IonPage: stubs.IonPage, IonHeader: stubs.IonHeader, IonToolbar: stubs.IonToolbar, IonButtons: stubs.IonButtons,
      IonBackButton: stubs.IonBackButton, IonTitle: stubs.IonTitle, IonContent: stubs.IonContent,
    } } })
    await settleIonic()

    const group = wrapper.get('ion-radio-group')
    expect(group.attributes()).toMatchObject({ role: 'radiogroup', 'aria-label': 'Appearance preference' })
    const radios = wrapper.findAll('ion-radio')
    expect(radios.map((radio) => radio.attributes('aria-label'))).toEqual(['Automatic', 'Light', 'Dark'])
    expect(radios.map((radio) => radio.attributes('aria-checked'))).toEqual(['false', 'true', 'false'])

    ;(radios[2]!.element as HTMLElement).click()
    await settleIonic()

    expect(controller.preference).toBe('dark')
    expect(radios.map((radio) => radio.attributes('aria-checked'))).toEqual(['false', 'false', 'true'])
    wrapper.unmount()
  })

  it('applies a radio selection immediately and ignores unknown values', async () => {
    const wrapper = mount(AppearancePage, { global: { stubs } })
    const group = wrapper.getComponent({ name: 'IonRadioGroup' })

    group.vm.$emit('ionChange', { detail: { value: 'dark' } })
    await wrapper.vm.$nextTick()

    expect(controller.preference).toBe('dark')
    expect(stored.get(APPEARANCE_STORAGE_KEY)).toBe('dark')
    expect(document.documentElement.classList.contains('su-theme-dark')).toBe(true)
    expect(group.props('value')).toBe('dark')

    group.vm.$emit('ionChange', { detail: { value: 'sepia' } })
    await wrapper.vm.$nextTick()

    expect(controller.preference).toBe('dark')
    expect(group.props('value')).toBe('dark')

    group.vm.$emit('ionChange', { detail: { value: 'system' } })
    await wrapper.vm.$nextTick()
    expect(controller.preference).toBe('system')
    expect(document.documentElement.classList.contains('su-theme-dark')).toBe(false)
  })
})
