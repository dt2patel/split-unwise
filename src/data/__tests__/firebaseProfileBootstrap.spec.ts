import { beforeEach, describe, expect, it, vi } from 'vitest'

const firebase = vi.hoisted(() => ({
  getDoc: vi.fn(),
  runTransaction: vi.fn(),
  user: { uid: 'member-a', displayName: 'Member A', email: 'member-a@example.com', photoURL: null },
}))

vi.mock('../firebaseBootstrap', () => ({ getSplitUnwiseFirebaseApp: async () => ({ name: 'test-app' }) }))
vi.mock('firebase/auth', () => ({ getAuth: () => ({ currentUser: firebase.user }) }))
vi.mock('firebase/firestore', () => ({
  arrayUnion: vi.fn(),
  doc: (_db: unknown, path: string) => ({ path }),
  getDoc: firebase.getDoc,
  getFirestore: () => ({ name: 'test-db' }),
  runTransaction: firebase.runTransaction,
  serverTimestamp: () => ({ kind: 'server-timestamp' }),
  Timestamp: class Timestamp { static fromDate(date: Date) { return date } },
  updateDoc: vi.fn(),
  writeBatch: vi.fn(),
}))

import { bootstrapFirebaseProfile } from '../firebaseSparkMutations'

const configuration = {
  apiKey: 'test-api-key', authDomain: 'test.invalid', projectId: 'test-project', appId: '1:1234:web:abcdef',
}

describe('Firebase profile bootstrap latency', () => {
  beforeEach(() => {
    firebase.getDoc.mockReset()
    firebase.runTransaction.mockReset()
  })

  it('returns after one document read when an existing account profile is ready', async () => {
    firebase.getDoc.mockResolvedValue({ exists: () => true })
    firebase.runTransaction.mockImplementation(async (_db: unknown, work: (transaction: unknown) => Promise<unknown>) => work({
      get: async () => ({ exists: () => true }),
      set: vi.fn(),
    }))

    await expect(bootstrapFirebaseProfile(configuration, firebase.user)).resolves.toBe('ready')

    expect(firebase.getDoc).toHaveBeenCalledOnce()
    expect(firebase.runTransaction).not.toHaveBeenCalled()
  })
})
