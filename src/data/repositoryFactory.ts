import { createBrowserDemoRepositoryStateStorage, createDemoRepository } from './demoRepository'
import { readFirebaseConfiguration, type PublicEnvironment } from './firebase'
import { createFirebaseRepository } from './firebaseRepository'
import { connectFirebasePrincipalSource } from './firebaseSession'
import { appPrincipalKey, type AppPrincipal, type AppPrincipalSource } from './principal'
import type { AppRepository } from './repositories'

export interface AppRepositorySessionRuntime {
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
  const configuration = readFirebaseConfiguration(environment)
  if (configuration) {
    const principals = await connectFirebasePrincipalSource(configuration)
    return {
      principals,
      createRepository(principal) {
        assertRuntimePrincipal(principal, 'firebase', configuration.projectId)
        return createFirebaseRepository(configuration, principal.uid)
      },
    }
  }

  const stateStorage = createBrowserDemoRepositoryStateStorage()
  const identityRepository = createDemoRepository({ stateStorage })
  const projectId = identityRepository.projectId
  const principals: AppPrincipalSource = {
    async listen(listener) {
      const currentUser = await identityRepository.app.getCurrentUser()
      await listener({ mode: 'demo', projectId, uid: currentUser.id })
      return () => undefined
    },
  }
  return {
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
