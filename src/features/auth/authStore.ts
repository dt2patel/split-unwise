import { defineStore } from 'pinia'
import { computed, onScopeDispose, ref } from 'vue'
import { getAuthService, type AuthActionResult, type AuthState } from './authService'

type AuthView = 'sign-in' | 'sign-up' | 'reset'

export const useAuthStore = defineStore('auth', () => {
  const service = getAuthService()
  const state = ref<AuthState>(service.getState())
  const view = ref<AuthView>('sign-in')
  const busy = ref(false)
  const error = ref('')
  const notice = ref('')
  const fieldErrors = ref<Readonly<Record<string, string>>>({})
  const unsubscribe = service.subscribe((next) => { state.value = next })
  onScopeDispose(unsubscribe)

  const canUseGoogle = computed(() => service.capabilities.google === 'available')
  const canUseApple = computed(() => false)

  function show(next: AuthView): void { view.value = next; error.value = ''; notice.value = ''; fieldErrors.value = {} }

  async function signIn(email: string, password: string): Promise<boolean> {
    if (!validateCredentials({ email, password })) return false
    return perform(async () => service.signInWithEmail(email, password))
  }
  async function signUp(displayName: string, email: string, password: string): Promise<boolean> {
    if (!validateCredentials({ displayName, email, password, signUp: true })) return false
    return perform(async () => service.signUpWithEmail(displayName, email, password), 'Account created. Check your inbox to verify your email.')
  }
  async function google(returnTo?: string): Promise<boolean> {
    return perform(async () => service.signInWithGoogle(returnTo))
  }
  async function resetPassword(email: string): Promise<boolean> {
    if (!validateCredentials({ email })) return false
    return perform(async () => { await service.sendPasswordReset(email); return { status: 'complete' } }, 'Password reset email sent.')
  }
  async function verification(): Promise<boolean> {
    return perform(async () => { await service.sendVerification(); return { status: 'complete' } }, 'Verification email sent.')
  }

  async function perform(action: () => Promise<AuthActionResult>, successNotice = ''): Promise<boolean> {
    if (busy.value) return false
    busy.value = true
    fieldErrors.value = {}
    error.value = ''
    notice.value = ''
    try {
      const result = await action()
      if (result.status === 'cancelled') { notice.value = 'Sign-in cancelled.'; return false }
      if (result.status === 'redirecting') notice.value = 'Opening Google sign-in…'
      else if (successNotice) notice.value = successNotice
      return true
    } catch (reason) {
      error.value = reason instanceof Error ? reason.message : 'Authentication is temporarily unavailable.'
      return false
    } finally { busy.value = false }
  }

  function validateCredentials(input: { readonly displayName?: string; readonly email: string; readonly password?: string; readonly signUp?: boolean }): boolean {
    const fields: Record<string, string> = {}
    if (input.signUp && !input.displayName?.trim()) fields.displayName = 'Enter your name.'
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email.trim())) fields.email = 'Enter a valid email address.'
    if (input.password !== undefined && input.password.length < 8) fields.password = 'Use at least 8 characters.'
    fieldErrors.value = fields
    if (Object.keys(fields).length === 0) return true
    error.value = 'Check the highlighted fields.'
    notice.value = ''
    return false
  }

  return { state, view, busy, error, notice, fieldErrors, canUseGoogle, canUseApple, show, signIn, signUp, google, resetPassword, verification }
})
