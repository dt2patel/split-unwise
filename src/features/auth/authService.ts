import type { RuntimeCapabilities } from '../../data/firebase'
import type { AccountDeletionProgress } from '../../data/firebaseAccountDeletion'

export interface AuthIdentity {
  readonly uid: string
  readonly displayName: string
  readonly email?: string
  readonly emailVerified: boolean
  readonly photoURL?: string
  readonly providerIds: readonly string[]
}

export type AuthState =
  | { readonly status: 'loading'; readonly mode: 'demo' | 'firebase' }
  | { readonly status: 'signed-out'; readonly mode: 'firebase' }
  | { readonly status: 'signed-in'; readonly mode: 'demo' | 'firebase'; readonly identity: AuthIdentity }
  | { readonly status: 'error'; readonly mode: 'firebase'; readonly message: string }

export type AuthActionResult = { readonly status: 'complete' } | { readonly status: 'cancelled' } | { readonly status: 'redirecting' }

export interface AccountDeletionInput {
  readonly password?: string
  readonly onProgress?: (progress: AccountDeletionProgress) => void
}

export interface AuthService {
  readonly mode: 'demo' | 'firebase'
  readonly capabilities: RuntimeCapabilities
  getState(): AuthState
  subscribe(listener: (state: AuthState) => void): () => void
  signInWithEmail(email: string, password: string): Promise<AuthActionResult>
  signUpWithEmail(displayName: string, email: string, password: string): Promise<AuthActionResult>
  signInWithGoogle(returnTo?: string): Promise<AuthActionResult>
  sendPasswordReset(email: string): Promise<void>
  sendVerification(): Promise<void>
  refreshIdentity(): Promise<AuthIdentity | undefined>
  deleteAccount(input: AccountDeletionInput): Promise<void>
  signOut(): Promise<void>
  reportSessionError?(message: string): void
  dispose(): void
}

let activeAuthService: AuthService | undefined

export function setAuthService(service: AuthService | undefined): void { activeAuthService = service }
export function peekAuthService(): AuthService | undefined { return activeAuthService }
export function getAuthService(): AuthService {
  if (!activeAuthService) throw new Error('Authentication has not been initialized')
  return activeAuthService
}

export function createConfigurationErrorAuthService(message: string, capabilities: RuntimeCapabilities): AuthService {
  return staticService({ status: 'error', mode: 'firebase', message }, capabilities)
}

export function createDemoAuthService(identity: AuthIdentity, capabilities: RuntimeCapabilities): AuthService {
  return staticService({ status: 'signed-in', mode: 'demo', identity: sanitizeAuthIdentity(identity) }, capabilities)
}

function staticService(state: AuthState, capabilities: RuntimeCapabilities): AuthService {
  return {
    mode: state.mode, capabilities,
    getState: () => state,
    subscribe(listener) { listener(state); return () => undefined },
    async signInWithEmail() { return { status: 'complete' } },
    async signUpWithEmail() { return { status: 'complete' } },
    async signInWithGoogle() { return { status: 'complete' } },
    async sendPasswordReset() {},
    async sendVerification() {},
    async refreshIdentity() { return state.status === 'signed-in' ? state.identity : undefined },
    async deleteAccount() { throw new Error('Demo mode uses a fixed local identity') },
    async signOut() { throw new Error('Demo mode uses a fixed local identity') },
    reportSessionError() {},
    dispose() {},
  }
}

export function sanitizeAuthIdentity(input: AuthIdentity): AuthIdentity {
  const uid = required(input.uid, 'UID')
  const displayName = required(input.displayName, 'display name').slice(0, 120)
  const email = input.email?.trim().toLowerCase()
  const photoURL = safePhotoUrl(input.photoURL)
  const providerIds = [...new Set(input.providerIds.map((provider) => provider.trim()).filter(Boolean))].sort()
  return { uid, displayName, emailVerified: Boolean(input.emailVerified), ...(email ? { email } : {}), ...(photoURL ? { photoURL } : {}), providerIds }
}

function required(value: string, label: string): string {
  const trimmed = value.trim()
  if (!trimmed) throw new Error(`Authentication ${label} is missing`)
  return trimmed
}

function safePhotoUrl(value: string | undefined): string | undefined {
  if (!value) return undefined
  try {
    const url = new URL(value)
    return url.protocol === 'https:' ? url.href : undefined
  } catch { return undefined }
}
