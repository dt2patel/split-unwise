import { describe, expect, it } from 'vitest'
import { DocumentDecodeError, decodeActivity, decodeExpense, decodeGroup, decodeGroupProjection, decodeRecurringExpense } from '../firebaseDecoders'
import { readFirebaseConfiguration } from '../firebase'
import { createRepository } from '../repositoryFactory'

describe('Firebase boundary decoders', () => {
  it('decodes explicit friendship contexts and treats legacy records as groups', () => {
    const shared = { name: 'Jordan', currency: 'USD', memberIds: ['maya-p', 'jordan-p'] }
    expect(decodeGroup('friend-jordan', { ...shared, kind: 'friendship' })).toMatchObject({ kind: 'friendship' })
    expect(decodeGroup('legacy-group', shared)).toMatchObject({ kind: 'group' })
    expect(() => decodeGroup('unknown-context', { ...shared, kind: 'household' })).toThrow('kind')
  })

  it('decodes a user-specific context label while accepting legacy projections', () => {
    expect(decodeGroupProjection('friend-jordan', { groupId: 'friend-jordan', contextLabel: 'Jordan Lee' })).toEqual({
      groupId: 'friend-jordan', contextLabel: 'Jordan Lee',
    })
    expect(decodeGroupProjection('legacy-group', { groupId: 'legacy-group' })).toEqual({ groupId: 'legacy-group' })
    expect(() => decodeGroupProjection('friend-jordan', { groupId: 'friend-jordan', contextLabel: '' })).toThrow('contextLabel')
  })

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

  it('normalizes native Firestore timestamps at the repository boundary', () => {
    const timestamp = { toDate: () => new Date('2026-08-30T12:00:00.000Z') }
    const decoded = decodeExpense('lake-house-weekend', 'spark-expense', {
      description: 'Dinner', date: '2026-08-30', category: 'Food', createdAt: timestamp, updatedAt: timestamp, revision: 1,
      total: { currency: 'USD', minorAmount: 1000 },
      payments: [{ participantId: 'maya-p', money: { currency: 'USD', minorAmount: 1000 } }],
      allocations: [{ participantId: 'maya-p', money: { currency: 'USD', minorAmount: 1000 } }],
      splitMethod: { type: 'exact', allocations: [{ participantId: 'maya-p', money: { currency: 'USD', minorAmount: 1000 } }] }, attachmentRefs: [],
    })

    expect(decoded).toMatchObject({ createdAt: '2026-08-30T12:00:00.000Z', updatedAt: '2026-08-30T12:00:00.000Z' })
    expect(() => decodeExpense('lake-house-weekend', 'bad-timestamp', { ...decoded, createdAt: { toDate: () => new Date('invalid') } })).toThrow('ISO timestamp')
  })

  it('rejects missing recurrence and unknown activity types without inventing meaning', () => {
    expect(() => decodeRecurringExpense('lake-house-weekend', 'missing-rule', {
      status: 'active', description: 'Cabin', total: { currency: 'USD', minorAmount: 40000 }, payments: [{ participantId: 'alex-r', money: { currency: 'USD', minorAmount: 40000 } }],
      allocations: [{ participantId: 'alex-r', money: { currency: 'USD', minorAmount: 40000 } }], category: 'Lodging', splitMethod: { type: 'equal', participantIds: ['alex-r'] },
      anchorDate: '2026-08-28', nextDate: '2026-09-28', revision: 1, createdBy: { id: 'alex-r', displayName: 'Alex' },
    })).toThrow('recurrence')
    expect(() => decodeActivity('lake-house-weekend', 'unknown-event', {
      actorId: 'maya-p', type: 'expense-purged', createdAt: '2026-08-30T12:00:00.000Z', summary: 'Unknown',
    })).toThrow('activity type')
  })

  it('decodes an active recurring template with the immutable expense snapshot and revision metadata', () => {
    const decoded = decodeRecurringExpense('lake-house-weekend', 'monthly-rent', {
      status: 'active', description: 'Rent', total: { currency: 'USD', minorAmount: 120000 },
      payments: [{ participantId: 'maya-p', money: { currency: 'USD', minorAmount: 120000 } }],
      allocations: [
        { participantId: 'maya-p', money: { currency: 'USD', minorAmount: 60000 } },
        { participantId: 'alex-r', money: { currency: 'USD', minorAmount: 60000 } },
      ],
      category: 'Home', splitMethod: { type: 'equal', participantIds: ['maya-p', 'alex-r'] },
      recurrence: { frequency: 'monthly', anchor: { month: 8, day: 1 }, timeZone: 'America/Chicago' },
      anchorDate: '2026-08-01', nextDate: '2026-09-01', revision: 3,
      createdBy: { id: 'maya-p', displayName: 'Maya Patel' },
    })

    expect(decoded).toMatchObject({
      id: 'monthly-rent', groupId: 'lake-house-weekend', status: 'active', category: 'Home', anchorDate: '2026-08-01', revision: 3,
      allocations: [
        { participantId: 'maya-p', money: { currency: 'USD', minorAmount: 60000 } },
        { participantId: 'alex-r', money: { currency: 'USD', minorAmount: 60000 } },
      ],
      splitMethod: { type: 'equal', participantIds: ['maya-p', 'alex-r'] }, createdBy: { id: 'maya-p', displayName: 'Maya Patel' },
    })
  })

  it('decodes a cancelled template while preserving its latest materialized occurrence metadata', () => {
    const decoded = decodeRecurringExpense('lake-house-weekend', 'monthly-rent', {
      status: 'cancelled', description: 'Rent', total: { currency: 'USD', minorAmount: 120000 },
      payments: [{ participantId: 'maya-p', money: { currency: 'USD', minorAmount: 120000 } }],
      allocations: [{ participantId: 'maya-p', money: { currency: 'USD', minorAmount: 120000 } }], category: 'Home',
      splitMethod: { type: 'equal', participantIds: ['maya-p'] },
      recurrence: { frequency: 'monthly', anchor: { month: 8, day: 1 }, timeZone: 'America/Chicago' },
      anchorDate: '2026-08-01', nextDate: '2026-09-01', revision: 4,
      createdBy: { id: 'maya-p', displayName: 'Maya Patel' },
      lastOccurrenceId: 'occ_9c14c4db1f653d44668e2dc24c1a7902', lastOccurrenceDate: '2026-08-01',
    })

    expect(decoded).toMatchObject({
      status: 'cancelled', revision: 4,
      lastOccurrenceId: 'occ_9c14c4db1f653d44668e2dc24c1a7902', lastOccurrenceDate: '2026-08-01',
    })
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
