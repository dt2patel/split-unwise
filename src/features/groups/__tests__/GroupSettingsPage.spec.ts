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
  IonButton: { props: ['disabled', 'fill', 'color'], emits: ['click'], template: '<button type="button" :disabled="disabled" :data-fill="fill" :data-color="color" @click="$emit(\'click\')"><slot /></button>' },
  IonList: { props: ['inset', 'lines'], template: '<section :data-inset="inset"><slot /></section>' },
  IonItem: { props: ['disabled'], template: '<div><slot /></div>' },
  IonLabel: { template: '<span><slot /></span>' },
  IonNote: { template: '<small><slot /></small>' },
  IonSegment: { props: ['value', 'disabled'], emits: ['ionChange'], template: '<div><slot /></div>' },
  IonSegmentButton: { props: ['value'], emits: ['click'], template: '<button type="button" :value="value" @click="$emit(\'click\')"><slot /></button>' },
  IonCheckbox: {
    props: ['checked', 'disabled'], emits: ['ionChange'],
    template: '<input type="checkbox" :checked="checked" :disabled="disabled" @change="$emit(\'ionChange\', { detail: { checked: $event.target.checked } })" />',
  },
  IonToggle: {
    props: ['modelValue', 'disabled'], emits: ['ionChange'],
    template: '<input type="checkbox" :checked="modelValue" :disabled="disabled" @change="$emit(\'ionChange\', { detail: { checked: $event.target.checked } })" />',
  },
}

beforeEach(() => vi.restoreAllMocks())

describe('group default settings page', () => {
  it('uses native grouped controls and slot-aligned member rows for the mobile settings form', async () => {
    setAppSessionForTesting(createAppSession({ repository: createDemoRepository(), commandStorage: createMemoryCommandStorage() }))
    const router = createAppRouter(); await router.push('/tabs/groups/lake-house-weekend/settings'); await router.isReady()
    const wrapper = mount(GroupSettingsPage, { global: { plugins: [createPinia(), router], stubs } }); await flushPromises()

    expect(wrapper.get('[data-testid="group-settings-list"]').attributes('data-inset')).toBeDefined()
    expect(wrapper.get('[data-testid="group-default-methods"]').attributes('aria-label')).toBe('Default split method')
    expect(wrapper.findAll('[data-testid="group-member-row"]')).toHaveLength(4)
    expect(wrapper.get('[data-testid="clear-default-button"]').attributes('data-fill')).toBe('clear')
  })

  it('saves an unlocked versioned shares default for future drafts', async () => {
    const repository = createDemoRepository()
    setAppSessionForTesting(createAppSession({ repository, commandStorage: createMemoryCommandStorage() }))
    const router = createAppRouter(); await router.push('/tabs/groups/lake-house-weekend/settings'); await router.isReady()
    const wrapper = mount(GroupSettingsPage, { global: { plugins: [createPinia(), router], stubs } }); await flushPromises()

    expect(wrapper.get('h1').text()).toBe('Group settings')
    expect(wrapper.findAll('h1')).toHaveLength(1)
    expect(wrapper.text()).toContain('Settings revision 1')
    expect(wrapper.text()).toContain('Included')
    await wrapper.get('button[value="shares"]').trigger('click')
    await wrapper.findAll('.actions button')[0]!.trigger('click')
    await vi.waitFor(() => expect(wrapper.get('[role="status"]').text()).toContain('saved'))

    await expect(repository.groups.getSettings('lake-house-weekend')).resolves.toMatchObject({ revision: 2, defaultSplit: { type: 'shares' } })
  })

  it('keeps shared defaults read-only for a non-manager', async () => {
    const repository = createDemoRepository({ currentUserId: 'alex-r' })
    setAppSessionForTesting(createAppSession({ repository, commandStorage: createMemoryCommandStorage() }))
    const router = createAppRouter(); await router.push('/tabs/groups/lake-house-weekend/settings'); await router.isReady()
    const wrapper = mount(GroupSettingsPage, { global: { plugins: [createPinia(), router], stubs } }); await flushPromises()
    expect(wrapper.text()).toContain('Only an active group manager')
    expect(wrapper.get('.actions button').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[aria-label="Include Maya P."]').attributes('disabled')).toBeDefined()

    const toggle = wrapper.get<HTMLInputElement>('[data-testid="simplify-debts-toggle"]')
    expect(toggle.element.checked).toBe(true)
    expect(toggle.attributes('disabled')).toBeUndefined()
    await toggle.setValue(false)
    await vi.waitFor(() => expect(wrapper.get('[role="status"]').text()).toContain('Direct balances saved'))

    await expect(repository.groups.getSettings('lake-house-weekend')).resolves.toMatchObject({ revision: 2, simplifyDebtsEnabled: false })
    await expect(repository.groups.getBalanceSnapshot('lake-house-weekend')).resolves.toMatchObject({ simplifyDebtsEnabled: false })
  })

  it('seeds a valid equal percentage when the manager changes methods', async () => {
    setAppSessionForTesting(createAppSession({ repository: createDemoRepository(), commandStorage: createMemoryCommandStorage() }))
    const router = createAppRouter(); await router.push('/tabs/groups/lake-house-weekend/settings'); await router.isReady()
    const wrapper = mount(GroupSettingsPage, { global: { plugins: [createPinia(), router], stubs } }); await flushPromises()

    await wrapper.get('button[value="percentage"]').trigger('click')
    await flushPromises()

    expect(wrapper.findAll<HTMLInputElement>('.ratio-input').map((input) => Number(input.element.value))).toEqual([25, 25, 25, 25])
  })

  it('reloads the authoritative revision after a concurrent settings conflict', async () => {
    const repository = createDemoRepository()
    setAppSessionForTesting(createAppSession({ repository, commandStorage: createMemoryCommandStorage() }))
    const router = createAppRouter(); await router.push('/tabs/groups/lake-house-weekend/settings'); await router.isReady()
    const wrapper = mount(GroupSettingsPage, { global: { plugins: [createPinia(), router], stubs } }); await flushPromises()
    await repository.groups.setDefaultSplit({
      kind: 'group.default-split', operationId: 'remote-default', groupId: 'lake-house-weekend', expectedRevision: 1,
      defaultSplit: { type: 'shares', participantIds: ['maya-p', 'jordan-k', 'alex-r', 'taylor-s'], shares: { 'maya-p': 1, 'jordan-k': 1, 'alex-r': 1, 'taylor-s': 1 } },
    })

    await wrapper.findAll('.actions button')[0]!.trigger('click')
    await vi.waitFor(() => expect(wrapper.text()).toContain('Settings revision 2'))

    expect(wrapper.get('[role="alert"]').text()).toContain('changed')
    expect(wrapper.get('[role="alert"]').text()).toContain('latest')
  })
})
