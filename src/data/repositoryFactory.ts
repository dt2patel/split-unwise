import { createBrowserDemoRepositoryStateStorage, createDemoRepository } from './demoRepository'
import { readFirebaseConfiguration, resolveRuntimeConfiguration, type PublicEnvironment, type RuntimeConfiguration } from './firebase'
import { createFirebaseRepository } from './firebaseRepository'
import { connectFirebasePrincipalSource } from './firebaseSession'
import { appPrincipalKey, type AppPrincipal, type AppPrincipalSource } from './principal'
import type { AppRepository } from './repositories'
import { createConfigurationErrorAuthService, createDemoAuthService, type AuthService } from '../features/auth/authService'
import { createFirebaseAuthService } from '../features/auth/firebaseAuthService'
import { getSplitUnwiseFirebaseFirestore, initializeSplitUnwiseAppCheck } from './firebaseBootstrap'

export interface AppRepositorySessionRuntime {
  readonly configuration: RuntimeConfiguration
  readonly auth: AuthService
  readonly principals: AppPrincipalSource
  createRepository(principal: AppPrincipal): AppRepository
}

/** Composition root: Firebase is selected only for a complete public configuration. */
export function createRepository(environment?: PublicEnvironment): AppRepository {
  const configuration = readFirebaseConfiguration(environment)
  return configuration ? createFirebaseRepository(configuration) : createDemoRepository({ stateStorage: createBrowserDemoRepositoryStateStorage() })
}

/** Principal-first composition used by the mounted app and auth lifecycle. */
export async function createRepositorySessionRuntime(environment?: PublicEnvironment): Promise<AppRepositorySessionRuntime> {
  const runtime = await resolveRuntimeConfiguration(environment)
  if (runtime.kind === 'error') {
    const auth = createConfigurationErrorAuthService(runtime.message, {
      auth: 'available', firestore: 'available', storage: 'unavailable', functions: 'unavailable', appCheck: 'unavailable', push: 'unavailable', google: 'unavailable', apple: 'unavailable',
    })
    return {
      configuration: runtime, auth,
      principals: { async listen(listener) { await listener(undefined); return () => undefined } },
      createRepository() { throw new Error(runtime.message) },
    }
  }
  if (runtime.kind === 'firebase') {
    await initializeSplitUnwiseAppCheck(runtime.firebase, runtime.appCheckSiteKey)
    await getSplitUnwiseFirebaseFirestore(runtime.firebase)
    const [principals, auth] = await Promise.all([
      connectFirebasePrincipalSource(runtime.firebase, runtime.functionsRegion),
      createFirebaseAuthService(runtime.firebase, runtime.capabilities),
    ])
    return {
      configuration: runtime, auth,
      principals,
      createRepository(principal) {
        assertRuntimePrincipal(principal, 'firebase', runtime.firebase.projectId)
        return createFirebaseRepository(runtime.firebase, principal.uid, runtime.functionsRegion)
      },
    }
  }

  const stateStorage = createBrowserDemoRepositoryStateStorage()
  const identityRepository = createDemoRepository({ stateStorage })
  const projectId = identityRepository.projectId
  const currentUser = await identityRepository.app.getCurrentUser()
  const auth = createDemoAuthService({
    uid: currentUser.id, displayName: currentUser.displayName, emailVerified: false,
    ...(currentUser.avatarUrl ? { photoURL: currentUser.avatarUrl } : {}), providerIds: ['demo'],
  }, runtime.capabilities)
  const principals: AppPrincipalSource = {
    async listen(listener) {
      await listener({ mode: 'demo', projectId, uid: currentUser.id })
      return () => undefined
    },
  }
  return {
    configuration: runtime, auth,
    principals,
    createRepository(principal) {
      assertRuntimePrincipal(principal, 'demo', projectId)
      return createDemoRepository({ currentUserId: principal.uid, stateStorage })
    },
  }
}

function assertRuntimePrincipal(principal: AppPrincipal, mode: AppPrincipal['mode'], projectId: string): void {
  appPrincipalKey(principal)
  if (principal.mode !== mode || principal.projectId !== projectId) throw new Error('Principal does not belong to this repository runtime')
}
