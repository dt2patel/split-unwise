import { afterEach, describe, expect, it } from 'vitest'
import { assertMatchingFirebaseConfiguration, resetFirebaseBootstrapForTesting } from '../firebaseBootstrap'

const configuration = {
  apiKey: 'AIzaSyExampleKey', authDomain: 'split-unwise.firebaseapp.com', projectId: 'split-unwise', appId: '1:123456:web:abcdef', storageBucket: 'split-unwise.firebasestorage.app', messagingSenderId: '123456',
} as const

describe('Firebase bootstrap', () => {
  afterEach(resetFirebaseBootstrapForTesting)

  it('accepts exactly matching full options and rejects optional-service drift', () => {
    expect(() => assertMatchingFirebaseConfiguration(configuration, { ...configuration })).not.toThrow()
    expect(() => assertMatchingFirebaseConfiguration(configuration, { ...configuration, storageBucket: 'other.firebasestorage.app' })).toThrow('storageBucket')
    expect(() => assertMatchingFirebaseConfiguration(configuration, { ...configuration, messagingSenderId: undefined })).toThrow('messagingSenderId')
  })
})
