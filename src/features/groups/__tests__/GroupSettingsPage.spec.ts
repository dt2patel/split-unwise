import { flushPromises, mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createAppRouter } from '../../../app/router'
import { createMemoryCommandStorage } from '../../../data/commandQueue'
import { createDemoRepository } from '../../../data/demoRepository'
import { createAppSession, setAppSessionForTesting } from '../../../data/session'
import GroupSettingsPage from '../GroupSettingsPage.vue'

const stubs = {
  IonPage: { template: '<div class="ion-page"><slot /></div>' }, IonHeader: { template: '<header><slot /></header>' }, IonToolbar: { template: '<div><slot /></div>' }, IonTitle: { template: '<div><slot /></div>' }, IonButtons: { template: '<div><slot /></div>' },
  IonBackButton: { props: ['defaultHref', 'text'], template: '<a data-testid="back" :href="defaultHref">{{ text }}</a>' }, IonContent: { template: '<section><slot /></section>' },
  IonButton: { props: ['disabled'], emits: ['click'], template: '<button type="button" :disabled="disabled" @click="$emit(\'click\')"><slot /></button>' },
}

beforeEach(() => vi.restoreAllMocks())

describe('group default settings page', () => {
  it('saves an unlocked versioned shares default for future drafts', async () => {
    const repository = createDemoRepository()
    setAppSessionForTesting(createAppSession({ repository, commandStorage: createMemoryCommandStorage() }))
    const router = createAppRouter(); await router.push('/tabs/groups/lake-house-weekend/settings'); await router.isReady()
    const wrapper = mount(GroupSettingsPage, { global: { plugins: [createPinia(), router], stubs } }); await flushPromises()

    expect(wrapper.get('h1').text()).toBe('Group settings')
    expect(wrapper.findAll('h1')).toHaveLength(1)
    expect(wrapper.text()).toContain('Settings revision 1')
    expect(wrapper.text()).toContain('Included')
    await wrapper.get('input[value="shares"]').setValue(true)
    await wrapper.findAll('.actions button')[0]!.trigger('click')
    await vi.waitFor(() => expect(wrapper.get('[role="status"]').text()).toContain('saved'))

    await expect(repository.groups.getSettings('lake-house-weekend')).resolves.toMatchObject({ revision: 2, defaultSplit: { type: 'shares' } })
  })

  it('keeps shared defaults read-only for a non-manager', async () => {
    setAppSessionForTesting(createAppSession({ repository: createDemoRepository({ currentUserId: 'alex-r' }), commandStorage: createMemoryCommandStorage() }))
    const router = createAppRouter(); await router.push('/tabs/groups/lake-house-weekend/settings'); await router.isReady()
    const wrapper = mount(GroupSettingsPage, { global: { plugins: [createPinia(), router], stubs } }); await flushPromises()
    expect(wrapper.text()).toContain('Only an active group manager')
    expect(wrapper.get('.actions button').attributes('disabled')).toBeDefined()
  })

  it('seeds a valid equal percentage when the manager changes methods', async () => {
    setAppSessionForTesting(createAppSession({ repository: createDemoRepository(), commandStorage: createMemoryCommandStorage() }))
    const router = createAppRouter(); await router.push('/tabs/groups/lake-house-weekend/settings'); await router.isReady()
    const wrapper = mount(GroupSettingsPage, { global: { plugins: [createPinia(), router], stubs } }); await flushPromises()

    await wrapper.get('input[value="percentage"]').setValue(true)
    await flushPromises()

    expect(wrapper.findAll<HTMLInputElement>('.ratio-input').map((input) => Number(input.element.value))).toEqual([25, 25, 25, 25])
  })
})
