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

  it('uses occurrence or future as the only persisted recurring-instance edit scopes', () => {
    const raw = {
      description: 'Cabin', date: '2026-08-30', category: 'Lodging', createdAt: '2026-08-30T12:00:00.000Z', updatedAt: '2026-08-30T12:00:00.000Z', revision: 3,
      total: { currency: 'USD', minorAmount: 1000 },
      payments: [{ participantId: 'maya-p', money: { currency: 'USD', minorAmount: 1000 } }],
      allocations: [{ participantId: 'maya-p', money: { currency: 'USD', minorAmount: 1000 } }],
      splitMethod: { type: 'equal', participantIds: ['maya-p'] }, attachmentRefs: [], recurringTemplateId: 'cabin-monthly',
    }

    expect(decodeExpense('lake-house-weekend', 'cabin', { ...raw, occurrenceEditScope: 'occurrence' })).toMatchObject({ occurrenceEditScope: 'occurrence', recurringTemplateId: 'cabin-monthly' })
    expect(() => decodeExpense('lake-house-weekend', 'cabin', { ...raw, occurrenceEditScope: 'single' })).toThrow('must be occurrence or future')
  })

  it('accepts valid Firebase core configuration and rejects partial intent', () => {
    expect(() => readFirebaseConfiguration({ VITE_FIREBASE_API_KEY: 'key' })).toThrow('incomplete')
    expect(readFirebaseConfiguration({
      VITE_FIREBASE_API_KEY: ' AIzaSyExampleKey ', VITE_FIREBASE_AUTH_DOMAIN: ' split-unwise.firebaseapp.com ', VITE_FIREBASE_PROJECT_ID: ' split-unwise ', VITE_FIREBASE_APP_ID: ' 1:123456:web:abcdef ',
    })).toEqual({ apiKey: 'AIzaSyExampleKey', authDomain: 'split-unwise.firebaseapp.com', projectId: 'split-unwise', appId: '1:123456:web:abcdef' })
  })

  it('never silently selects demo for partial Firebase configuration', () => {
    expect(() => createRepository({ VITE_FIREBASE_API_KEY: 'key' })).toThrow('incomplete')
    expect(createRepository({
      VITE_FIREBASE_API_KEY: 'AIzaSyExampleKey', VITE_FIREBASE_AUTH_DOMAIN: 'split-unwise.firebaseapp.com', VITE_FIREBASE_PROJECT_ID: 'split-unwise', VITE_FIREBASE_APP_ID: '1:123456:web:abcdef',
    }).mode).toBe('firebase')
  })
})
