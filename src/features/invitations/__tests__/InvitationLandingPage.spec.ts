import { flushPromises, mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
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

    await vi.waitFor(() => expect(wrapper.text()).not.toContain('Checking invitation'))
    expect(wrapper.get('[data-testid="invitation-verification-required"]').text()).toContain('Verify shreyakothari898@gmail.com')
    await wrapper.get('[data-testid="send-invitation-verification"]').trigger('click')
    await flushPromises()

    expect(mocks.sendVerification).toHaveBeenCalledOnce()
    expect(wrapper.get('[role="status"]').text()).toContain('Verification email sent')
  })

  it('rechecks Firebase identity and resumes the same invitation after verification', async () => {
    mocks.refreshIdentity.mockResolvedValue({ ...mocks.authState.identity, emailVerified: true })
    mocks.inspect.mockRejectedValueOnce(new Error('Sign in with the verified email named by this invitation.')).mockResolvedValueOnce({
      groupId: 'group-trips', groupName: 'Trips', alreadyMember: false,
    })
    const wrapper = await mountInvitation()

    await vi.waitFor(() => expect(wrapper.text()).not.toContain('Checking invitation'))
    await wrapper.get('[data-testid="recheck-invitation-verification"]').trigger('click')
    await vi.waitFor(() => expect(wrapper.text()).toContain('You’re invited to join Trips.'))

    expect(mocks.refreshIdentity).toHaveBeenCalledOnce()
    expect(mocks.inspect).toHaveBeenCalledTimes(2)
    expect(wrapper.get('button').text()).toContain('Join group')
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
