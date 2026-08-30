export interface FirebaseConfiguration {
  readonly apiKey: string
  readonly authDomain: string
  readonly projectId: string
  readonly storageBucket: string
  readonly messagingSenderId: string
  readonly appId: string
}

export type PublicEnvironment = Partial<Record<
  'VITE_FIREBASE_API_KEY' | 'VITE_FIREBASE_AUTH_DOMAIN' | 'VITE_FIREBASE_PROJECT_ID' | 'VITE_FIREBASE_STORAGE_BUCKET' | 'VITE_FIREBASE_MESSAGING_SENDER_ID' | 'VITE_FIREBASE_APP_ID',
  string
>>

/** Returns configuration only when all public Firebase settings are present. */
export function readFirebaseConfiguration(environment?: PublicEnvironment): FirebaseConfiguration | undefined {
  const source = environment ?? import.meta.env as PublicEnvironment
  const apiKey = nonBlank(source.VITE_FIREBASE_API_KEY)
  const authDomain = nonBlank(source.VITE_FIREBASE_AUTH_DOMAIN)
  const projectId = nonBlank(source.VITE_FIREBASE_PROJECT_ID)
  const storageBucket = nonBlank(source.VITE_FIREBASE_STORAGE_BUCKET)
  const messagingSenderId = nonBlank(source.VITE_FIREBASE_MESSAGING_SENDER_ID)
  const appId = nonBlank(source.VITE_FIREBASE_APP_ID)
  return apiKey && authDomain && projectId && storageBucket && messagingSenderId && appId
    ? { apiKey, authDomain, projectId, storageBucket, messagingSenderId, appId }
    : undefined
}

function nonBlank(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed || undefined
}
