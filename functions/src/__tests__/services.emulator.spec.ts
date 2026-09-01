import { deleteApp, getApps, initializeApp } from 'firebase-admin/app'
import { getFirestore, type Firestore } from 'firebase-admin/firestore'
import { getStorage } from 'firebase-admin/storage'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  acceptInvitationService,
  createInvitationService,
  createJobService,
  fanOutActivity,
  inspectInvitationService,
  materializeTemplate,
  revokeInvitationService,
  runJobWorker,
} from '../services.js'

const enabled = Boolean(process.env.FIRESTORE_EMULATOR_HOST && process.env.FIREBASE_STORAGE_EMULATOR_HOST)
const suite = enabled ? describe : describe.skip
const projectId = 'demo-split-unwise'
const appName = 'split-unwise-services-tests'
const secret = 'split-unwise-test-secret-that-is-at-least-32-bytes'

suite('Firebase services against the emulators', () => {
  const app = getApps().find(({ name }) => name === appName) ?? initializeApp({ projectId, storageBucket: `${projectId}.appspot.com` }, appName)
  const db = getFirestore(app)
  const storage = getStorage(app)

  beforeAll(() => { db.settings({ ignoreUndefinedProperties: false }) })
  beforeEach(async () => {
    const response = await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${projectId}/databases/(default)/documents`, { method: 'DELETE' })
    if (!response.ok) throw new Error(`Could not clear emulator: ${response.status}`)
    await seed(db)
  })
  afterAll(async () => deleteApp(app))

  it('keeps invitation secrets out of Firestore and enforces email, expiry, revocation, single-use, race, and replay', async () => {
    const now = new Date('2026-08-31T12:00:00.000Z')
    const targeted = await createInvitationService(db, 'owner', { schemaVersion: 1, operationId: 'invite-targeted', groupId: 'group-a', targetEmail: 'member@example.com', origin: 'https://split-unwise.web.app' }, secret, now)
    const targetedId = String(targeted.invitationId)
    const targetedToken = fragmentToken(String(targeted.link))
    const stored = (await db.doc(`invitations/${targetedId}`).get()).data()!
    expect(stored).not.toHaveProperty('token')
    expect(JSON.stringify(stored)).not.toContain(targetedToken)
    await expect(inspectInvitationService(db, 'member', { email: 'other@example.com', emailVerified: true }, { schemaVersion: 1, invitationId: targetedId, token: targetedToken }, now)).rejects.toMatchObject({ code: 'permission-denied' })
    await expect(inspectInvitationService(db, 'member', { email: 'member@example.com', emailVerified: false }, { schemaVersion: 1, invitationId: targetedId, token: targetedToken }, now)).rejects.toMatchObject({ code: 'permission-denied' })
    await expect(inspectInvitationService(db, 'member', { email: 'member@example.com', emailVerified: true }, { schemaVersion: 1, invitationId: targetedId, token: targetedToken }, new Date('2026-09-08T12:00:00.000Z'))).rejects.toMatchObject({ code: 'failed-precondition' })

    const race = await createInvitationService(db, 'owner', { schemaVersion: 1, operationId: 'invite-race', groupId: 'group-a', origin: 'https://split-unwise.web.app' }, secret, now)
    const access = { schemaVersion: 1, invitationId: String(race.invitationId), token: fragmentToken(String(race.link)) }
    const attempts = await Promise.allSettled([
      acceptInvitationService(db, 'guest', { email: 'guest@example.com', emailVerified: true }, access, now),
      acceptInvitationService(db, 'challenger', { email: 'challenger@example.com', emailVerified: true }, access, now),
    ])
    expect(attempts.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
    const winner = attempts[0].status === 'fulfilled' ? 'guest' : 'challenger'
    await expect(acceptInvitationService(db, winner, { email: `${winner}@example.com`, emailVerified: true }, access, now)).resolves.toMatchObject({ status: 'already-member' })

    const revoked = await createInvitationService(db, 'owner', { schemaVersion: 1, operationId: 'invite-revoked', groupId: 'group-a', origin: 'https://split-unwise.web.app' }, secret, now)
    await revokeInvitationService(db, 'owner', { schemaVersion: 1, operationId: 'revoke-invite', invitationId: revoked.invitationId }, now)
    await expect(inspectInvitationService(db, 'guest', { emailVerified: true }, { schemaVersion: 1, invitationId: revoked.invitationId, token: fragmentToken(String(revoked.link)) }, now)).rejects.toMatchObject({ code: 'failed-precondition' })
  }, 30_000)

  it('validates job authorization and type-specific inputs before creating a private idempotent job', async () => {
    await db.doc('groups/group-a/assets/receipt-a').set({ status: 'ready', groupId: 'group-a', ownerUid: 'owner' })
    const ocrRequest = { schemaVersion: 1, operationId: 'ocr-operation', groupId: 'group-a', assetId: 'receipt-a' }
    const first = await createJobService(db, 'owner', ocrRequest, 'receipt-ocr')
    await expect(createJobService(db, 'owner', ocrRequest, 'receipt-ocr')).resolves.toEqual(first)
    await expect(createJobService(db, 'owner', { ...ocrRequest, format: 'csv' }, 'receipt-ocr')).rejects.toMatchObject({ code: 'invalid-argument' })
    await expect(createJobService(db, 'owner', { schemaVersion: 1, operationId: 'export-missing-format', groupId: 'group-a' }, 'large-export')).rejects.toMatchObject({ code: 'invalid-argument' })
    await expect(createJobService(db, 'removed', { schemaVersion: 1, operationId: 'removed-export', groupId: 'group-a', format: 'csv' }, 'large-export')).rejects.toMatchObject({ code: 'permission-denied' })
    await expect(createJobService(db, 'owner', { schemaVersion: 1, operationId: 'wrong-asset', groupId: 'group-a', assetId: 'missing' }, 'receipt-ocr')).rejects.toMatchObject({ code: 'invalid-argument' })
  })

  it('materializes deterministic recurrence IDs once across repeated runs', async () => {
    await db.doc('groups/group-a/recurringTemplates/monthly-a').set({
      schemaVersion: 1, id: 'monthly-a', groupId: 'group-a', status: 'active', description: 'Rent',
      total: { currency: 'USD', minorAmount: 1000 }, payments: [{ participantId: 'owner', money: { currency: 'USD', minorAmount: 1000 } }],
      allocations: [{ participantId: 'owner', money: { currency: 'USD', minorAmount: 500 } }, { participantId: 'member', money: { currency: 'USD', minorAmount: 500 } }],
      category: 'Home', splitMethod: { type: 'equal', participantIds: ['owner', 'member'] }, attachmentRefs: [],
      recurrence: { frequency: 'monthly', anchor: { month: 1, day: 31 }, timeZone: 'America/Chicago' }, anchorDate: '2024-01-01', nextDate: '2024-01-31', revision: 1,
      createdAt: '2024-01-01T00:00:00.000Z', createdBy: { id: 'owner', displayName: 'Owner' },
    })
    const first = await materializeTemplate(db, 'group-a', 'monthly-a', '2024-03-31')
    const second = await materializeTemplate(db, 'group-a', 'monthly-a', '2024-03-31')
    expect(first.materialized).toHaveLength(3)
    expect(new Set(first.materialized as string[]).size).toBe(3)
    expect(second).toMatchObject({ materialized: [], nextDate: '2024-04-30' })
    expect((await db.collection('groups/group-a/expenses').get()).size).toBe(3)
  })

  it('fans out activity idempotently without double-counting unread notifications', async () => {
    await Promise.all([
      db.doc('groups/group-fanout').set({ name: 'Fanout' }),
      db.doc('groups/group-fanout/members/fan-owner').set({ status: 'active' }),
      db.doc('groups/group-fanout/members/fan-member').set({ status: 'active' }),
    ])
    const activity = { id: 'activity-a', kind: 'expense.created', subject: { kind: 'expense', id: 'expense-a' }, actor: { id: 'fan-owner', displayName: 'Owner' }, createdAt: '2026-08-31T12:00:00.000Z' }
    await Promise.all(Array.from({ length: 8 }, () => fanOutActivity(db, 'group-fanout', 'activity-a', activity)))
    expect((await db.doc('users/fan-member/notifications/activity-a').get()).data()).toMatchObject({ readAt: null, principalId: 'fan-member' })
    expect((await db.doc('users/fan-member/settings/notificationReadCursor').get()).data()).toMatchObject({ unreadCount: 1 })
    expect((await db.collection('users/fan-member/activity').get()).size).toBe(1)
    expect((await db.collection('users/fan-owner/notifications').get()).size).toBe(0)
  }, 30_000)

  it('claims private jobs once, avoids live OCR in emulation, and allowlists export fields', async () => {
    await db.doc('groups/group-a/expenses/exported').set({ id: 'exported', date: '2026-08-31', description: 'Dinner', category: 'Dining', total: { currency: 'USD', minorAmount: 1234 }, notes: 'private note', rawToken: 'must-not-export' })
    const exportJob = { schemaVersion: 1, status: 'queued', ownerUid: 'owner', groupId: 'group-a', type: 'large-export', format: 'json' }
    await db.doc('users/owner/jobs/export-worker').set(exportJob)
    await Promise.all(Array.from({ length: 4 }, () => runJobWorker(db, storage, 'owner', 'export-worker', exportJob, true)))
    const exportState = (await db.doc('users/owner/jobs/export-worker').get()).data()!
    expect(exportState.status).toBe('complete')
    const [exportBytes] = await storage.bucket().file(String(exportState.storagePath)).download()
    const exportText = exportBytes.toString('utf8')
    expect(exportText).toContain('Dinner')
    expect(exportText).not.toContain('private note')
    expect(exportText).not.toContain('must-not-export')

    const ocrJob = { schemaVersion: 1, status: 'queued', ownerUid: 'owner', groupId: 'group-a', type: 'receipt-ocr', assetId: 'receipt-a' }
    await db.doc('users/owner/jobs/ocr-worker').set(ocrJob)
    await runJobWorker(db, storage, 'owner', 'ocr-worker', ocrJob, true)
    expect((await db.doc('users/owner/jobs/ocr-worker').get()).data()).toMatchObject({ status: 'complete', suggestion: { editable: true }, provider: { kind: 'deterministic-emulator', contactedLiveService: false } })

    await db.doc('groups/group-a/members/removed').set({ status: 'removed' })
    const deniedJob = { schemaVersion: 1, status: 'queued', ownerUid: 'removed', groupId: 'group-a', type: 'large-export', format: 'csv' }
    await db.doc('users/removed/jobs/denied-worker').set(deniedJob)
    await runJobWorker(db, storage, 'removed', 'denied-worker', deniedJob, true)
    expect((await db.doc('users/removed/jobs/denied-worker').get()).data()).toMatchObject({ status: 'failed', errorCode: 'permission-denied' })
  }, 30_000)
})

async function seed(db: Firestore): Promise<void> {
  await Promise.all([
    db.doc('users/owner').set({ displayName: 'Owner', initials: 'O' }),
    db.doc('users/member').set({ displayName: 'Member', initials: 'M' }),
    db.doc('users/guest').set({ displayName: 'Guest', initials: 'G' }),
    db.doc('users/challenger').set({ displayName: 'Challenger', initials: 'C' }),
    db.doc('users/removed').set({ displayName: 'Removed', initials: 'R' }),
    db.doc('groups/group-a').set({ name: 'Group A', currency: 'USD', memberIds: ['owner', 'member'] }),
    db.doc('groups/group-a/members/owner').set({ status: 'active', role: 'owner', canManage: true }),
    db.doc('groups/group-a/members/member').set({ status: 'active', role: 'member', canManage: false }),
    db.doc('groups/group-a/members/removed').set({ status: 'removed', role: 'member', canManage: false }),
    db.doc('groups/group-a/balance/current').set({ groupId: 'group-a', balanceRevision: 0, simplifyDebtsEnabled: true, pairwise: [], simplified: [] }),
  ])
}

function fragmentToken(link: string): string {
  const token = new URL(link).hash.replace(/^#token=/, '')
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
  return token
}
