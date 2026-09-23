import { flushPromises, mount } from '@vue/test-utils'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
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
  IonInput: {
    name: 'IonInput', props: ['modelValue', 'disabled'], emits: ['update:modelValue'],
    template: '<input :value="modelValue" :disabled="disabled" @input="$emit(\'update:modelValue\', $event.target.value)" />',
  },
  IonModal: {
    name: 'IonModal', props: ['isOpen', 'canDismiss', 'presentingElement'], emits: ['didDismiss'],
    template: '<aside v-if="isOpen" data-testid="member-removal-modal"><slot /></aside>',
  },
}

beforeEach(() => vi.restoreAllMocks())

// Stencil renders Ionic's custom elements asynchronously after Vue mounts them.
async function settleIonic(): Promise<void> {
  await flushPromises()
  await new Promise((resolve) => setTimeout(resolve, 20))
  await flushPromises()
}

describe('group default settings page', () => {
  it('uses native grouped controls and slot-aligned member rows for the mobile settings form', async () => {
    setAppSessionForTesting(createAppSession({ repository: createDemoRepository(), commandStorage: createMemoryCommandStorage() }))
    const router = createAppRouter(); await router.push('/tabs/groups/lake-house-weekend/settings'); await router.isReady()
    const wrapper = mount(GroupSettingsPage, { global: { plugins: [createPinia(), router], stubs } }); await flushPromises()

    expect(wrapper.get('[data-testid="group-settings-list"]').attributes('data-inset')).toBeDefined()
    expect(wrapper.get('[data-testid="group-default-methods"]').attributes('aria-label')).toBe('Default split method')
    expect(wrapper.findAll('[data-testid="group-member-row"]')).toHaveLength(5)
    expect(wrapper.get('[data-testid="clear-default-button"]').attributes('data-fill')).toBe('clear')
  })

  it('shows a deleted member for history but excludes it from the default split', async () => {
    const base = createDemoRepository()
    const deleted = { id: 'former-member', displayName: 'Deleted user', initials: 'DU', isCurrentUser: false, role: 'member' as const, canManage: false, accountStatus: 'deleted' as const }
    const repository = { ...base, groups: { ...base.groups, async listMembers(groupId: string) { return [...await base.groups.listMembers(groupId), deleted] } } }
    setAppSessionForTesting(createAppSession({ repository, commandStorage: createMemoryCommandStorage() }))
    const router = createAppRouter(); await router.push('/tabs/groups/lake-house-weekend/settings'); await router.isReady()
    const wrapper = mount(GroupSettingsPage, { global: { plugins: [createPinia(), router], stubs } }); await flushPromises()

    expect(wrapper.get('[data-member-id="former-member"]').text()).toContain('history only')
    expect(wrapper.find('[aria-label="Include Deleted user"]').exists()).toBe(false)
    expect(wrapper.findAll('[data-testid="group-member-row"]')).toHaveLength(5)
  })

  it('uses an iOS card modal to remove an uninvolved member and refreshes the shared member list', async () => {
    const repository = createDemoRepository()
    setAppSessionForTesting(createAppSession({ repository, commandStorage: createMemoryCommandStorage() }))
    const router = createAppRouter(); await router.push('/tabs/groups/lake-house-weekend/settings'); await router.isReady()
    const wrapper = mount(GroupSettingsPage, { attachTo: document.body, global: { plugins: [createPinia(), router], stubs } }); await flushPromises()

    expect(wrapper.text()).toContain('Manage members')
    await wrapper.get('[aria-label="Remove Sam D. from group"]').trigger('click')

    const modal = wrapper.getComponent({ name: 'IonModal' })
    expect(modal.props('presentingElement')).toBe(wrapper.get('.ion-page').element)
    expect(wrapper.get('[data-testid="member-removal-modal"]').text()).toContain('Remove Sam D.?')
    await wrapper.get('[data-testid="confirm-member-removal"]').trigger('click')
    await vi.waitFor(() => expect(wrapper.text()).toContain('Sam D. was removed'))

    expect(wrapper.find('[aria-label="Remove Sam D. from group"]').exists()).toBe(false)
    await expect(repository.groups.listMembers('lake-house-weekend')).resolves.not.toContainEqual(expect.objectContaining({ id: 'sam-d' }))
    wrapper.unmount()
  })

  it('deletes the shared group from an iOS card modal and returns to the group list', async () => {
    const repository = createDemoRepository()
    setAppSessionForTesting(createAppSession({ repository, commandStorage: createMemoryCommandStorage() }))
    const router = createAppRouter(); await router.push('/tabs/groups/lake-house-weekend/settings'); await router.isReady()
    const wrapper = mount(GroupSettingsPage, { attachTo: document.body, global: { plugins: [createPinia(), router], stubs } }); await flushPromises()

    await wrapper.get('[data-testid="delete-group-button"]').trigger('click')
    expect(wrapper.get('[data-testid="group-lifecycle-modal"]').text()).toContain('Delete Lake House Weekend?')
    expect(wrapper.get('[data-testid="group-lifecycle-modal"]').text()).toContain('expenses and payments')
    await wrapper.get('[data-testid="confirm-group-delete"]').trigger('click')

    await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/tabs/groups'))
    await expect(repository.groups.list()).resolves.toEqual([])
    wrapper.unmount()
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

    expect(wrapper.findAll<HTMLInputElement>('.ratio-input').map((input) => Number(input.element.value))).toEqual([20, 20, 20, 20, 20])
  })

  it('binds per-member Ionic ratio fields that keep the decimal keypad and a method-specific name', async () => {
    const repository = createDemoRepository()
    setAppSessionForTesting(createAppSession({ repository, commandStorage: createMemoryCommandStorage() }))
    const router = createAppRouter(); await router.push('/tabs/groups/lake-house-weekend/settings'); await router.isReady()
    const wrapper = mount(GroupSettingsPage, { global: { plugins: [createPinia(), router], stubs } }); await flushPromises()

    expect(wrapper.findAllComponents({ name: 'IonInput' })).toHaveLength(0)
    await wrapper.get('button[value="shares"]').trigger('click')
    await flushPromises()

    const shares = wrapper.findAll<HTMLInputElement>('.ratio-input')
    expect(shares).toHaveLength(5)
    expect(shares.every((input) => input.attributes('inputmode') === 'decimal')).toBe(true)
    expect(wrapper.get<HTMLInputElement>('[aria-label="Maya P. shares"]').element.value).toBe('1')
    await wrapper.get('[aria-label="Maya P. shares"]').setValue('3')
    await wrapper.findAll('.actions button')[0]!.trigger('click')
    await vi.waitFor(() => expect(wrapper.get('[role="status"]').text()).toContain('saved'))
    await expect(repository.groups.getSettings('lake-house-weekend')).resolves.toMatchObject({ defaultSplit: { type: 'shares', shares: { 'maya-p': 3 } } })

    await wrapper.get('button[value="percentage"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[aria-label="Maya P. shares"]').exists()).toBe(false)
    expect(wrapper.get<HTMLInputElement>('[aria-label="Maya P. percentage"]').element.value).toBe('20')
    expect(wrapper.findAll('.ratio-control small').map((suffix) => suffix.text())).toEqual(['%', '%', '%', '%', '%'])

    await wrapper.get('[aria-label="Include Maya P."]').setValue(false)
    await flushPromises()
    expect(wrapper.get('[aria-label="Maya P. percentage"]').attributes('disabled')).toBeDefined()
  })

  it('renames the real Ionic ratio input when the split method changes', async () => {
    setAppSessionForTesting(createAppSession({ repository: createDemoRepository(), commandStorage: createMemoryCommandStorage() }))
    const router = createAppRouter(); await router.push('/tabs/groups/lake-house-weekend/settings'); await router.isReady()
    const { IonInput: _stubbedInput, ...chrome } = stubs
    const wrapper = mount(GroupSettingsPage, { attachTo: document.body, global: { plugins: [createPinia(), router], stubs: chrome } })
    await settleIonic()

    await wrapper.get('button[value="shares"]').trigger('click')
    await settleIonic()
    const mayaShares = wrapper.get<HTMLInputElement>('[data-testid="group-member-row"] ion-input input')
    expect(mayaShares.attributes()).toMatchObject({ inputmode: 'decimal', 'aria-label': 'Maya P. shares' })
    expect(mayaShares.element.value).toBe('1')

    await wrapper.get('button[value="percentage"]').trigger('click')
    await settleIonic()
    const mayaPercentage = wrapper.get<HTMLInputElement>('[data-testid="group-member-row"] ion-input input')
    expect(mayaPercentage.attributes('aria-label')).toBe('Maya P. percentage')
    expect(mayaPercentage.element.value).toBe('20')
    wrapper.unmount()
  })

  it('renders ratio text at 16px so iOS does not zoom the field on focus', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/features/groups/GroupSettingsPage.vue'), 'utf8')
    expect(source).toMatch(/<ion-input[^>]*class="ratio-input"[^>]*inputmode="decimal"/s)
    expect(source).toMatch(/\.ratio-input \{[^}]*font-size: 16px;/)
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
