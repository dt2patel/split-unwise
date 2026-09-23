import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { IonicVue } from '@ionic/vue'
import { createPinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { localeController } from '../../../app/i18n'
import { setAuthService, type AuthService } from '../authService'
import AuthPage from '../AuthPage.vue'

enableAutoUnmount(afterEach)

function useSignedOutAuth() {
  const service = {
    mode: 'firebase',
    capabilities: { auth: 'available', firestore: 'available', storage: 'unavailable', functions: 'unavailable', appCheck: 'unavailable', push: 'unavailable', google: 'available', apple: 'unavailable' },
    getState: () => ({ status: 'signed-out', mode: 'firebase' }),
    subscribe: vi.fn(() => () => undefined),
    signInWithEmail: vi.fn().mockResolvedValue({ status: 'complete' }),
    signUpWithEmail: vi.fn().mockResolvedValue({ status: 'complete' }),
    signInWithGoogle: vi.fn().mockResolvedValue({ status: 'cancelled' }),
    sendPasswordReset: vi.fn().mockResolvedValue(undefined),
  }
  setAuthService(service as unknown as AuthService)
  return service
}

// Real Ionic inputs and buttons (attached, so their custom elements connect and render the native controls).
async function mountAuthPage() {
  const wrapper = mount(AuthPage, { attachTo: document.body, global: { plugins: [createPinia(), [IonicVue, { mode: 'ios' }]], stubs: {
    IonPage: { template: '<div class="ion-page"><slot /></div>' },
    IonContent: { template: '<section><slot /></section>' },
  } } })
  await settleIonic()
  return wrapper
}

// Stencil flushes Ionic's renders on animation frames after Vue mounts or updates the elements.
async function settleIonic(): Promise<void> {
  for (let frame = 0; frame < 3; frame += 1) {
    await flushPromises()
    await new Promise((resolve) => requestAnimationFrame(resolve))
  }
  await flushPromises()
}

function labelOf(input: HTMLInputElement): string | undefined {
  return document.getElementById(input.getAttribute('aria-labelledby') ?? '')?.textContent?.trim()
}

async function type(input: HTMLInputElement, value: string): Promise<void> {
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await flushPromises()
}

beforeEach(() => localeController.setPreference('en'))

describe('Auth page', () => {
  it('keeps the sign-in autofill contract on the native inputs Ionic renders', async () => {
    useSignedOutAuth()
    const wrapper = await mountAuthPage()

    const emailHost = wrapper.get('#auth-email')
    expect(emailHost.element.tagName).toBe('ION-INPUT')
    const email = wrapper.get<HTMLInputElement>('#auth-email input').element
    expect(email.getAttribute('type')).toBe('email')
    expect(email.getAttribute('inputmode')).toBe('email')
    expect(email.getAttribute('autocomplete')).toBe('email')
    expect(email.getAttribute('name')).toBe('email')
    expect(email.required).toBe(true)
    expect(email.form).toBe(wrapper.get('form').element)
    expect(labelOf(email)).toBe('Email')

    const password = wrapper.get<HTMLInputElement>('#auth-password input').element
    expect(password.getAttribute('type')).toBe('password')
    expect(password.getAttribute('autocomplete')).toBe('current-password')
    expect(password.getAttribute('name')).toBe('password')
    expect(password.getAttribute('minlength')).toBe('8')
    expect(password.required).toBe(true)
    expect(password.form).toBe(wrapper.get('form').element)
    expect(labelOf(password)).toBe('Password')
    expect(wrapper.find('#auth-name').exists()).toBe(false)
  }, 20_000)

  it('switches to the new-password contract and a named field when creating an account', async () => {
    useSignedOutAuth()
    const wrapper = await mountAuthPage()

    const createAccount = wrapper.get('[data-action="show-sign-up"]')
    expect(createAccount.element.tagName).toBe('ION-BUTTON')
    expect(createAccount.attributes('fill')).toBe('clear')
    expect(createAccount.attributes('size')).toBe('small')
    await createAccount.trigger('click')
    await settleIonic()

    expect(wrapper.get('h1').text()).toBe('Create your account')
    const name = wrapper.get<HTMLInputElement>('#auth-name input').element
    expect(name.getAttribute('autocomplete')).toBe('name')
    expect(name.getAttribute('name')).toBe('name')
    expect(name.required).toBe(true)
    expect(labelOf(name)).toBe('Name')
    expect(wrapper.get<HTMLInputElement>('#auth-password input').element.getAttribute('autocomplete')).toBe('new-password')

    await wrapper.get('[data-action="show-sign-in"]').trigger('click')
    await settleIonic()
    expect(wrapper.get('h1').text()).toBe('Welcome back')
    expect(wrapper.get<HTMLInputElement>('#auth-password input').element.getAttribute('autocomplete')).toBe('current-password')

    await wrapper.get('[data-action="show-reset"]').trigger('click')
    await settleIonic()
    expect(wrapper.get('h1').text()).toBe('Reset your password')
    expect(wrapper.find('#auth-password').exists()).toBe(false)
  }, 20_000)

  it('submits typed credentials through the form submit button and relabels on a language change', async () => {
    const service = useSignedOutAuth()
    const wrapper = await mountAuthPage()
    const form = wrapper.get('form').element
    expect(form.querySelector('button[type="submit"]')).not.toBeNull()

    await type(wrapper.get<HTMLInputElement>('#auth-email input').element, 'maya@example.com')
    await type(wrapper.get<HTMLInputElement>('#auth-password input').element, 'long-enough')
    const submit = wrapper.findAll('ion-button').find((button) => button.text() === 'Sign in')!
    await submit.trigger('click')
    await flushPromises()

    expect(service.signInWithEmail).toHaveBeenCalledWith('maya@example.com', 'long-enough')

    localeController.setPreference('es')
    await settleIonic()
    expect(labelOf(wrapper.get<HTMLInputElement>('#auth-email input').element)).toBe('Correo electrónico')
    expect(labelOf(wrapper.get<HTMLInputElement>('#auth-password input').element)).toBe('Contraseña')
  }, 20_000)

  it('marks invalid fields on the native inputs and focuses the error summary', async () => {
    const service = useSignedOutAuth()
    const wrapper = await mountAuthPage()

    await type(wrapper.get<HTMLInputElement>('#auth-email input').element, 'not-an-email')
    await type(wrapper.get<HTMLInputElement>('#auth-password input').element, 'short')
    wrapper.get('form').element.requestSubmit()
    await settleIonic()

    expect(service.signInWithEmail).not.toHaveBeenCalled()
    const email = wrapper.get<HTMLInputElement>('#auth-email input').element
    const password = wrapper.get<HTMLInputElement>('#auth-password input').element
    expect(email.getAttribute('aria-invalid')).toBe('true')
    expect(password.getAttribute('aria-invalid')).toBe('true')
    expect(document.getElementById(email.getAttribute('aria-describedby')!)?.textContent).toBe('Enter a valid email address.')
    expect(document.getElementById(password.getAttribute('aria-describedby')!)?.textContent).toBe('Use at least 8 characters.')
    expect(document.activeElement).toBe(wrapper.get('.auth-error').element)

    await type(email, 'maya@example.com')
    await type(password, 'long-enough')
    wrapper.get('form').element.requestSubmit()
    await settleIonic()

    expect(service.signInWithEmail).toHaveBeenCalledWith('maya@example.com', 'long-enough')
    expect(email.getAttribute('aria-invalid')).toBeNull()
    expect(wrapper.find('#auth-email-error').exists()).toBe(false)
  }, 20_000)
})
