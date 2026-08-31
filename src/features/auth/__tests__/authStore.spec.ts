import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { setAuthService, type AuthService, type AuthState } from '../authService'
import { useAuthStore } from '../authStore'

function service(initial: AuthState) {
  let listener: ((state: AuthState) => void) | undefined
  const mock = {
    mode: 'firebase',
    capabilities: { auth: 'available', firestore: 'available', storage: 'unavailable', functions: 'unavailable', appCheck: 'unavailable', push: 'unavailable', google: 'available', apple: 'unavailable' },
    getState: () => initial,
    subscribe: vi.fn((next) => { listener = next; next(initial); return () => undefined }),
    signInWithEmail: vi.fn().mockResolvedValue({ status: 'complete' }),
    signUpWithEmail: vi.fn().mockResolvedValue({ status: 'complete' }),
    signInWithGoogle: vi.fn().mockResolvedValue({ status: 'cancelled' }),
    sendPasswordReset: vi.fn().mockResolvedValue(undefined), sendVerification: vi.fn().mockResolvedValue(undefined), signOut: vi.fn().mockResolvedValue(undefined), dispose: vi.fn(),
  } as unknown as AuthService
  return { mock, emit: (state: AuthState) => listener?.(state) }
}

describe('auth store', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('tracks hydration transitions and validates linked fields before calling Firebase', async () => {
    const runtime = service({ status: 'loading', mode: 'firebase' })
    setAuthService(runtime.mock)
    const store = useAuthStore()
    expect(store.state.status).toBe('loading')
    runtime.emit({ status: 'signed-out', mode: 'firebase' })
    expect(store.state.status).toBe('signed-out')

    expect(await store.signIn('bad', 'short')).toBe(false)
    expect(store.fieldErrors).toMatchObject({ email: expect.any(String), password: expect.any(String) })
    expect(runtime.mock.signInWithEmail).not.toHaveBeenCalled()
    expect(await store.signIn('maya@example.com', 'long-enough')).toBe(true)
    expect(runtime.mock.signInWithEmail).toHaveBeenCalledWith('maya@example.com', 'long-enough')
  })

  it('treats Google cancellation as a non-error status', async () => {
    const runtime = service({ status: 'signed-out', mode: 'firebase' })
    setAuthService(runtime.mock)
    const store = useAuthStore()
    expect(await store.google('/tabs/home')).toBe(false)
    expect(store.error).toBe('')
    expect(store.notice).toBe('Sign-in cancelled.')
  })
})
