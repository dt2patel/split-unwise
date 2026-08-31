import type { FirebaseConfiguration } from './firebase'
import type { AppPrincipal } from './principal'

export interface HydratableFirebaseAuth {
  authStateReady(): Promise<void>
  readonly currentUser: { readonly uid: string } | null
}

export interface FirebasePrincipalSource {
  /** Resolves after Firebase hydration and delivery of the first auth state. */
  listen(listener: (principal: AppPrincipal | undefined) => void | Promise<void>): Promise<() => void>
}

export interface FirebasePrincipalSourceOptions {
  readonly auth: HydratableFirebaseAuth
  readonly projectId: string
  readonly subscribe: (listener: (user: { readonly uid: string } | null) => void) => () => void
}

/** The only boundary that decides whether Firebase has an authenticated user. */
export async function resolveFirebaseSession(auth: HydratableFirebaseAuth): Promise<{ readonly userId: string }> {
  await auth.authStateReady()
  if (!auth.currentUser) throw new Error('A signed-in Firebase user is required')
  return { userId: auth.currentUser.uid }
}

/** Testable adapter around Firebase's modular auth observer. */
export function createFirebasePrincipalSource(options: FirebasePrincipalSourceOptions): FirebasePrincipalSource {
  return {
    async listen(listener) {
      await options.auth.authStateReady()
      let resolveFirst!: (delivery: Promise<void>) => void
      const first = new Promise<Promise<void>>((resolve) => { resolveFirst = resolve })
      let delivered = false
      const unsubscribe = options.subscribe((user) => {
        const principal = user ? firebasePrincipal(options.projectId, user.uid) : undefined
        const delivery = Promise.resolve(listener(principal)).then(() => undefined)
        if (!delivered) {
          delivered = true
          resolveFirst(delivery)
        } else {
          void delivery.catch(() => undefined)
        }
      })
      await first
      return unsubscribe
    },
  }
}

/** Real Firebase connection used by the app composition root. */
export async function connectFirebasePrincipalSource(configuration: FirebaseConfiguration): Promise<FirebasePrincipalSource> {
  const [appModule, authModule] = await Promise.all([import('firebase/app'), import('firebase/auth')])
  const app = appModule.getApps().find((candidate) => candidate.options.projectId === configuration.projectId)
    ?? appModule.initializeApp(configuration, `split-unwise-${configuration.projectId}`)
  const auth = authModule.getAuth(app)
  return createFirebasePrincipalSource({
    auth,
    projectId: configuration.projectId,
    subscribe: (listener) => authModule.onAuthStateChanged(auth, listener),
  })
}

function firebasePrincipal(projectId: string, uid: string): AppPrincipal {
  return { mode: 'firebase', projectId, uid }
}
