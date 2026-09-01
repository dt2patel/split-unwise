import type { Auth, User } from 'firebase/auth'
import type { RuntimeCapabilities } from '../../data/firebase'
import { getSplitUnwiseFirebaseApp } from '../../data/firebaseBootstrap'
import type { FirebaseConfiguration } from '../../data/firebase'
import { sanitizeInternalReturnPath, storeReturnPath } from './returnPath'
import { sanitizeAuthIdentity, type AuthActionResult, type AuthIdentity, type AuthService, type AuthState } from './authService'
import { synchronizeFirebaseProfile } from '../../data/firebaseSparkMutations'

export async function createFirebaseAuthService(configuration: FirebaseConfiguration, capabilities: RuntimeCapabilities): Promise<AuthService> {
  const [app, firebase] = await Promise.all([getSplitUnwiseFirebaseApp(configuration), import('firebase/auth')])
  const auth = firebase.getAuth(app)
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
function safeAuthMessage(error: unknown): string {
  const code = firebaseErrorCode(error)
  if (code === 'auth/invalid-credential') return 'The email or password is incorrect.'
  if (code === 'auth/email-already-in-use') return 'An account already uses this email.'
  if (code === 'auth/too-many-requests') return 'Too many attempts. Try again later.'
  return error instanceof Error && error.message ? error.message.replace(/^Firebase:\s*/i, '') : 'Authentication is temporarily unavailable.'
}
