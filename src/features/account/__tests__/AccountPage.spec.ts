import { flushPromises, mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { localeController } from '../../../app/i18n'
import { createMemoryCommandStorage } from '../../../data/commandQueue'
import { createDemoRepository } from '../../../data/demoRepository'
import { setAppSessionForTesting, type AppDataSession, type UnresolvedWorkSummary } from '../../../data/session'
import { createAppSession } from '../../../data/session'
import { setAuthService, type AccountDeletionInput, type AuthService } from '../../auth/authService'
import { createFirebaseAccountDeletionAction } from '../../auth/firebaseAuthService'
import AccountPage from '../AccountPage.vue'

const localData = vi.hoisted(() => ({ clear: vi.fn() }))
vi.mock('../../../data/localData', () => ({ createBrowserPrincipalLocalDataPort: () => ({ clear: localData.clear }) }))

const settled: UnresolvedWorkSummary = { pending: 0, failed: 0, conflicted: 0, total: 0 }

beforeEach(() => {
  localeController.setPreference('en')
  localData.clear.mockReset().mockResolvedValue({ commandKeys: 1, receiptDatabase: true, preferences: true })
  setAuthService(undefined)
  setAppSessionForTesting(undefined)
})

describe('Account page', () => {
  it('reactively localizes native settings rows and the account-deletion card', async () => {
    useSession('firebase')
    useAuth(['password'])
    const wrapper = mountPage()
    await flushPromises()

    localeController.setPreference('es')
    await wrapper.vm.$nextTick()

    expect(wrapper.get('h1').text()).toBe('Cuenta')
    expect(wrapper.text()).toContain('Perfil')
    expect(wrapper.text()).toContain('Preferencias')
    expect(wrapper.text()).toContain('Apariencia')
    expect(wrapper.text()).toContain('Monedas')
    expect(wrapper.text()).toContain('Exportar tus datos')
    expect(wrapper.text()).toContain('Cambios sin conexión')
    expect(wrapper.text()).toContain('Cerrar sesión')
    expect(wrapper.get('[data-testid="open-account-delete"]').text()).toContain('Eliminar cuenta')

    await wrapper.get('[data-testid="open-account-delete"]').trigger('click')

    expect(wrapper.get('[data-testid="account-deletion-modal"] h2').text()).toBe('¿Eliminar tu cuenta?')
    expect(wrapper.get('[data-testid="account-deletion-modal"]').text()).toContain('Los saldos compartidos se mantienen correctos')
    expect(wrapper.get('[data-testid="confirm-account-delete"]').text()).toBe('Eliminar cuenta permanentemente')
  })

  it('composes native grouped profile, preferences, export, offline data, and account controls', async () => {
    useSession('demo')
    const wrapper = mountPage()
    await flushPromises()

    expect(wrapper.get('h1').text()).toBe('Account')
    expect(wrapper.text()).toContain('Maya P.')
    expect(wrapper.text()).toContain('Appearance')
    expect(wrapper.text()).toContain('Language')
    expect(wrapper.text()).toContain('Currencies')
    expect(wrapper.text()).toContain('Export your data')
    expect(wrapper.text()).toContain('Import transactions')
    expect(wrapper.text()).toContain('Everything on this device is settled')
    expect(wrapper.get('[data-testid="open-account-delete"]').attributes('disabled')).toBeDefined()
  })

  it('persists opt-in PayPal and Venmo handles from account settings', async () => {
    const repository = createDemoRepository()
    setAppSessionForTesting(createAppSession({ repository, commandStorage: createMemoryCommandStorage() }))
    const wrapper = mountPage()
    await flushPromises()

    await wrapper.get('[data-testid="paypal-handle"]').setValue('maya.payments')
    await wrapper.get('[data-testid="venmo-handle"]').setValue('maya-payments')
    await wrapper.get('[data-action="save-profile"]').trigger('click')

    await vi.waitFor(async () => expect(await repository.app.getCurrentUser()).toMatchObject({
      paymentHandles: { paypal: 'maya.payments', venmo: 'maya-payments' },
    }))
    expect(wrapper.get('[role="status"]').text()).toContain('Profile saved')
  })

  it('retranslates saved profile feedback when the language preference changes', async () => {
    const repository = createDemoRepository()
    setAppSessionForTesting(createAppSession({ repository, commandStorage: createMemoryCommandStorage() }))
    const wrapper = mountPage()
    await flushPromises()

    await wrapper.get('[data-action="save-profile"]').trigger('click')
    await vi.waitFor(() => expect(wrapper.get('[role="status"]').text()).toBe('Profile saved.'))

    localeController.setPreference('es')
    await wrapper.vm.$nextTick()

    expect(wrapper.get('[role="status"]').text()).toBe('Perfil guardado.')
  })

  it('keeps profile editing disabled until the account snapshot finishes hydrating', async () => {
    const session = useSession('demo')
    let release!: () => void
    const hydration = new Promise<void>((resolve) => { release = resolve })
    session.repository.app.getCurrentUser.mockImplementation(async () => {
      await hydration
      return { id: 'maya-p', displayName: 'Maya P.', initials: 'MP', isCurrentUser: true }
    })
    const wrapper = mountPage()
    await flushPromises()

    expect(wrapper.get('#account-name').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-testid="paypal-handle"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-testid="venmo-handle"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-action="save-profile"]').attributes('disabled')).toBeDefined()

    release()
    await flushPromises()
    expect(wrapper.get('#account-name').attributes('disabled')).toBeUndefined()
    expect(wrapper.get('[data-action="save-profile"]').attributes('disabled')).toBeUndefined()
  })

  it('presents a native iOS card and requires password plus acknowledgement', async () => {
    useSession('firebase')
    useAuth(['password'])
    const wrapper = mountPage()
    await flushPromises()
    await wrapper.get('[data-testid="open-account-delete"]').trigger('click')

    const modal = wrapper.getComponent({ name: 'IonModal' })
    expect(modal.props('presentingElement')).toBe(wrapper.get('.ion-page').element)
    expect(await (modal.props('canDismiss') as () => Promise<boolean>)()).toBe(true)
    expect(wrapper.get('[data-testid="account-delete-password"]').attributes('type')).toBe('password')
    expect(wrapper.get('[data-testid="confirm-account-delete"]').attributes('disabled')).toBeDefined()

    await wrapper.get('[data-testid="account-delete-password"]').setValue('current-password')
    await wrapper.get('[data-testid="account-delete-ack"]').get('input').setValue(true)
    expect(wrapper.get('[data-testid="confirm-account-delete"]').attributes('disabled')).toBeUndefined()
  })

  it('keeps the long German deletion acknowledgement inside the mobile card width', async () => {
    useSession('firebase')
    useAuth(['password'])
    localeController.setPreference('de')
    const wrapper = mountPage()
    await flushPromises()
    await wrapper.get('[data-testid="open-account-delete"]').trigger('click')

    const card = wrapper.get('[data-testid="account-deletion-modal"]')
    expect(card.text()).toContain('Ich verstehe, dass dieses Konto nicht wiederhergestellt werden kann.')
    const source = readFileSync(resolve(process.cwd(), 'src/features/account/AccountPage.vue'), 'utf8')
    expect(source).toMatch(/\.account-deletion-card\{box-sizing:border-box;[^}]*min-width:0;/)
    expect(source).toMatch(/\.account-deletion-card ion-checkbox\{box-sizing:border-box;width:100%;min-width:0;/)
    expect(source).toMatch(/\.account-deletion-card ion-checkbox::part\(label\)\{[^}]*white-space:normal;/)
  })

  it('uses Google reauthentication copy without asking for a password', async () => {
    useSession('firebase')
    useAuth(['google.com'])
    const wrapper = mountPage()
    await flushPromises()
    await wrapper.get('[data-testid="open-account-delete"]').trigger('click')

    expect(wrapper.find('[data-testid="account-delete-password"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('Continue with Google')
  })

  it('blocks deletion while a command is pending and resumes local work', async () => {
    const session = useSession('firebase', { pending: 1, failed: 0, conflicted: 0, total: 1 })
    const { deleteAccount } = useAuth(['password'])
    const wrapper = mountPage()
    await flushPromises()
    await wrapper.get('[data-testid="open-account-delete"]').trigger('click')
    await wrapper.get('[data-testid="account-delete-password"]').setValue('current-password')
    await wrapper.get('[data-testid="account-delete-ack"]').get('input').setValue(true)
    await wrapper.get('[data-testid="confirm-account-delete"]').trigger('click')
    await flushPromises()

    expect(deleteAccount).not.toHaveBeenCalled()
    expect(session.resumeWork).toHaveBeenCalledOnce()
    expect(wrapper.text()).toContain('Wait for in-flight changes before deleting your account')
  })

  it('clears the password, unlocks swipe, and retranslates the actual wrong-password deletion error', async () => {
    const session = useSession('firebase')
    const user = { uid: 'maya-p', email: 'maya@example.com', emailVerified: true, providerData: [{ providerId: 'password' }] }
    const deleteAccount = createFirebaseAccountDeletionAction({
      currentUser: () => user,
      passwordCredential: () => ({ kind: 'password' }),
      async reauthenticateWithCredential() { throw Object.assign(new Error('raw Firebase error'), { code: 'auth/invalid-credential' }) },
      googleProvider: () => ({ kind: 'google' }),
      async reauthenticateWithPopup() {},
      async prepare() {},
      async deleteUser() {},
    })
    setTestAuth(['password'], deleteAccount)
    const wrapper = mountPage()
    await flushPromises()
    await wrapper.get('[data-testid="open-account-delete"]').trigger('click')
    await wrapper.get('[data-testid="account-delete-password"]').setValue('wrong-password')
    await wrapper.get('[data-testid="account-delete-ack"]').get('input').setValue(true)
    await wrapper.get('[data-testid="confirm-account-delete"]').trigger('click')
    await flushPromises()

    expect(wrapper.get('[data-testid="account-delete-password"]').attributes('value')).toBe('')
    expect(wrapper.text()).toContain('The password is incorrect.')
    expect(session.resumeWork).toHaveBeenCalledOnce()
    expect(await (wrapper.getComponent({ name: 'IonModal' }).props('canDismiss') as () => Promise<boolean>)()).toBe(true)

    localeController.setPreference('es')
    await wrapper.vm.$nextTick()

    expect(wrapper.text()).toContain('La contraseña es incorrecta.')
  })

  it('locks dismissal and clears the exact principal before Auth deletion completes', async () => {
    const session = useSession('firebase')
    let finish!: () => void
    const gate = new Promise<void>((resolve) => { finish = resolve })
    const { deleteAccount } = useAuth(['password'])
    deleteAccount.mockImplementationOnce(async (input: AccountDeletionInput) => {
      input.onProgress?.({ stage: 'prepared', completedGroups: 1, totalGroups: 1 })
      await input.beforeAuthDelete?.()
      await gate
    })
    const wrapper = mountPage()
    await flushPromises()
    await wrapper.get('[data-testid="open-account-delete"]').trigger('click')
    await wrapper.get('[data-testid="account-delete-password"]').setValue('current-password')
    await wrapper.get('[data-testid="account-delete-ack"]').get('input').setValue(true)
    await wrapper.get('[data-testid="confirm-account-delete"]').trigger('click')
    await flushPromises()

    expect(await (wrapper.getComponent({ name: 'IonModal' }).props('canDismiss') as () => Promise<boolean>)()).toBe(false)
    expect(session.clearLocalData).toHaveBeenCalledOnce()
    expect(localData.clear).toHaveBeenCalledWith({ mode: 'firebase', projectId: 'test-project', uid: 'maya-p' })
    finish()
    await flushPromises()
  })
})

function useSession(mode: 'demo' | 'firebase', unresolved: UnresolvedWorkSummary = settled) {
  const queue = {
    snapshot: vi.fn(() => []),
    subscribe: vi.fn(() => () => undefined),
    submit: vi.fn(),
  }
  const session = {
    repository: {
      mode,
      projectId: mode === 'firebase' ? 'test-project' : 'demo-local',
      app: { getCurrentUser: vi.fn().mockResolvedValue({ id: 'maya-p', displayName: 'Maya P.', initials: 'MP', isCurrentUser: true }) },
      notifications: { getPreferences: vi.fn().mockResolvedValue({ emailEnabled: true, pushEnabled: true }) },
    },
    queue,
    ready: Promise.resolve(),
    principal: Promise.resolve({ mode, projectId: mode === 'firebase' ? 'test-project' : 'demo-local', uid: 'maya-p' }),
    quiesce: vi.fn(() => unresolved),
    resumeWork: vi.fn(),
    clearLocalData: vi.fn().mockResolvedValue(undefined),
  }
  setAppSessionForTesting(session as unknown as AppDataSession)
  return session
}

function useAuth(providerIds: readonly string[]) {
  const deleteAccount = vi.fn<(input: AccountDeletionInput) => Promise<void>>().mockResolvedValue(undefined)
  setTestAuth(providerIds, deleteAccount)
  return { deleteAccount }
}

function setTestAuth(providerIds: readonly string[], deleteAccount: AuthService['deleteAccount']): void {
  const service = {
    mode: 'firebase',
    capabilities: { auth: 'available', firestore: 'available', storage: 'unavailable', functions: 'unavailable', appCheck: 'unavailable', push: 'unavailable', google: 'available', apple: 'unavailable' },
    getState: () => ({
      status: 'signed-in', mode: 'firebase',
      identity: { uid: 'maya-p', displayName: 'Maya P.', email: 'maya@example.com', emailVerified: true, providerIds },
    }),
    subscribe: vi.fn(() => () => undefined),
    deleteAccount,
  }
  setAuthService(service as unknown as AuthService)
}

function mountPage() {
  return mount(AccountPage, { global: { plugins: [createPinia()], stubs: {
    IonPage: { name: 'IonPage', template: '<main class="ion-page"><slot /></main>' },
    IonHeader: { template: '<header><slot /></header>' },
    IonToolbar: { template: '<div><slot /></div>' },
    IonTitle: { template: '<div><slot /></div>' },
    IonButtons: { template: '<div><slot /></div>' },
    IonButton: { props: ['disabled'], template: '<button :disabled="disabled"><slot /></button>' },
    IonContent: { template: '<section><slot /></section>' },
    IonIcon: { template: '<span />' },
    IonAlert: { template: '<div />' },
    IonModal: { name: 'IonModal', props: ['isOpen', 'canDismiss', 'presentingElement'], emits: ['didDismiss'], template: '<aside v-if="isOpen"><slot /></aside>' },
    IonInput: { props: ['modelValue', 'type'], emits: ['update:modelValue'], template: '<input :type="type" :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)">' },
    IonCheckbox: { props: ['modelValue'], emits: ['update:modelValue'], template: '<label><input type="checkbox" :checked="modelValue" @change="$emit(\'update:modelValue\', $event.target.checked)"><slot /></label>' },
    IonSpinner: { template: '<span />' },
    RouterLink: { props: ['to'], template: '<a :href="to"><slot /></a>' },
  } } })
}
