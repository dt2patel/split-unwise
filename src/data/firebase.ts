export interface FirebaseConfiguration {
  readonly apiKey: string
  readonly authDomain: string
  readonly projectId: string
  readonly appId: string
  readonly storageBucket?: string
  readonly messagingSenderId?: string
}

export interface RuntimeCapabilities {
  readonly auth: 'available' | 'demo'
  readonly firestore: 'available' | 'demo'
  readonly storage: 'available' | 'unavailable' | 'demo'
  readonly functions: 'available' | 'unavailable' | 'demo'
  readonly appCheck: 'available' | 'unavailable' | 'demo'
  readonly push: 'available' | 'unavailable' | 'demo'
  readonly google: 'available' | 'unavailable' | 'demo'
  readonly apple: 'unavailable'
}

export type RuntimeConfiguration =
  | { readonly kind: 'demo'; readonly label: 'Demo mode'; readonly capabilities: RuntimeCapabilities }
  | { readonly kind: 'firebase'; readonly firebase: FirebaseConfiguration; readonly functionsRegion?: string; readonly appCheckSiteKey?: string; readonly vapidKey?: string; readonly googleEnabled: boolean; readonly capabilities: RuntimeCapabilities }
  | { readonly kind: 'error'; readonly message: string; readonly fields: readonly string[] }

export type PublicEnvironment = Partial<Record<
  | 'VITE_FIREBASE_API_KEY'
  | 'VITE_FIREBASE_AUTH_DOMAIN'
  | 'VITE_FIREBASE_PROJECT_ID'
  | 'VITE_FIREBASE_APP_ID'
  | 'VITE_FIREBASE_STORAGE_BUCKET'
  | 'VITE_FIREBASE_MESSAGING_SENDER_ID'
  | 'VITE_FIREBASE_FUNCTIONS_REGION'
  | 'VITE_FIREBASE_APP_CHECK_SITE_KEY'
  | 'VITE_FIREBASE_VAPID_KEY'
  | 'VITE_FIREBASE_GOOGLE_ENABLED',
  string
>>

const CORE_FIELDS = ['VITE_FIREBASE_API_KEY', 'VITE_FIREBASE_AUTH_DOMAIN', 'VITE_FIREBASE_PROJECT_ID', 'VITE_FIREBASE_APP_ID'] as const
const ALL_FIELDS = [...CORE_FIELDS, 'VITE_FIREBASE_STORAGE_BUCKET', 'VITE_FIREBASE_MESSAGING_SENDER_ID', 'VITE_FIREBASE_FUNCTIONS_REGION', 'VITE_FIREBASE_APP_CHECK_SITE_KEY', 'VITE_FIREBASE_VAPID_KEY', 'VITE_FIREBASE_GOOGLE_ENABLED'] as const

/** Selects one explicit runtime. Broken Firebase intent never falls back to demo data. */
export function readRuntimeConfiguration(environment?: PublicEnvironment): RuntimeConfiguration {
  const source = environment ?? import.meta.env as PublicEnvironment
  const present = ALL_FIELDS.filter((field) => source[field] !== undefined)
  if (present.length === 0) return demoConfiguration()

  const missing = CORE_FIELDS.filter((field) => !nonBlank(source[field]))
  const blankCore = CORE_FIELDS.filter((field) => source[field] !== undefined && !nonBlank(source[field]))
  if (missing.length || blankCore.length) {
    const fields = [...new Set([...missing, ...blankCore])].sort()
    return { kind: 'error', fields, message: `Firebase configuration is incomplete: ${fields.join(', ')}` }
  }

  const apiKey = nonBlank(source.VITE_FIREBASE_API_KEY)!
  const authDomain = nonBlank(source.VITE_FIREBASE_AUTH_DOMAIN)!
  const projectId = nonBlank(source.VITE_FIREBASE_PROJECT_ID)!
  const appId = nonBlank(source.VITE_FIREBASE_APP_ID)!
  const malformed: string[] = []
  if (!/^[A-Za-z0-9_-]{8,}$/.test(apiKey)) malformed.push('VITE_FIREBASE_API_KEY')
  if (!/^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/.test(authDomain)) malformed.push('VITE_FIREBASE_AUTH_DOMAIN')
  if (!/^[a-z][a-z0-9-]{4,29}$/.test(projectId)) malformed.push('VITE_FIREBASE_PROJECT_ID')
  if (!/^1:\d{4,}:web:[A-Fa-f0-9]{6,}$/.test(appId)) malformed.push('VITE_FIREBASE_APP_ID')
  if (malformed.length) return { kind: 'error', fields: malformed, message: `Firebase configuration is malformed: ${malformed.join(', ')}` }

  const storageBucket = nonBlank(source.VITE_FIREBASE_STORAGE_BUCKET)
  const messagingSenderId = nonBlank(source.VITE_FIREBASE_MESSAGING_SENDER_ID)
  const functionsRegion = nonBlank(source.VITE_FIREBASE_FUNCTIONS_REGION)
  const appCheckSiteKey = nonBlank(source.VITE_FIREBASE_APP_CHECK_SITE_KEY)
  const vapidKey = nonBlank(source.VITE_FIREBASE_VAPID_KEY)
  const googleSetting = nonBlank(source.VITE_FIREBASE_GOOGLE_ENABLED)?.toLowerCase()
  if (googleSetting !== undefined && googleSetting !== 'true' && googleSetting !== 'false') return { kind: 'error', fields: ['VITE_FIREBASE_GOOGLE_ENABLED'], message: 'Firebase configuration is malformed: VITE_FIREBASE_GOOGLE_ENABLED' }
  const googleEnabled = googleSetting !== 'false'
  const firebase = { apiKey, authDomain, projectId, appId, ...(storageBucket ? { storageBucket } : {}), ...(messagingSenderId ? { messagingSenderId } : {}) }
  return {
    kind: 'firebase', firebase, functionsRegion, appCheckSiteKey, vapidKey, googleEnabled,
    capabilities: {
      auth: 'available', firestore: 'available',
      storage: storageBucket ? 'available' : 'unavailable',
      functions: functionsRegion ? 'available' : 'unavailable',
      appCheck: appCheckSiteKey ? 'available' : 'unavailable',
      push: messagingSenderId && vapidKey ? 'available' : 'unavailable',
      google: googleEnabled ? 'available' : 'unavailable',
      apple: 'unavailable',
    },
  }
}

/** Compatibility helper for repository adapters. Throws on broken Firebase intent. */
export function readFirebaseConfiguration(environment?: PublicEnvironment): FirebaseConfiguration | undefined {
  const runtime = readRuntimeConfiguration(environment)
  if (runtime.kind === 'error') throw new FirebaseConfigurationError(runtime.message, runtime.fields)
  return runtime.kind === 'firebase' ? runtime.firebase : undefined
}

export class FirebaseConfigurationError extends Error {
  constructor(message: string, readonly fields: readonly string[]) {
    super(message)
    this.name = 'FirebaseConfigurationError'
  }
}

function demoConfiguration(): Extract<RuntimeConfiguration, { kind: 'demo' }> {
  return {
    kind: 'demo', label: 'Demo mode',
    capabilities: { auth: 'demo', firestore: 'demo', storage: 'demo', functions: 'demo', appCheck: 'demo', push: 'demo', google: 'demo', apple: 'unavailable' },
  }
}

function nonBlank(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed || undefined
}
