import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { confirmAction } from '../../../app/confirmDialog'
import { localeController } from '../../../app/i18n'
import { createAppRouter } from '../../../app/router'
import { createMemoryCommandStorage } from '../../../data/commandQueue'
import { createDemoRepository } from '../../../data/demoRepository'
import { createAppSession, setAppSessionForTesting } from '../../../data/session'
import GroupsPage from '../GroupsPage.vue'
import { SafeRemoteDisplayError } from '../../../app/displayMessages'

const firebaseMocks = vi.hoisted(() => ({
  createSparkGroup: vi.fn(async () => ({ groupId: 'grp-hosted-cover' })),
  getActiveRuntimeConfiguration: vi.fn(() => ({ kind: 'firebase', firebase: {} })),
}))
vi.mock('../../../data/firebaseSparkMutations', () => ({ createSparkGroup: firebaseMocks.createSparkGroup }))
vi.mock('../../../data/firebase', () => ({ getActiveRuntimeConfiguration: firebaseMocks.getActiveRuntimeConfiguration }))
vi.mock('../../../app/confirmDialog', () => ({ confirmAction: vi.fn() }))

const stubs = {
  IonPage: { template: '<div class="ion-page"><slot /></div>' },
  IonHeader: { template: '<header><slot /></header>' },
  IonToolbar: { template: '<div><slot /></div>' },
  IonTitle: { template: '<div><slot /></div>' },
  IonButtons: { template: '<div><slot /></div>' },
  IonContent: { template: '<section><slot /></section>' },
  IonRefresher: { name: 'IonRefresher', emits: ['ionRefresh'], template: '<div><slot /></div>' },
  IonRefresherContent: true,
  IonButton: {
    props: ['ariaLabel', 'disabled', 'fill', 'strong'], emits: ['click'],
    template: '<button type="button" :aria-label="ariaLabel" :disabled="disabled" @click="$emit(\'click\', $event)"><slot /></button>',
  },
  IonIcon: { template: '<span aria-hidden="true" />' },
  IonModal: {
    name: 'IonModal', props: ['isOpen', 'canDismiss', 'presentingElement', 'initialBreakpoint', 'breakpoints'], emits: ['didDismiss'],
    template: '<aside v-if="isOpen" role="dialog"><slot /></aside>',
  },
  IonInput: {
    props: ['modelValue', 'label', 'labelPlacement', 'autocomplete', 'maxlength', 'placeholder'], emits: ['update:modelValue'],
    template: '<input :aria-label="label" :value="modelValue" :autocomplete="autocomplete" :maxlength="maxlength" :placeholder="placeholder" @input="$emit(\'update:modelValue\', $event.target.value)">',
  },
  IonSearchbar: { template: '<input><slot /></input>' },
  IonList: { template: '<section><slot /></section>' },
  IonItem: { template: '<div><slot /></div>' },
  IonLabel: { template: '<span><slot /></span>' },
}

beforeEach(() => {
  localeController.setPreference('en')
  vi.mocked(confirmAction).mockReset().mockResolvedValue(false)
  firebaseMocks.createSparkGroup.mockReset().mockResolvedValue({ groupId: 'grp-hosted-cover' })
  const repository = { ...createDemoRepository(), mode: 'firebase' as const }
  setAppSessionForTesting(createAppSession({ repository, commandStorage: createMemoryCommandStorage() }))
})
afterEach(() => vi.restoreAllMocks())

describe('pull to refresh', () => {
  it('reloads the group list from the server and ends the refresher', async () => {
    const source = createDemoRepository()
    const list = vi.fn(source.groups.list)
    setAppSessionForTesting(createAppSession({ repository: { ...source, groups: { ...source.groups, list } }, commandStorage: createMemoryCommandStorage() }))
    const wrapper = mount(GroupsPage, { global: { plugins: [createPinia(), createAppRouter()], stubs } })
    await flushPromises()
    const before = list.mock.calls.length
    const complete = vi.fn(async () => undefined)

    wrapper.getComponent({ name: 'IonRefresher' }).vm.$emit('ionRefresh', { target: { complete } })
    await flushPromises()

    expect(list.mock.calls.length).toBe(before + 1)
    expect(complete).toHaveBeenCalledOnce()
  })
})

describe('mobile group creation', () => {
  it('reactively localizes the application fallback when group loading fails', async () => {
    const source = createDemoRepository()
    const repository = { ...source, mode: 'firebase' as const, groups: { ...source.groups, async list() { throw new Error('Firestore group listing unavailable') } } }
    setAppSessionForTesting(createAppSession({ repository, commandStorage: createMemoryCommandStorage() }))
    const router = createAppRouter()
    const wrapper = mount(GroupsPage, { global: { plugins: [createPinia(), router], stubs } })
    await vi.waitFor(() => expect(wrapper.get('[role="alert"]').text()).toBe('The group could not be loaded.'))

    localeController.setPreference('es')
    await wrapper.vm.$nextTick()

    expect(wrapper.get('[role="alert"]').text()).toBe('No se pudo cargar el grupo.')
  })

  it('keeps only explicitly safe remote group-load text verbatim', async () => {
    const source = createDemoRepository()
    const safeRemoteError = new SafeRemoteDisplayError('Group access is paused for scheduled maintenance.')
    const repository = { ...source, mode: 'firebase' as const, groups: { ...source.groups, async list() { throw safeRemoteError } } }
    setAppSessionForTesting(createAppSession({ repository, commandStorage: createMemoryCommandStorage() }))
    const router = createAppRouter()
    const wrapper = mount(GroupsPage, { global: { plugins: [createPinia(), router], stubs } })
    await vi.waitFor(() => expect(wrapper.get('[role="alert"]').text()).toBe(safeRemoteError.message))

    localeController.setPreference('es')
    await wrapper.vm.$nextTick()

    expect(wrapper.get('[role="alert"]').text()).toBe(safeRemoteError.message)
  })

  it('retains a semantic group-creation failure that retranslates after locale changes', async () => {
    firebaseMocks.createSparkGroup.mockRejectedValueOnce(new Error('Firebase: permission denied.'))
    const router = createAppRouter()
    const wrapper = mount(GroupsPage, { global: { plugins: [createPinia(), router], stubs } })
    await flushPromises()
    await wrapper.get('[aria-label="Create group"]').trigger('click')
    await wrapper.get('[aria-label="Group name"]').setValue('Blocked create')
    await wrapper.get('[data-testid="create-group-submit"]').trigger('click')
    await flushPromises()

    expect(wrapper.get('.create-error').text()).toBe('The group could not be created.')

    localeController.setPreference('es')
    await wrapper.vm.$nextTick()

    expect(wrapper.get('.create-error').text()).toBe('No se pudo crear el grupo.')
  })

  it('reactively localizes the group journal and native create card while preserving group data', async () => {
    const router = createAppRouter()
    const wrapper = mount(GroupsPage, { global: { plugins: [createPinia(), router], stubs } })
    await flushPromises()

    localeController.setPreference('es')
    await wrapper.vm.$nextTick()

    expect(wrapper.get('.groups-page > p').text()).toBe('Viajes, hogares y planes cotidianos, todo en un diario claro.')
    expect(wrapper.find('[aria-label="Crear grupo"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="lake-house-link"]').text()).toContain('5 personas')
    expect(wrapper.get('[data-testid="lake-house-link"]').text()).toContain('Lake House Weekend')

    await wrapper.get('[aria-label="Crear grupo"]').trigger('click')

    expect(wrapper.get('[role="dialog"] h1').text()).toBe('Crear un grupo')
    expect(wrapper.get('#group-kind-heading').text()).toBe('¿Qué tipo de grupo?')
    expect(wrapper.get('[data-cover-choice="trip"]').text()).toContain('Viaje')
    expect(wrapper.get('#group-details-heading').text()).toBe('Detalles del grupo')
    expect(wrapper.find('[aria-label="Nombre del grupo"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="create-group-submit"]').text()).toBe('Crear')
  })

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
    // An empty sheet uses a boolean so Ionic's swipe-to-close follows the finger natively.
    expect(modal.props('canDismiss')).toBe(true)
    expect(wrapper.get('[role="dialog"] h1').text()).toBe('Create a group')
    expect(wrapper.findAll('[data-cover-choice]')).toHaveLength(4)
    expect(wrapper.get('[data-cover-choice="trip"]').attributes('aria-pressed')).toBe('true')
    expect(wrapper.find('main .create-group').exists()).toBe(false)

    wrapper.unmount()
  })

  it('asks with an Ionic alert before a swipe discards a draft, and only then', async () => {
    const wrapper = mount(GroupsPage, { global: { plugins: [createPinia(), createAppRouter()], stubs } })
    await flushPromises()
    await wrapper.get('[aria-label="Create group"]').trigger('click')
    const modal = wrapper.getComponent({ name: 'IonModal' })
    expect(modal.props('canDismiss')).toBe(true)

    await wrapper.get('[aria-label="Group name"]').setValue('Ski trip')
    const guard = modal.props('canDismiss') as () => Promise<boolean>
    expect(guard).toBeTypeOf('function')
    // Keep editing: the sheet springs back.
    await expect(guard()).resolves.toBe(false)
    expect(confirmAction).toHaveBeenCalledOnce()
    expect(confirmAction).toHaveBeenCalledWith({ message: 'Discard this group draft?', confirmText: 'Discard', cancelText: 'Keep editing', destructive: true })
    // Discard: the sheet may close.
    vi.mocked(confirmAction).mockResolvedValueOnce(true)
    await expect(guard()).resolves.toBe(true)

    await wrapper.get('[aria-label="Group name"]').setValue('')
    expect(modal.props('canDismiss')).toBe(true)
    expect(confirmAction).toHaveBeenCalledTimes(2)
    wrapper.unmount()
  })

  it('keeps the draft open when Cancel is answered with Keep editing', async () => {
    const wrapper = mount(GroupsPage, { global: { plugins: [createPinia(), createAppRouter()], stubs } })
    await flushPromises()
    await wrapper.get('[aria-label="Create group"]').trigger('click')
    await wrapper.get('[aria-label="Group name"]').setValue('Ski trip')

    await cancelButton(wrapper).trigger('click')
    await flushPromises()

    expect(confirmAction).toHaveBeenCalledOnce()
    expect(wrapper.getComponent({ name: 'IonModal' }).props('isOpen')).toBe(true)
    expect(wrapper.get<HTMLInputElement>('[aria-label="Group name"]').element.value).toBe('Ski trip')
    wrapper.unmount()
  })

  it('closes a draft after Cancel is confirmed with Discard, asking only once', async () => {
    vi.mocked(confirmAction).mockResolvedValue(true)
    const wrapper = mount(GroupsPage, { global: { plugins: [createPinia(), createAppRouter()], stubs } })
    await flushPromises()
    await wrapper.get('[aria-label="Create group"]').trigger('click')
    await wrapper.get('[aria-label="Group name"]').setValue('Ski trip')

    await cancelButton(wrapper).trigger('click')
    await flushPromises()

    const modal = wrapper.getComponent({ name: 'IonModal' })
    expect(modal.props('isOpen')).toBe(false)
    // Ionic re-checks canDismiss when isOpen turns false; the confirmed draft must not prompt again.
    expect(modal.props('canDismiss')).toBe(true)
    expect(confirmAction).toHaveBeenCalledOnce()

    modal.vm.$emit('didDismiss')
    await flushPromises()
    await wrapper.get('[aria-label="Create group"]').trigger('click')
    expect(wrapper.get<HTMLInputElement>('[aria-label="Group name"]').element.value).toBe('')
    expect(wrapper.getComponent({ name: 'IonModal' }).props('canDismiss')).toBe(true)
    wrapper.unmount()
  })

  it('waits for the card to finish dismissing before navigating to the saved group', async () => {
    const router = createAppRouter()
    const push = vi.spyOn(router, 'push')
    const wrapper = mount(GroupsPage, { global: { plugins: [createPinia(), router], stubs } })
    await flushPromises()
    await wrapper.get('[aria-label="Create group"]').trigger('click')
    await wrapper.get('[aria-label="Group name"]').setValue('Hosted cover QA')
    const modal = wrapper.getComponent({ name: 'IonModal' })

    let finishDismissal: (() => void) | undefined
    const onDidDismiss = vi.fn(() => new Promise<void>((resolve) => { finishDismissal = resolve }))
    Object.assign(wrapper.get('[role="dialog"]').element, { onDidDismiss })
    await wrapper.get('[data-testid="create-group-submit"]').trigger('click')
    await flushPromises()

    expect(firebaseMocks.createSparkGroup).toHaveBeenCalledOnce()
    expect(onDidDismiss).toHaveBeenCalledOnce()
    expect(modal.props('canDismiss')).toBe(true)
    expect(push).not.toHaveBeenCalledWith('/tabs/groups/grp-hosted-cover')

    finishDismissal?.()
    await flushPromises()
    expect(push).toHaveBeenCalledWith('/tabs/groups/grp-hosted-cover')
    wrapper.unmount()
  })
})

function cancelButton(wrapper: VueWrapper) {
  const button = wrapper.findAll('[role="dialog"] header button').find((candidate) => candidate.text() === 'Cancel')
  if (!button) throw new Error('Missing the create sheet Cancel button')
  return button
}
