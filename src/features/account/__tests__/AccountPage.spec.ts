import { flushPromises, mount } from '@vue/test-utils'
import { IonicVue } from '@ionic/vue'
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

  it('lays settings out as inset Ionic lists with built-in chevrons only on rows that navigate', async () => {
    useSession('firebase')
    useAuth(['password'])
    const wrapper = mountPage()
    await flushPromises()

    expect(wrapper.findAll('[data-list-inset]')).toHaveLength(4)
    const hasChevron = (element: { attributes(name: string): string | undefined }) => element.attributes('data-detail') !== undefined && element.attributes('data-detail') !== 'false'
    for (const path of ['/tabs/account/appearance', '/tabs/account/language', '/tabs/account/currencies', '/tabs/account/transactions/import', '/tabs/account/export']) {
      expect(hasChevron(wrapper.get(`a[href="${path}"]`))).toBe(true)
    }
    const clear = wrapper.findAll('button').find((button) => button.text().includes('Clear local data'))!
    const signOut = wrapper.findAll('button').find((button) => button.text().includes('Sign out'))!
    expect(hasChevron(clear)).toBe(false)
    expect(hasChevron(signOut)).toBe(false)
    expect(hasChevron(wrapper.get('[data-testid="open-account-delete"]'))).toBe(true)
    expect(wrapper.get('#account-name').attributes('aria-label')).toBe('Name')
    expect(wrapper.get('[data-testid="paypal-handle"]').attributes()).toMatchObject({ 'aria-label': 'PayPal', inputmode: 'text', maxlength: '65', autocomplete: 'off' })
  })

  it('saves both notification switches through the same explicit Save action', async () => {
    const repository = createDemoRepository()
    setAppSessionForTesting(createAppSession({ repository, commandStorage: createMemoryCommandStorage() }))
    const wrapper = mountPage()
    await flushPromises()

    const [email, push] = wrapper.findAll<HTMLInputElement>('input[role="switch"]')
    expect(email!.element.checked).toBe(true)
    expect(push!.element.checked).toBe(true)
    expect(email!.element.closest('label')!.textContent).toContain('Email notifications')
    expect(push!.element.closest('label')!.textContent).toContain('Push notifications')

    await email!.setValue(false)
    expect(await repository.notifications.getPreferences()).toEqual({ emailEnabled: true, pushEnabled: true })
    await wrapper.get('[data-action="save-notifications"]').trigger('click')

    await vi.waitFor(async () => expect(await repository.notifications.getPreferences()).toEqual({ emailEnabled: false, pushEnabled: true }))
    expect(wrapper.get('[role="status"]').text()).toBe('Notification preferences saved.')
  })

  it('returns focus to the Clear local data row when its confirmation is cancelled', async () => {
    useSession('firebase')
    useAuth(['password'])
    const wrapper = mountPage({ attachTo: document.body })
    await flushPromises()

    const clear = wrapper.findAll('button').find((button) => button.text().includes('Clear local data'))!
    await clear.trigger('click')
    const alert = wrapper.findAllComponents({ name: 'IonAlert' }).find((candidate) => candidate.props('isOpen'))!
    expect(alert.props('header')).toBe('Clear local data?')
    const cancel = (alert.props('buttons') as Array<{ role?: string; handler: () => unknown }>).find(({ role }) => role === 'cancel')!
    await cancel.handler()
    await flushPromises()

    expect(document.activeElement).toBe(clear.element)
    wrapper.unmount()
  })

  it('wires the real Ionic inputs, switches, and save buttons to the account state', async () => {
    const repository = createDemoRepository()
    setAppSessionForTesting(createAppSession({ repository, commandStorage: createMemoryCommandStorage() }))
    const wrapper = mount(AccountPage, { attachTo: document.body, global: { plugins: [createPinia(), [IonicVue, { mode: 'ios' }]], stubs: {
      IonPage: { template: '<main class="ion-page"><slot /></main>' },
      IonHeader: { template: '<header><slot /></header>' },
      IonContent: { template: '<section><slot /></section>' },
      IonAlert: true,
      IonModal: true,
    } } })
    await settleIonic()

    expect(wrapper.get('[data-testid="paypal-handle"]').element.tagName).toBe('ION-INPUT')
    const name = wrapper.get<HTMLInputElement>('#account-name input')
    expect(name.element.value).toBe('Maya P.')
    expect(name.attributes('autocomplete')).toBe('name')
    expect(document.getElementById(name.attributes('aria-labelledby')!)?.textContent).toBe('Name')
    const paypal = wrapper.get<HTMLInputElement>('[data-testid="paypal-handle"] input')
    expect(paypal.attributes()).toMatchObject({ autocomplete: 'off', inputmode: 'text', maxlength: '65' })
    const toggles = wrapper.findAll('ion-toggle')
    expect(toggles.map((toggle) => toggle.attributes('role'))).toEqual(['switch', 'switch'])
    expect(toggles.map((toggle) => toggle.attributes('aria-checked'))).toEqual(['true', 'true'])

    paypal.element.value = '@maya.payments'
    await paypal.trigger('input')
    ;(toggles[1]!.element as HTMLElement).click()
    await settleIonic()
    expect(toggles[1]!.attributes('aria-checked')).toBe('false')

    await wrapper.get('[data-action="save-profile"]').trigger('click')
    await vi.waitFor(async () => expect((await repository.app.getCurrentUser()).paymentHandles).toEqual({ paypal: 'maya.payments' }), { timeout: 10_000 })
    await wrapper.get('[data-action="save-notifications"]').trigger('click')
    await vi.waitFor(async () => expect(await repository.notifications.getPreferences()).toEqual({ emailEnabled: true, pushEnabled: false }), { timeout: 10_000 })
    wrapper.unmount()
  }, 20_000)

  it('returns focus into the real Ionic row button after a cancelled confirmation', async () => {
    useSession('firebase')
    useAuth(['password'])
    const wrapper = mount(AccountPage, { attachTo: document.body, global: { plugins: [createPinia(), [IonicVue, { mode: 'ios' }]], stubs: {
      IonPage: { template: '<main class="ion-page"><slot /></main>' },
      IonHeader: { template: '<header><slot /></header>' },
      IonContent: { template: '<section><slot /></section>' },
      IonAlert: { name: 'IonAlert', props: ['isOpen', 'header', 'message', 'buttons'], template: '<div />' },
      IonModal: true,
    } } })
    await settleIonic()

    const clear = wrapper.findAll('ion-item').find((item) => item.text().includes('Clear local data'))!
    const nativeButton = clear.element.shadowRoot?.querySelector('button')
    expect(nativeButton).toBeTruthy()
    await clear.trigger('click')
    const alert = wrapper.findAllComponents({ name: 'IonAlert' }).find((candidate) => candidate.props('isOpen'))!
    await (alert.props('buttons') as Array<{ role?: string; handler: () => unknown }>).find(({ role }) => role === 'cancel')!.handler()
    await flushPromises()

    expect(document.activeElement).toBe(clear.element)
    expect(clear.element.shadowRoot?.activeElement).toBe(nativeButton)
    wrapper.unmount()
  }, 20_000)

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

// Stencil flushes Ionic's renders on animation frames after Vue mounts or updates the elements.
async function settleIonic(): Promise<void> {
  for (let frame = 0; frame < 3; frame += 1) {
    await flushPromises()
    await new Promise((resolve) => requestAnimationFrame(resolve))
  }
  await flushPromises()
}

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

function mountPage(options: { readonly attachTo?: HTMLElement } = {}) {
  return mount(AccountPage, { ...options, global: { plugins: [createPinia()], stubs: {
    IonPage: { name: 'IonPage', template: '<main class="ion-page"><slot /></main>' },
    IonHeader: { template: '<header><slot /></header>' },
    IonToolbar: { template: '<div><slot /></div>' },
    IonTitle: { template: '<div><slot /></div>' },
    IonButtons: { template: '<div><slot /></div>' },
    IonButton: { props: ['disabled'], template: '<button :disabled="disabled"><slot /></button>' },
    IonContent: { template: '<section><slot /></section>' },
    IonIcon: { template: '<span />' },
    IonList: { props: ['inset', 'lines'], template: '<section :data-list-inset="inset"><slot /></section>' },
    IonItem: {
      props: ['routerLink', 'button', 'detail', 'disabled', 'lines'],
      template: '<a v-if="routerLink" :href="routerLink" :data-detail="detail"><slot /></a><button v-else-if="button !== undefined" type="button" :disabled="disabled" :data-detail="detail"><slot /></button><div v-else><slot /></div>',
    },
    IonLabel: { template: '<span><slot /></span>' },
    IonToggle: { props: ['modelValue'], emits: ['update:modelValue'], template: '<label><input type="checkbox" role="switch" :checked="modelValue" @change="$emit(\'update:modelValue\', $event.target.checked)"><slot /></label>' },
    IonAlert: { name: 'IonAlert', props: ['isOpen', 'header', 'message', 'buttons'], template: '<div />' },
    IonModal: { name: 'IonModal', props: ['isOpen', 'canDismiss', 'presentingElement'], emits: ['didDismiss'], template: '<aside v-if="isOpen"><slot /></aside>' },
    IonInput: { props: ['modelValue', 'type', 'label'], emits: ['update:modelValue'], template: '<input :type="type" :aria-label="label" :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)">' },
    IonCheckbox: { props: ['modelValue'], emits: ['update:modelValue'], template: '<label><input type="checkbox" :checked="modelValue" @change="$emit(\'update:modelValue\', $event.target.checked)"><slot /></label>' },
    IonSpinner: { template: '<span />' },
    RouterLink: { props: ['to'], template: '<a :href="to"><slot /></a>' },
  } } })
}
