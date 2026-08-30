import { describe, expect, it } from 'vitest'
import { DocumentDecodeError, decodeActivity, decodeExpense, decodeRecurringExpense } from '../firebaseDecoders'
import { readFirebaseConfiguration } from '../firebase'
import { createRepository } from '../repositoryFactory'

describe('Firebase boundary decoders', () => {
  it('rejects an expense with an unsupported currency instead of defaulting it', () => {
    expect(() => decodeExpense('lake-house-weekend', 'bad-money', {
      description: 'Bad', date: '2026-08-30', payerId: 'maya-p', category: 'Other', createdAt: '2026-08-30T12:00:00.000Z',
      total: { currency: 'usd', minorAmount: 100 }, allocations: [],
    })).toThrow(DocumentDecodeError)
  })

  it('rejects missing recurrence and unknown activity types without inventing meaning', () => {
    expect(() => decodeRecurringExpense('lake-house-weekend', 'missing-rule', {
      description: 'Cabin', total: { currency: 'USD', minorAmount: 40000 }, payerId: 'alex-r', nextDate: '2026-09-28',
    })).toThrow('recurrence')
    expect(() => decodeActivity('lake-house-weekend', 'unknown-event', {
      actorId: 'maya-p', type: 'expense-purged', createdAt: '2026-08-30T12:00:00.000Z', summary: 'Unknown',
    })).toThrow('activity type')
  })

  it('accepts Firebase configuration only when every value is non-blank after trimming', () => {
    expect(readFirebaseConfiguration({ VITE_FIREBASE_API_KEY: 'key' })).toBeUndefined()
    expect(readFirebaseConfiguration({
      VITE_FIREBASE_API_KEY: ' ', VITE_FIREBASE_AUTH_DOMAIN: 'a', VITE_FIREBASE_PROJECT_ID: 'p', VITE_FIREBASE_STORAGE_BUCKET: 's', VITE_FIREBASE_MESSAGING_SENDER_ID: 'm', VITE_FIREBASE_APP_ID: 'i',
    })).toBeUndefined()
    expect(readFirebaseConfiguration({
      VITE_FIREBASE_API_KEY: ' key ', VITE_FIREBASE_AUTH_DOMAIN: ' auth ', VITE_FIREBASE_PROJECT_ID: ' project ', VITE_FIREBASE_STORAGE_BUCKET: ' bucket ', VITE_FIREBASE_MESSAGING_SENDER_ID: ' sender ', VITE_FIREBASE_APP_ID: ' app ',
    })).toEqual({ apiKey: 'key', authDomain: 'auth', projectId: 'project', storageBucket: 'bucket', messagingSenderId: 'sender', appId: 'app' })
  })

  it('selects demo for partial configuration and constructs Firebase lazily without a read', () => {
    expect(createRepository({ VITE_FIREBASE_API_KEY: 'key' }).mode).toBe('demo')
    expect(createRepository({
      VITE_FIREBASE_API_KEY: 'key', VITE_FIREBASE_AUTH_DOMAIN: 'auth', VITE_FIREBASE_PROJECT_ID: 'project', VITE_FIREBASE_STORAGE_BUCKET: 'bucket', VITE_FIREBASE_MESSAGING_SENDER_ID: 'sender', VITE_FIREBASE_APP_ID: 'app',
    }).mode).toBe('firebase')
  })
})
