import { afterEach, describe, expect, it, vi } from 'vitest'
import { assertMatchingFirebaseConfiguration, getSplitUnwiseFirebaseFirestore, resetFirebaseBootstrapForTesting } from '../firebaseBootstrap'

const firebaseMocks = vi.hoisted(() => {
  const app = { name: 'split-unwise', options: {} }
  const database = { type: 'firestore' }
  const tabManager = { type: 'multi-tab' }
  const localCache = { type: 'persistent-cache' }
  return {
    app,
    database,
    tabManager,
    localCache,
    initializeApp: vi.fn(() => app),
    initializeFirestore: vi.fn(() => database),
    persistentMultipleTabManager: vi.fn(() => tabManager),
    persistentLocalCache: vi.fn(() => localCache),
  }
})

vi.mock('firebase/app', () => ({
  getApps: () => [],
  initializeApp: firebaseMocks.initializeApp,
}))

vi.mock('firebase/firestore', () => ({
  initializeFirestore: firebaseMocks.initializeFirestore,
  persistentLocalCache: firebaseMocks.persistentLocalCache,
  persistentMultipleTabManager: firebaseMocks.persistentMultipleTabManager,
}))

const configuration = {
  apiKey: 'AIzaSyExampleKey', authDomain: 'split-unwise.firebaseapp.com', projectId: 'split-unwise', appId: '1:123456:web:abcdef', storageBucket: 'split-unwise.firebasestorage.app', messagingSenderId: '123456',
} as const

describe('Firebase bootstrap', () => {
  afterEach(() => {
    resetFirebaseBootstrapForTesting()
    vi.clearAllMocks()
  })

  it('accepts exactly matching full options and rejects optional-service drift', () => {
    expect(() => assertMatchingFirebaseConfiguration(configuration, { ...configuration })).not.toThrow()
    expect(() => assertMatchingFirebaseConfiguration(configuration, { ...configuration, storageBucket: 'other.firebasestorage.app' })).toThrow('storageBucket')
    expect(() => assertMatchingFirebaseConfiguration(configuration, { ...configuration, messagingSenderId: undefined })).toThrow('messagingSenderId')
  })

  it('initializes Firestore once with durable multi-tab persistence', async () => {
    const first = await getSplitUnwiseFirebaseFirestore(configuration)
    const second = await getSplitUnwiseFirebaseFirestore(configuration)

    expect(first).toBe(firebaseMocks.database)
    expect(second).toBe(first)
    expect(firebaseMocks.persistentMultipleTabManager).toHaveBeenCalledOnce()
    expect(firebaseMocks.persistentLocalCache).toHaveBeenCalledWith({ tabManager: firebaseMocks.tabManager })
    expect(firebaseMocks.initializeFirestore).toHaveBeenCalledWith(firebaseMocks.app, { localCache: firebaseMocks.localCache })
    expect(firebaseMocks.initializeFirestore).toHaveBeenCalledOnce()
  })
})
