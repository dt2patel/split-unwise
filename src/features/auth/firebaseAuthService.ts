import type { Auth, User } from 'firebase/auth'
import type { RuntimeCapabilities } from '../../data/firebase'
import { getSplitUnwiseFirebaseAuth } from '../../data/firebaseBootstrap'
import type { FirebaseConfiguration } from '../../data/firebase'
import { prepareFirebaseAccountDeletion, type AccountDeletionPreparationInput } from '../../data/firebaseAccountDeletion'
import { sanitizeInternalReturnPath, storeReturnPath } from './returnPath'
import { sanitizeAuthIdentity, type AccountDeletionInput, type AuthActionResult, type AuthIdentity, type AuthService, type AuthState } from './authService'
import { synchronizeFirebaseProfile } from '../../data/firebaseSparkMutations'

interface FirebaseAccountDeletionUser {
  readonly uid: string
  readonly email: string | null
  readonly emailVerified: boolean
  readonly providerData: readonly { readonly providerId: string | null }[]
}

export interface FirebaseAccountDeletionDependencies<
  TUser extends FirebaseAccountDeletionUser,
  TPasswordCredential,
  TGoogleProvider,
> {
  currentUser(): TUser | null
  passwordCredential(email: string, password: string): TPasswordCredential
  reauthenticateWithCredential(user: TUser, credential: TPasswordCredential): Promise<void>
  googleProvider(): TGoogleProvider
  reauthenticateWithPopup(user: TUser, provider: TGoogleProvider): Promise<void>
  prepare(input: AccountDeletionPreparationInput): Promise<unknown>
  deleteUser(user: TUser): Promise<void>
}

export function accountDeletionProvider(identity: Pick<AuthIdentity, 'providerIds'>): 'password' | 'google' {
  if (identity.providerIds.includes('password')) return 'password'
  if (identity.providerIds.includes('google.com')) return 'google'
  throw new Error('Account deletion is not supported for this sign-in provider.')
}

export function createFirebaseAccountDeletionAction<
  TUser extends FirebaseAccountDeletionUser,
  TPasswordCredential,
  TGoogleProvider,
>(dependencies: FirebaseAccountDeletionDependencies<TUser, TPasswordCredential, TGoogleProvider>): (input: AccountDeletionInput) => Promise<void> {
  return async (input) => {
    const user = dependencies.currentUser()
    if (!user) throw new Error('Sign in before deleting your account.')
    const providerIds = user.providerData.flatMap(({ providerId }) => typeof providerId === 'string' && providerId ? [providerId] : [])
    const provider = accountDeletionProvider({ providerIds })
    try {
      if (provider === 'password') {
        if (!user.email || !input.password) throw new Error('Enter your current password.')
        const credential = dependencies.passwordCredential(user.email, input.password)
        await dependencies.reauthenticateWithCredential(user, credential)
      } else {
        await dependencies.reauthenticateWithPopup(user, dependencies.googleProvider())
      }
      await dependencies.prepare({
        uid: user.uid,
        ...(user.emailVerified && user.email ? { email: normalizeEmail(user.email) } : {}),
        ...(input.onProgress ? { onProgress: input.onProgress } : {}),
      })
      await dependencies.deleteUser(user)
    } catch (error: unknown) {
      throw accountDeletionError(error)
    }
  }
}

export async function createFirebaseAuthService(configuration: FirebaseConfiguration, capabilities: RuntimeCapabilities): Promise<AuthService> {
  const [auth, firebase] = await Promise.all([getSplitUnwiseFirebaseAuth(configuration), import('firebase/auth')])
  const deleteAccount = createFirebaseAccountDeletionAction({
    currentUser: () => auth.currentUser,
    passwordCredential: (email, password) => firebase.EmailAuthProvider.credential(email, password),
    async reauthenticateWithCredential(user, credential) { await firebase.reauthenticateWithCredential(user, credential) },
    googleProvider() {
      const provider = new firebase.GoogleAuthProvider()
      provider.setCustomParameters({ prompt: 'select_account' })
      return provider
    },
    async reauthenticateWithPopup(user, provider) { await firebase.reauthenticateWithPopup(user, provider) },
    async prepare(input) { await prepareFirebaseAccountDeletion(configuration, input) },
    async deleteUser(user) { await firebase.deleteUser(user) },
  })
  let state: AuthState = { status: 'loading', mode: 'firebase' }
  const listeners = new Set<(state: AuthState) => void>()
  let unsubscribe: () => void = () => undefined
  let disposed = false
  const publish = (next: AuthState) => {
    if (disposed) return
    state = next
    listeners.forEach((listener) => { try { listener(next) } catch { /* observers cannot break auth */ } })
  }

  void auth.authStateReady().then(() => {
    if (disposed) return
    unsubscribe = firebase.onAuthStateChanged(auth,
      (user) => publish(user ? { status: 'signed-in', mode: 'firebase', identity: identityFromUser(user) } : { status: 'signed-out', mode: 'firebase' }),
      (error) => publish({ status: 'error', mode: 'firebase', message: safeAuthMessage(error) }),
    )
  }).catch((error: unknown) => publish({ status: 'error', mode: 'firebase', message: safeAuthMessage(error) }))

  const service: AuthService = {
    mode: 'firebase', capabilities,
    getState: () => state,
    subscribe(listener) { listeners.add(listener); listener(state); return () => listeners.delete(listener) },
    async signInWithEmail(email, password) {
      await firebase.signInWithEmailAndPassword(auth, normalizeEmail(email), password)
      return { status: 'complete' }
    },
    async signUpWithEmail(displayName, email, password) {
      const credential = await firebase.createUserWithEmailAndPassword(auth, normalizeEmail(email), password)
      await firebase.updateProfile(credential.user, { displayName: displayName.trim().slice(0, 120) })
      await synchronizeFirebaseProfile(configuration, credential.user)
      await firebase.sendEmailVerification(credential.user)
      return { status: 'complete' }
    },
    async signInWithGoogle(returnTo) {
      if (capabilities.google !== 'available') throw new Error('Google sign-in is not configured')
      const safeReturn = sanitizeInternalReturnPath(returnTo)
      if (safeReturn) storeReturnPath(safeReturn)
      const provider = new firebase.GoogleAuthProvider()
      provider.setCustomParameters({ prompt: 'select_account' })
      if (prefersRedirect()) {
        await firebase.signInWithRedirect(auth, provider)
        return { status: 'redirecting' }
      }
      try {
        await firebase.signInWithPopup(auth, provider)
        return { status: 'complete' }
      } catch (error: unknown) {
        const code = firebaseErrorCode(error)
        if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') return { status: 'cancelled' }
        if (code === 'auth/popup-blocked' || code === 'auth/operation-not-supported-in-this-environment') {
          await firebase.signInWithRedirect(auth, provider)
          return { status: 'redirecting' }
        }
        throw error
      }
    },
    async sendPasswordReset(email) { await firebase.sendPasswordResetEmail(auth, normalizeEmail(email)) },
    async sendVerification() {
      if (!auth.currentUser) throw new Error('Sign in before requesting email verification')
      await firebase.sendEmailVerification(auth.currentUser)
    },
    async refreshIdentity() {
      const user = auth.currentUser
      if (!user) return undefined
      await firebase.reload(user)
      await user.getIdToken(true)
      const identity = identityFromUser(user)
      publish({ status: 'signed-in', mode: 'firebase', identity })
      return identity
    },
    deleteAccount,
    async signOut() { await firebase.signOut(auth) },
    reportSessionError(message) { publish({ status: 'error', mode: 'firebase', message: message.trim() || 'Your account could not be opened.' }) },
    dispose() { disposed = true; unsubscribe(); listeners.clear() },
  }
  return service
}

export function identityFromUser(user: Pick<User, 'uid' | 'displayName' | 'email' | 'emailVerified' | 'photoURL' | 'providerData'>): AuthIdentity {
  const fallbackName = user.email?.split('@')[0] ?? 'Split Unwise member'
  return sanitizeAuthIdentity({
    uid: user.uid,
    displayName: user.displayName ?? fallbackName,
    ...(user.email ? { email: user.email } : {}),
    emailVerified: user.emailVerified,
    ...(user.photoURL ? { photoURL: user.photoURL } : {}),
    providerIds: user.providerData.map(({ providerId }) => providerId),
  })
}

function normalizeEmail(value: string): string {
  const email = value.trim().toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Enter a valid email address')
  return email
}

function prefersRedirect(): boolean {
  if (typeof window === 'undefined') return false
  return window.matchMedia?.('(pointer: coarse)').matches === true || window.innerWidth < 768
}

function firebaseErrorCode(error: unknown): string | undefined { return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : undefined }
function accountDeletionError(error: unknown): Error {
  const code = firebaseErrorCode(error)
  if (code === 'auth/wrong-password' || code === 'auth/invalid-credential') return new Error('The password is incorrect.')
  if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') return new Error('Google reauthentication was cancelled.')
  if (code === 'auth/requires-recent-login') return new Error('Reauthenticate and try deleting the account again.')
  return error instanceof Error ? error : new Error('Account deletion could not be completed.')
}
function safeAuthMessage(error: unknown): string {
  const code = firebaseErrorCode(error)
  if (code === 'auth/invalid-credential') return 'The email or password is incorrect.'
  if (code === 'auth/email-already-in-use') return 'An account already uses this email.'
  if (code === 'auth/too-many-requests') return 'Too many attempts. Try again later.'
  return error instanceof Error && error.message ? error.message.replace(/^Firebase:\s*/i, '') : 'Authentication is temporarily unavailable.'
}
