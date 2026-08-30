import { createDemoRepository } from './demoRepository'
import { readFirebaseConfiguration, type PublicEnvironment } from './firebase'
import { createFirebaseRepository } from './firebaseRepository'
import type { AppRepository } from './repositories'

/** Composition root: Firebase is selected only for a complete public configuration. */
export function createRepository(environment?: PublicEnvironment): AppRepository {
  const configuration = readFirebaseConfiguration(environment)
  return configuration ? createFirebaseRepository(configuration) : createDemoRepository()
}
