import type { FirebaseApp, FirebaseOptions } from 'firebase/app'
import type { Auth } from 'firebase/auth'
import type { FirebaseConfiguration } from './firebase'

export const SPLIT_UNWISE_FIREBASE_APP_NAME = 'split-unwise'

let activeConfiguration: FirebaseConfiguration | undefined
let appPromise: Promise<FirebaseApp> | undefined
let authPromise: Promise<Auth> | undefined
let appCheckSiteKey: string | undefined
let appCheckPromise: Promise<void> | undefined

/** The single named Firebase app used by Auth, Firestore, Functions, and Storage. */
export function getSplitUnwiseFirebaseApp(configuration: FirebaseConfiguration): Promise<FirebaseApp> {
  if (activeConfiguration) assertMatchingFirebaseConfiguration(activeConfiguration, configuration)
  activeConfiguration ??= Object.freeze({ ...configuration })
  return appPromise ??= import('firebase/app').then((firebase) => {
    const existing = firebase.getApps().find(({ name }) => name === SPLIT_UNWISE_FIREBASE_APP_NAME)
    if (existing) {
      assertMatchingFirebaseConfiguration(configurationFromOptions(existing.options), configuration)
      return existing
    }
    return firebase.initializeApp(configuration, SPLIT_UNWISE_FIREBASE_APP_NAME)
  })
}

/** Uses a resolver-free Auth instance in the native WebView so email/password startup never depends on a browser OAuth iframe. */
export function getSplitUnwiseFirebaseAuth(configuration: FirebaseConfiguration): Promise<Auth> {
  return authPromise ??= Promise.all([
    getSplitUnwiseFirebaseApp(configuration),
    import('firebase/auth'),
    import('@capacitor/core'),
  ]).then(([app, firebase, { Capacitor }]) => Capacitor.isNativePlatform()
    ? firebase.initializeAuth(app, { persistence: firebase.browserLocalPersistence })
    : firebase.getAuth(app))
}

/** App Check is initialized on the same named app before any protected callable is used. */
export function initializeSplitUnwiseAppCheck(configuration: FirebaseConfiguration, siteKey?: string): Promise<void> {
  if (!siteKey) return Promise.resolve()
  if (appCheckSiteKey && appCheckSiteKey !== siteKey) throw new Error('The Split Unwise Firebase app already uses a different App Check site key')
  appCheckSiteKey = siteKey
  return appCheckPromise ??= Promise.all([getSplitUnwiseFirebaseApp(configuration), import('firebase/app-check')]).then(([app, appCheck]) => {
    appCheck.initializeAppCheck(app, {
      provider: new appCheck.ReCaptchaEnterpriseProvider(siteKey),
      isTokenAutoRefreshEnabled: true,
    })
  })
}

/** Rejects accidental cross-project or optional-service drift, not just project ID drift. */
export function assertMatchingFirebaseConfiguration(existing: FirebaseConfiguration, requested: FirebaseConfiguration): void {
  const fields: readonly (keyof FirebaseConfiguration)[] = ['apiKey', 'authDomain', 'projectId', 'appId', 'storageBucket', 'messagingSenderId']
  const mismatch = fields.find((field) => normalized(existing[field]) !== normalized(requested[field]))
  if (mismatch) throw new Error(`The existing Split Unwise Firebase app has different ${mismatch} configuration`)
}

function configurationFromOptions(options: FirebaseOptions): FirebaseConfiguration {
  if (!options.apiKey || !options.authDomain || !options.projectId || !options.appId) throw new Error('The existing Split Unwise Firebase app is missing core options')
  return {
    apiKey: options.apiKey,
    authDomain: options.authDomain,
    projectId: options.projectId,
    appId: options.appId,
    ...(options.storageBucket ? { storageBucket: options.storageBucket } : {}),
    ...(options.messagingSenderId ? { messagingSenderId: options.messagingSenderId } : {}),
  }
}

function normalized(value: string | undefined): string { return value ?? '' }

/** Test-only reset for the module's promise memoization; it does not delete SDK apps. */
export function resetFirebaseBootstrapForTesting(): void {
  activeConfiguration = undefined
  appPromise = undefined
  authPromise = undefined
  appCheckSiteKey = undefined
  appCheckPromise = undefined
}
