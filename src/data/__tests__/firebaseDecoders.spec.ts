import { describe, expect, it } from 'vitest'
import { DocumentDecodeError, decodeActivity, decodeExpense, decodeRecurringExpense } from '../firebaseDecoders'
import { readFirebaseConfiguration } from '../firebase'
import { createRepository } from '../repositoryFactory'

describe('Firebase boundary decoders', () => {
  it('rejects an expense with an unsupported currency instead of defaulting it', () => {
    expect(() => decodeExpense('lake-house-weekend', 'bad-money', {
      description: 'Bad', date: '2026-08-30', payments: [], category: 'Other', createdAt: '2026-08-30T12:00:00.000Z', updatedAt: '2026-08-30T12:00:00.000Z', revision: 1,
      total: { currency: 'usd', minorAmount: 100 }, allocations: [], splitMethod: { type: 'equal', participantIds: ['maya-p'] }, attachmentRefs: [],
    })).toThrow(DocumentDecodeError)
  })

  it('decodes canonical multi-payer expenses and rejects broken payment authority', () => {
    const raw = {
      description: 'Cabin', date: '2026-08-30', category: 'Lodging', createdAt: '2026-08-30T12:00:00.000Z', updatedAt: '2026-08-30T12:00:00.000Z', revision: 3,
      total: { currency: 'USD', minorAmount: 1000 },
      payments: [
        { participantId: 'maya-p', money: { currency: 'USD', minorAmount: 600 } },
        { participantId: 'alex-r', money: { currency: 'USD', minorAmount: 400 } },
      ],
      allocations: [
        { participantId: 'maya-p', money: { currency: 'USD', minorAmount: 500 } },
        { participantId: 'alex-r', money: { currency: 'USD', minorAmount: 500 } },
      ],
      splitMethod: { type: 'equal', participantIds: ['maya-p', 'alex-r'] }, attachmentRefs: ['local-receipt:receipt-1'],
    }
    expect(decodeExpense('lake-house-weekend', 'cabin', raw)).toMatchObject({ revision: 3, payments: raw.payments, attachmentRefs: raw.attachmentRefs })
    expect(() => decodeExpense('lake-house-weekend', 'bad-payments', { ...raw, payments: raw.payments.slice(0, 1) })).toThrow('payment total must equal total')
    expect(() => decodeExpense('lake-house-weekend', 'duplicate-payer', { ...raw, payments: [raw.payments[0], raw.payments[0], { participantId: 'alex-r', money: { currency: 'USD', minorAmount: -200 } }] })).toThrow(DocumentDecodeError)
  })

  it('rejects missing recurrence and unknown activity types without inventing meaning', () => {
    expect(() => decodeRecurringExpense('lake-house-weekend', 'missing-rule', {
      description: 'Cabin', total: { currency: 'USD', minorAmount: 40000 }, payments: [{ participantId: 'alex-r', money: { currency: 'USD', minorAmount: 40000 } }], nextDate: '2026-09-28',
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
