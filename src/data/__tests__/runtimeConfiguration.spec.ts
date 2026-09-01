import { describe, expect, it } from 'vitest'
import { firebaseHostingInitUrl, FirebaseConfigurationError, readFirebaseConfiguration, readFirebaseHostingConfiguration, readRuntimeConfiguration, type PublicEnvironment } from '../firebase'

const core: PublicEnvironment = {
  VITE_FIREBASE_API_KEY: 'AIzaSyExampleKey',
  VITE_FIREBASE_AUTH_DOMAIN: 'split-unwise.firebaseapp.com',
  VITE_FIREBASE_PROJECT_ID: 'split-unwise',
  VITE_FIREBASE_APP_ID: '1:123456789:web:abcdef123456',
}

describe('runtime configuration', () => {
  it('labels a zero-variable runtime as demo', () => {
    expect(readRuntimeConfiguration({})).toMatchObject({ kind: 'demo', label: 'Demo mode', capabilities: { auth: 'demo', apple: 'unavailable' } })
  })

  it.each(Object.keys(core))('fails closed when %s is missing', (field) => {
    const partial = { ...core }
    delete partial[field as keyof PublicEnvironment]
    expect(readRuntimeConfiguration(partial)).toMatchObject({ kind: 'error' })
  })

  it('treats optional-only, blank, and malformed variables as fatal Firebase intent', () => {
    expect(readRuntimeConfiguration({ VITE_FIREBASE_STORAGE_BUCKET: 'bucket' })).toMatchObject({ kind: 'error' })
    expect(readRuntimeConfiguration({ ...core, VITE_FIREBASE_APP_ID: ' ' })).toMatchObject({ kind: 'error' })
    expect(readRuntimeConfiguration({ ...core, VITE_FIREBASE_AUTH_DOMAIN: 'https://bad.example' })).toMatchObject({ kind: 'error', fields: ['VITE_FIREBASE_AUTH_DOMAIN'] })
    expect(() => readFirebaseConfiguration({ VITE_FIREBASE_API_KEY: 'only-one' })).toThrow(FirebaseConfigurationError)
  })

  it('separates complete core configuration from optional capabilities', () => {
    expect(readRuntimeConfiguration(core)).toMatchObject({
      kind: 'firebase', firebase: { projectId: 'split-unwise' },
      capabilities: { auth: 'available', firestore: 'available', storage: 'unavailable', functions: 'unavailable', push: 'unavailable', google: 'available' },
    })
    expect(readRuntimeConfiguration({
      ...core,
      VITE_FIREBASE_STORAGE_BUCKET: 'split-unwise.firebasestorage.app',
      VITE_FIREBASE_MESSAGING_SENDER_ID: '123456789',
      VITE_FIREBASE_FUNCTIONS_REGION: 'us-central1',
      VITE_FIREBASE_APP_CHECK_SITE_KEY: 'site-key',
      VITE_FIREBASE_VAPID_KEY: 'vapid-key',
    })).toMatchObject({ kind: 'firebase', capabilities: { storage: 'available', functions: 'available', appCheck: 'available', push: 'available' } })
    expect(readRuntimeConfiguration({ ...core, VITE_FIREBASE_STORAGE_BUCKET: ' ' })).toMatchObject({ kind: 'firebase', capabilities: { storage: 'unavailable' } })
    expect(readRuntimeConfiguration({ ...core, VITE_FIREBASE_GOOGLE_ENABLED: 'maybe' })).toMatchObject({ kind: 'error', fields: ['VITE_FIREBASE_GOOGLE_ENABLED'] })
  })

  it('maps Firebase Hosting auto-init into an Auth and Firestore runtime without claiming undeployed paid services', () => {
    expect(readFirebaseHostingConfiguration({
      apiKey: 'AIzaSyExampleKey', authDomain: 'split-unwise-aditya.firebaseapp.com', projectId: 'split-unwise-aditya',
      appId: '1:906824460273:web:ac56072d30a1dd5e72c650', messagingSenderId: '906824460273', storageBucket: 'split-unwise-aditya.firebasestorage.app',
    })).toMatchObject({
      kind: 'firebase', firebase: { projectId: 'split-unwise-aditya' },
      capabilities: { auth: 'available', firestore: 'available', functions: 'unavailable', storage: 'unavailable', google: 'available' },
    })
  })

  it('keeps browser OAuth out of the native Auth bootstrap', () => {
    expect(readFirebaseHostingConfiguration({
      apiKey: 'AIzaSyExampleKey', authDomain: 'split-unwise-aditya.firebaseapp.com', projectId: 'split-unwise-aditya',
      appId: '1:906824460273:web:ac56072d30a1dd5e72c650', messagingSenderId: '906824460273',
    }, false)).toMatchObject({
      kind: 'firebase', googleEnabled: false,
      capabilities: { auth: 'available', firestore: 'available', google: 'unavailable' },
    })
  })

  it('discovers auto-init from same-origin Hosting and from the native Capacitor shell', () => {
    expect(firebaseHostingInitUrl({ hostname: 'split-unwise-aditya.web.app', protocol: 'https:' }, false)).toBe('/__/firebase/init.json')
    expect(firebaseHostingInitUrl({ hostname: 'localhost', protocol: 'capacitor:' }, true)).toBe('https://split-unwise-aditya.web.app/__/firebase/init.json')
    expect(firebaseHostingInitUrl({ hostname: 'localhost', protocol: 'http:' }, false)).toBeUndefined()
  })
})
