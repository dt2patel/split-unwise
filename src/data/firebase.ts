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

export interface RuntimeResolutionOptions {
  readonly nativeUiTestDemo?: boolean
}

let activeRuntimeConfiguration: RuntimeConfiguration | undefined

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

/** Resolves Firebase Hosting's same-origin auto-init payload without embedding public project configuration in source. */
export async function resolveRuntimeConfiguration(
  environment?: PublicEnvironment,
  options: RuntimeResolutionOptions = { nativeUiTestDemo: import.meta.env.VITE_NATIVE_UI_TEST_DEMO === 'true' },
): Promise<RuntimeConfiguration> {
  if (options.nativeUiTestDemo) {
    const demo = demoConfiguration()
    activeRuntimeConfiguration = demo
    return demo
  }
  const configured = readRuntimeConfiguration(environment)
  const nativePlatform = environment === undefined && configured.kind === 'demo' ? await runningNatively() : false
  const initUrl = environment === undefined && configured.kind === 'demo'
    ? firebaseHostingInitUrl(typeof location === 'undefined' ? undefined : location, nativePlatform)
    : undefined
  if (environment !== undefined || configured.kind !== 'demo' || !initUrl) {
    activeRuntimeConfiguration = configured
    return configured
  }
  try {
    const response = await fetch(initUrl, { cache: 'no-store', credentials: initUrl.startsWith('/') ? 'same-origin' : 'omit' })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const value: unknown = await response.json()
    if (!isRecord(value)) throw new Error('invalid JSON object')
    const discovered = readFirebaseHostingConfiguration(value, !nativePlatform)
    if (discovered.kind !== 'firebase') throw new Error(discovered.kind === 'error' ? discovered.message : 'Firebase Hosting returned an empty configuration')
    activeRuntimeConfiguration = discovered
    return discovered
  } catch (reason) {
    const detail = reason instanceof Error ? reason.message : 'unknown error'
    const failed: RuntimeConfiguration = { kind: 'error', fields: ['/__/firebase/init.json'], message: `Firebase Hosting configuration could not be loaded: ${detail}` }
    activeRuntimeConfiguration = failed
    return failed
  }
}

/** Maps Hosting's public auto-init document to the deliberately Spark-safe client capability set. */
export function readFirebaseHostingConfiguration(value: unknown, googleEnabled = true): RuntimeConfiguration {
  if (!isRecord(value)) return { kind: 'error', fields: ['/__/firebase/init.json'], message: 'Firebase Hosting configuration is not a JSON object' }
  try {
    return readRuntimeConfiguration({
      VITE_FIREBASE_API_KEY: stringField(value, 'apiKey'),
      VITE_FIREBASE_AUTH_DOMAIN: stringField(value, 'authDomain'),
      VITE_FIREBASE_PROJECT_ID: stringField(value, 'projectId'),
      VITE_FIREBASE_APP_ID: stringField(value, 'appId'),
      VITE_FIREBASE_MESSAGING_SENDER_ID: optionalStringField(value, 'messagingSenderId'),
      VITE_FIREBASE_GOOGLE_ENABLED: googleEnabled ? 'true' : 'false',
    })
  } catch (reason) {
    return { kind: 'error', fields: ['/__/firebase/init.json'], message: reason instanceof Error ? reason.message : 'Firebase Hosting configuration is invalid' }
  }
}

/** The runtime already selected by the mounted composition root. */
export function getActiveRuntimeConfiguration(): RuntimeConfiguration {
  return activeRuntimeConfiguration ?? readRuntimeConfiguration()
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

export function firebaseHostingInitUrl(locationValue: Pick<Location, 'hostname' | 'protocol'> | undefined, nativePlatform: boolean): string | undefined {
  if (locationValue && /(?:^|\.)firebaseapp\.com$|(?:^|\.)web\.app$/.test(locationValue.hostname)) return '/__/firebase/init.json'
  if (nativePlatform) return 'https://split-unwise-aditya.web.app/__/firebase/init.json'
  return undefined
}

async function runningNatively(): Promise<boolean> {
  try {
    const { Capacitor } = await import('@capacitor/core')
    return Capacitor.isNativePlatform()
  } catch { return false }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function stringField(value: Record<string, unknown>, field: string): string {
  const candidate = value[field]
  if (typeof candidate !== 'string') throw new Error(`Firebase Hosting configuration is missing ${field}`)
  return candidate
}

function optionalStringField(value: Record<string, unknown>, field: string): string | undefined {
  const candidate = value[field]
  return typeof candidate === 'string' ? candidate : undefined
}

export function resetActiveRuntimeConfigurationForTesting(): void {
  activeRuntimeConfiguration = undefined
}
