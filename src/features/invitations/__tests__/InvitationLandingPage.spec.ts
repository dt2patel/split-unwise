import { flushPromises, mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { localeController } from '../../../app/i18n'
import InvitationLandingPage from '../InvitationLandingPage.vue'
import { captureInvitationFragment, consumeTransientInvitationSecret } from '../invitations'

const mocks = vi.hoisted(() => ({
  authState: {
    status: 'signed-in' as const,
    mode: 'firebase' as const,
    identity: { uid: 'invitee', displayName: 'Shreya', email: 'shreyakothari898@gmail.com', emailVerified: false, providerIds: ['password'] },
  },
  inspect: vi.fn(),
  accept: vi.fn(),
  sendVerification: vi.fn(),
  refreshIdentity: vi.fn(),
}))

vi.mock('../../../data/session', () => ({ peekActiveAppSession: () => ({ repository: { mode: 'firebase' } }) }))
vi.mock('../../../data/firebase', () => ({ getActiveRuntimeConfiguration: () => ({ kind: 'firebase', firebase: { projectId: 'split-unwise-aditya' } }) }))
vi.mock('../../../data/firebaseSparkMutations', () => ({
  inspectSparkInvitation: (...args: unknown[]) => mocks.inspect(...args),
  acceptSparkInvitation: (...args: unknown[]) => mocks.accept(...args),
}))
vi.mock('../../auth/authService', () => ({
  getAuthService: () => ({
    getState: () => mocks.authState,
    sendVerification: mocks.sendVerification,
    refreshIdentity: mocks.refreshIdentity,
  }),
}))
vi.mock('../../../data/firebaseCallables', () => ({ callSplitUnwiseFunction: vi.fn() }))

const stubs = {
  IonPage: { template: '<div><slot /></div>' },
  IonContent: { template: '<main><slot /></main>' },
  IonIcon: { template: '<i />' },
  IonSpinner: { template: '<i />' },
  IonButton: { props: ['disabled'], emits: ['click'], template: '<button type="button" :disabled="disabled" @click="$emit(\'click\')"><slot /></button>' },
}

describe('invitation landing page', () => {
  beforeEach(() => {
    localeController.setPreference('es')
    mocks.inspect.mockReset()
    mocks.accept.mockReset()
    mocks.sendVerification.mockReset()
    mocks.refreshIdentity.mockReset()
    consumeTransientInvitationSecret('join')
    captureInvitationFragment('join', {
      hash: `#token=${'a'.repeat(43)}`, pathname: '/invite/join', search: '',
    } as Location, { replaceState: vi.fn() } as unknown as History)
    mocks.inspect.mockRejectedValue(new Error('Sign in with the verified email named by this invitation.'))
    mocks.sendVerification.mockResolvedValue(undefined)
    mocks.refreshIdentity.mockResolvedValue({ ...mocks.authState.identity, emailVerified: false })
  })

  it('turns an unverified targeted invitation into a recoverable verification flow', async () => {
    const wrapper = await mountInvitation()

    await vi.waitFor(() => expect(wrapper.find('[data-testid="invitation-verification-required"]').exists()).toBe(true))
    expect(wrapper.get('[data-testid="invitation-verification-required"]').text()).toContain('Verifica shreyakothari898@gmail.com para aceptar esta invitación.')
    await wrapper.get('[data-testid="send-invitation-verification"]').trigger('click')
    await flushPromises()

    expect(mocks.sendVerification).toHaveBeenCalledOnce()
    expect(wrapper.get('[role="status"]').text()).toBe('Correo de verificación enviado. Ábrelo, vuelve aquí y comprueba de nuevo.')
  })

  it('rechecks Firebase identity and resumes the same invitation after verification', async () => {
    mocks.refreshIdentity.mockResolvedValue({ ...mocks.authState.identity, emailVerified: true })
    mocks.inspect.mockRejectedValueOnce(new Error('Sign in with the verified email named by this invitation.')).mockResolvedValueOnce({
      groupId: 'group-trips', groupName: 'Viaje Ñandú', alreadyMember: false,
    })
    const wrapper = await mountInvitation()

    await vi.waitFor(() => expect(wrapper.find('[data-testid="invitation-verification-required"]').exists()).toBe(true))
    await wrapper.get('[data-testid="recheck-invitation-verification"]').trigger('click')
    await vi.waitFor(() => expect(wrapper.text()).toContain('Te invitaron a unirte a Viaje Ñandú.'))

    expect(mocks.refreshIdentity).toHaveBeenCalledOnce()
    expect(mocks.inspect).toHaveBeenCalledTimes(2)
    expect(wrapper.get('button').text()).toContain('Unirse al grupo')
  })

  it('retranslates a retained verification failure without sending again or exposing its diagnostic', async () => {
    mocks.sendVerification.mockRejectedValueOnce(new Error('sensitive verification delivery detail'))
    const wrapper = await mountInvitation()

    await vi.waitFor(() => expect(wrapper.find('[data-testid="invitation-verification-required"]').exists()).toBe(true))
    await wrapper.get('[data-testid="send-invitation-verification"]').trigger('click')
    await flushPromises()

    expect(wrapper.get('[role="status"]').text()).toBe('No se pudo enviar el correo de verificación.')
    expect(wrapper.text()).not.toContain('sensitive verification delivery detail')
    expect(mocks.sendVerification).toHaveBeenCalledOnce()

    localeController.setPreference('de')
    await wrapper.vm.$nextTick()

    expect(wrapper.get('[role="status"]').text()).toBe('Die Bestätigungs-E-Mail konnte nicht gesendet werden.')
    expect(mocks.sendVerification).toHaveBeenCalledOnce()
  })

  it('shows only the localized generic failure when ordinary invitation acceptance fails', async () => {
    mocks.inspect.mockResolvedValueOnce({ groupId: 'group-trips', groupName: 'Viaje Ñandú', alreadyMember: false })
    mocks.accept.mockRejectedValueOnce(new Error('sensitive internal acceptance detail'))
    const wrapper = await mountInvitation()

    await vi.waitFor(() => expect(wrapper.text()).toContain('Te invitaron a unirte a Viaje Ñandú.'))
    await wrapper.get('button').trigger('click')
    await vi.waitFor(() => expect(wrapper.text()).toContain('No se pudo aceptar esta invitación.'))
    expect(wrapper.text()).not.toContain('sensitive internal acceptance detail')
  })
})

async function mountInvitation() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/invite/:invitationId', component: InvitationLandingPage },
      { path: '/auth', component: { template: '<div>Auth</div>' } },
      { path: '/tabs/groups/:groupId', component: { template: '<div>Group</div>' } },
      { path: '/tabs/home', component: { template: '<div>Home</div>' } },
    ],
  })
  await router.push('/invite/join'); await router.isReady()
  const wrapper = mount(InvitationLandingPage, { global: { plugins: [router], stubs } })
  await flushPromises()
  return wrapper
}
