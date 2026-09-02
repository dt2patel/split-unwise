import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it } from 'vitest'
import { localeController } from '../../../app/i18n'
import LanguagePage from '../LanguagePage.vue'

beforeEach(() => localeController.setPreference('system'))

describe('Language page', () => {
  it('renders system plus every supported locale and applies a native radio selection immediately', async () => {
    const wrapper = mount(LanguagePage, { global: { stubs: {
      IonPage: { template: '<main><slot /></main>' },
      IonHeader: { template: '<header><slot /></header>' },
      IonToolbar: { template: '<div><slot /></div>' },
      IonButtons: { template: '<div><slot /></div>' },
      IonBackButton: { template: '<button>Account</button>' },
      IonTitle: { template: '<h1><slot /></h1>' },
      IonContent: { template: '<section><slot /></section>' },
      IonList: { template: '<div><slot /></div>' },
      IonItem: { template: '<div><slot /></div>' },
      IonLabel: { template: '<span><slot /></span>' },
      IonNote: { template: '<small><slot /></small>' },
      IonRadio: { props: ['value'], template: '<input type="radio" :value="value">' },
      IonRadioGroup: { name: 'IonRadioGroup', props: ['value'], emits: ['ionChange'], template: '<div data-testid="language-options"><slot /></div>' },
    } } })

    expect(wrapper.get('h2').text()).toBe('App language')
    expect(wrapper.findAll('[data-locale]')).toHaveLength(9)

    wrapper.getComponent({ name: 'IonRadioGroup' }).vm.$emit('ionChange', { detail: { value: 'es' } })
    await wrapper.vm.$nextTick()

    expect(localeController.preference.value).toBe('es')
    expect(localeController.locale.value).toBe('es')
    expect(wrapper.get('h2').text()).toBe('Idioma de la app')
  })
})
