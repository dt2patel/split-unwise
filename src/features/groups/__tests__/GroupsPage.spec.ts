import { flushPromises, mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAppRouter } from '../../../app/router'
import { createMemoryCommandStorage } from '../../../data/commandQueue'
import { createDemoRepository } from '../../../data/demoRepository'
import { createAppSession, setAppSessionForTesting } from '../../../data/session'
import GroupsPage from '../GroupsPage.vue'

const stubs = {
  IonPage: { template: '<div class="ion-page"><slot /></div>' },
  IonHeader: { template: '<header><slot /></header>' },
  IonToolbar: { template: '<div><slot /></div>' },
  IonTitle: { template: '<div><slot /></div>' },
  IonButtons: { template: '<div><slot /></div>' },
  IonContent: { template: '<section><slot /></section>' },
  IonButton: {
    props: ['ariaLabel', 'disabled', 'fill', 'strong'], emits: ['click'],
    template: '<button type="button" :aria-label="ariaLabel" :disabled="disabled" @click="$emit(\'click\', $event)"><slot /></button>',
  },
  IonIcon: { template: '<span aria-hidden="true" />' },
  IonModal: {
    name: 'IonModal', props: ['isOpen', 'canDismiss', 'presentingElement', 'initialBreakpoint', 'breakpoints'], emits: ['didDismiss'],
    template: '<aside v-if="isOpen" role="dialog"><slot /></aside>',
  },
  IonInput: { template: '<input><slot /></input>' },
  IonSearchbar: { template: '<input><slot /></input>' },
  IonList: { template: '<section><slot /></section>' },
  IonItem: { template: '<div><slot /></div>' },
  IonLabel: { template: '<span><slot /></span>' },
}

beforeEach(() => {
  const repository = { ...createDemoRepository(), mode: 'firebase' as const }
  setAppSessionForTesting(createAppSession({ repository, commandStorage: createMemoryCommandStorage() }))
})
afterEach(() => vi.restoreAllMocks())

describe('mobile group creation', () => {
  it('uses one iOS card modal with original cover choices instead of expanding the group list', async () => {
    const router = createAppRouter()
    const wrapper = mount(GroupsPage, { global: { plugins: [createPinia(), router], stubs } })
    await flushPromises()

    await wrapper.get('[aria-label="Create group"]').trigger('click')

    const modal = wrapper.getComponent({ name: 'IonModal' })
    expect(modal.props('isOpen')).toBe(true)
    expect(modal.props('presentingElement')).toBe(wrapper.get('.ion-page').element)
    expect(modal.props('initialBreakpoint')).toBeUndefined()
    expect(modal.props('breakpoints')).toBeUndefined()
    expect(modal.props('canDismiss')).toBeTypeOf('function')
    expect(wrapper.get('[role="dialog"] h1').text()).toBe('Create a group')
    expect(wrapper.findAll('[data-cover-choice]')).toHaveLength(4)
    expect(wrapper.get('[data-cover-choice="trip"]').attributes('aria-pressed')).toBe('true')
    expect(wrapper.find('main .create-group').exists()).toBe(false)

    wrapper.unmount()
  })
})
