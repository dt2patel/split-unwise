import { flushPromises, mount } from '@vue/test-utils'
import { createRouter, createWebHistory } from 'vue-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from '../../App.vue'

vi.mock('../../data/session', () => ({ peekActiveAppSession: () => undefined }))
vi.mock('../../components/AppStatus.vue', () => ({ default: { template: '<div />' } }))

describe('root application surface', () => {
  afterEach(() => window.history.replaceState({}, '', '/'))

  it('mounts the auth route after an invitation asks the user to sign in', async () => {
    window.history.replaceState({}, '', '/invite/join')
    const router = createRouter({
      history: createWebHistory(),
      routes: [
        { path: '/invite/:invitationId', component: { template: '<div data-testid="invitation-route">Invitation</div>' } },
        { path: '/auth', component: { template: '<input id="auth-email">' } },
      ],
    })
    const wrapper = mount(App, {
      global: {
        plugins: [router],
        stubs: {
          IonApp: { template: '<div><slot /></div>' },
          IonRouterOutlet: { template: '<router-view />' },
          AppStatus: true,
          AuthPage: { template: '<input id="auth-email">' },
          InvitationLandingPage: { template: '<div data-testid="invitation-route">Invitation</div>' },
        },
      },
    })
    await router.isReady()
    await flushPromises()

    expect(wrapper.find('[data-testid="invitation-route"]').exists()).toBe(true)
    await router.push('/auth')
    await flushPromises()

    expect(wrapper.find('#auth-email').exists()).toBe(true)
    expect(wrapper.find('[data-testid="invitation-route"]').exists()).toBe(false)
  })
})
