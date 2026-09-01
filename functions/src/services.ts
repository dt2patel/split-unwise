import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { FieldValue, type Firestore, type DocumentData } from 'firebase-admin/firestore'
import type { Storage } from 'firebase-admin/storage'
import { z } from 'zod'
import { assertCurrencyCode, canonicalize } from '@split-unwise/shared'
import { LedgerError, executeLedgerCommand, nextOccurrence } from './ledger.js'

const id = z.string().trim().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
const operationId = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
const email = z.email().transform((value) => value.trim().toLowerCase())
const token = z.string().regex(/^[A-Za-z0-9_-]{43}$/)

const invitationCreateSchema = z.strictObject({ schemaVersion: z.literal(1), operationId, groupId: id, targetEmail: email.optional(), origin: z.url().refine((value) => { const url = new URL(value); return url.protocol === 'https:' && url.origin === value }) })
const invitationAccessSchema = z.strictObject({ schemaVersion: z.literal(1), invitationId: id, token })
const invitationRevokeSchema = z.strictObject({ schemaVersion: z.literal(1), operationId, invitationId: id })

export async function createInvitationService(db: Firestore, uid: string, raw: unknown, secret: string, now = new Date()): Promise<DocumentData> {
  const input = parse(invitationCreateSchema, raw)
  const hash = hashRequest(input)
  const invitationId = deterministicId('inv', uid, input.operationId)
  const rawToken = deriveInvitationToken(secret, uid, input.operationId)
  const tokenHash = hashToken(rawToken)
  const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString()
  const result = await db.runTransaction(async (transaction) => {
    const operationRef = db.doc(`users/${uid}/operations/${input.operationId}`)
    const memberRef = db.doc(`groups/${input.groupId}/members/${uid}`)
    const [operation, member, group] = await Promise.all([transaction.get(operationRef), transaction.get(memberRef), transaction.get(db.doc(`groups/${input.groupId}`))])
    if (member.data()?.status !== 'active' || !canManage(member.data())) throw new LedgerError('permission-denied', 'Only an active group manager can invite people.')
    if (!group.exists) throw new LedgerError('not-found', 'Group was not found.')
    if (operation.exists) {
      const stored = operation.data()!
      if (stored.kind !== 'invitation.create' || stored.requestHash !== hash) throw new LedgerError('already-exists', 'This operation ID was already used.')
      return stored.result
    }
    const groupData = group.data()!
    if (groupData.kind === 'friendship' && (!input.targetEmail || !Array.isArray(groupData.memberIds) || groupData.memberIds.length >= 2)) {
      throw new LedgerError('failed-precondition', 'Friend invitations require a verified email and an open two-person friendship.')
    }
    const invitation = { schemaVersion: 1, invitationId, groupId: input.groupId, tokenHash, expiresAt, createdAt: now.toISOString(), createdByUid: uid, targetEmail: input.targetEmail ?? null, status: 'active' }
    const storedResult = { invitationId, groupId: input.groupId, expiresAt, targetEmail: input.targetEmail ?? null, groupName: group.data()?.name ?? 'Group' }
    transaction.create(db.doc(`invitations/${invitationId}`), invitation)
    transaction.create(operationRef, { schemaVersion: 1, uid, kind: 'invitation.create', requestHash: hash, groupId: input.groupId, status: 'succeeded', result: storedResult, committedAt: now.toISOString() })
    return storedResult
  })
  return { ...result, link: `${input.origin}/invite/${encodeURIComponent(invitationId)}#token=${rawToken}` }
}

export async function inspectInvitationService(db: Firestore, uid: string, identity: Identity, raw: unknown, now = new Date()): Promise<DocumentData> {
  const input = parse(invitationAccessSchema, raw)
  const invitation = await db.doc(`invitations/${input.invitationId}`).get()
  if (!invitation.exists) throw new LedgerError('not-found', 'Invitation was not found.')
  const data = invitation.data()!
  assertInvitationUsable(data, input.token, identity, now, uid)
  const [group, membership] = await Promise.all([db.doc(`groups/${data.groupId}`).get(), db.doc(`groups/${data.groupId}/members/${uid}`).get()])
  if (data.status === 'used' && membership.data()?.status !== 'active') throw new LedgerError('failed-precondition', 'Invitation was already used.')
  return { invitationId: input.invitationId, groupId: data.groupId, groupName: group.data()?.name ?? 'Group', expiresAt: data.expiresAt, alreadyMember: membership.data()?.status === 'active', targetEmail: data.targetEmail ?? null }
}

export async function acceptInvitationService(db: Firestore, uid: string, identity: Identity, raw: unknown, now = new Date()): Promise<DocumentData> {
  const input = parse(invitationAccessSchema, raw)
  return db.runTransaction(async (transaction) => {
    const inviteRef = db.doc(`invitations/${input.invitationId}`)
    const profileRef = db.doc(`users/${uid}`)
    const [invite, profile] = await Promise.all([transaction.get(inviteRef), transaction.get(profileRef)])
    if (!invite.exists) throw new LedgerError('not-found', 'Invitation was not found.')
    if (!profile.exists) throw new LedgerError('failed-precondition', 'Complete your profile before joining a group.')
    const data = invite.data()!
    assertInvitationUsable(data, input.token, identity, now, uid)
    const memberRef = db.doc(`groups/${data.groupId}/members/${uid}`)
    const [member, group] = await Promise.all([transaction.get(memberRef), transaction.get(db.doc(`groups/${data.groupId}`))])
    if (!group.exists) throw new LedgerError('not-found', 'Group was not found.')
    if (data.status === 'used') {
      if (member.data()?.status === 'active' && data.usedByUid === uid) return { invitationId: input.invitationId, groupId: data.groupId, status: 'already-member' }
      throw new LedgerError('failed-precondition', 'Invitation was already used.')
    }
    if (member.data()?.status === 'active') return { invitationId: input.invitationId, groupId: data.groupId, status: 'already-member' }
    const groupData = group.data()!
    if (groupData.kind === 'friendship' && (!Array.isArray(groupData.memberIds) || groupData.memberIds.length !== 1)) {
      throw new LedgerError('failed-precondition', 'This friendship already has two people.')
    }
    const profileData = profile.data()!
    const actor = { id: uid, displayName: profileData.displayName }
    const activityId = deterministicId('act', input.invitationId, uid)
    transaction.set(memberRef, { status: 'active', role: 'member', canManage: false, displayName: profileData.displayName, initials: profileData.initials, avatarUrl: profileData.avatarUrl ?? null, joinedAt: now.toISOString() })
    transaction.set(db.doc(`users/${uid}/groups/${data.groupId}`), { groupId: data.groupId, status: 'active', joinedAt: now.toISOString(), updatedAt: now.toISOString() })
    transaction.update(group.ref, { memberIds: FieldValue.arrayUnion(uid), updatedAt: now.toISOString() })
    transaction.update(inviteRef, { status: 'used', usedAt: now.toISOString(), usedByUid: uid })
    transaction.create(db.doc(`groups/${data.groupId}/activity/${activityId}`), { id: activityId, groupId: data.groupId, operationId: deterministicUuid(input.invitationId, uid), kind: 'membership.changed', subject: { kind: 'membership', id: uid, label: profileData.displayName }, actor, createdAt: now.toISOString() })
    return { invitationId: input.invitationId, groupId: data.groupId, status: 'accepted' }
  })
}

export async function revokeInvitationService(db: Firestore, uid: string, raw: unknown, now = new Date()): Promise<DocumentData> {
  const input = parse(invitationRevokeSchema, raw)
  const hash = hashRequest(input)
  return db.runTransaction(async (transaction) => {
    const operationRef = db.doc(`users/${uid}/operations/${input.operationId}`)
    const invitationRef = db.doc(`invitations/${input.invitationId}`)
    const [operation, invitation] = await Promise.all([transaction.get(operationRef), transaction.get(invitationRef)])
    if (!invitation.exists) throw new LedgerError('not-found', 'Invitation was not found.')
    const data = invitation.data()!
    const membership = await transaction.get(db.doc(`groups/${data.groupId}/members/${uid}`))
    if (membership.data()?.status !== 'active' || (!canManage(membership.data()) && data.createdByUid !== uid)) throw new LedgerError('permission-denied', 'Only the invitation creator or a group manager can revoke it.')
    if (operation.exists) {
      const stored = operation.data()!
      if (stored.kind !== 'invitation.revoke' || stored.requestHash !== hash) throw new LedgerError('already-exists', 'This operation ID was already used.')
      return stored.result
    }
    const result = { invitationId: input.invitationId, groupId: data.groupId, status: data.status === 'active' ? 'revoked' : data.status }
    if (data.status === 'active') transaction.update(invitationRef, { status: 'revoked', revokedAt: now.toISOString(), revokedByUid: uid })
    transaction.create(operationRef, { schemaVersion: 1, uid, kind: 'invitation.revoke', requestHash: hash, groupId: data.groupId, status: 'succeeded', result, committedAt: now.toISOString() })
    return result
  })
}

const profileSchema = z.strictObject({ schemaVersion: z.literal(1) })
export async function bootstrapProfileService(db: Firestore, uid: string, identity: Identity, raw: unknown, now = new Date()): Promise<DocumentData> {
  parse(profileSchema, raw)
  const displayName = normalizeDisplayName(identity.displayName ?? identity.email?.split('@')[0] ?? 'Split Unwise member')
  const initials = displayName.split(/\s+/).slice(0, 2).map((part) => part[0].toUpperCase()).join('')
  return db.runTransaction(async (transaction) => {
    const ref = db.doc(`users/${uid}`)
    const existing = await transaction.get(ref)
    if (existing.exists) return { status: 'ready' }
    transaction.create(ref, { displayName, initials, ...(identity.photoURL ? { avatarUrl: identity.photoURL } : {}), createdAt: now.toISOString(), updatedAt: now.toISOString() })
    return { status: 'created' }
  })
}

const createGroupSchema = z.strictObject({ schemaVersion: z.literal(1), operationId, kind: z.enum(['group', 'friendship']).default('group'), name: z.string().trim().min(1).max(120), currency: z.string().length(3).toUpperCase() })
export async function createGroupService(db: Firestore, uid: string, raw: unknown, now = new Date()): Promise<DocumentData> {
  const input = parse(createGroupSchema, raw)
  try { assertCurrencyCode(input.currency) } catch { throw new LedgerError('invalid-argument', 'Group currency must be a supported ISO 4217 code.') }
  const groupId = deterministicId('grp', uid, input.operationId)
  return db.runTransaction(async (transaction) => {
    const profile = await transaction.get(db.doc(`users/${uid}`))
    const operationRef = db.doc(`users/${uid}/operations/${input.operationId}`)
    const operation = await transaction.get(operationRef)
    if (!profile.exists) throw new LedgerError('failed-precondition', 'Complete your profile before creating a group.')
    const hash = hashRequest(input)
    if (operation.exists) {
      const data = operation.data()!
      if (data.kind !== 'group.create' || data.requestHash !== hash) throw new LedgerError('already-exists', 'This operation ID was already used.')
      return data.result
    }
    const group = { id: groupId, kind: input.kind, name: input.name, currency: input.currency, memberIds: [uid], createdAt: now.toISOString(), createdByUid: uid, updatedAt: now.toISOString() }
    const result = { status: 'created', groupId }
    transaction.create(db.doc(`groups/${groupId}`), group)
    const profileData = profile.data()!
    transaction.create(db.doc(`groups/${groupId}/members/${uid}`), { status: 'active', role: 'owner', canManage: true, displayName: profileData.displayName, initials: profileData.initials, avatarUrl: profileData.avatarUrl ?? null, joinedAt: now.toISOString() })
    transaction.create(db.doc(`groups/${groupId}/settings/defaults`), { schemaVersion: 1, groupId, revision: 1, simplifyDebtsEnabled: true, updatedAt: now.toISOString() })
    transaction.create(db.doc(`groups/${groupId}/balance/current`), { groupId, balanceRevision: 0, simplifyDebtsEnabled: true, pairwise: [], simplified: [] })
    transaction.create(db.doc(`users/${uid}/groups/${groupId}`), { groupId, status: 'active', joinedAt: now.toISOString(), updatedAt: now.toISOString() })
    transaction.create(operationRef, { schemaVersion: 1, uid, kind: 'group.create', requestHash: hash, groupId, status: 'succeeded', result, committedAt: now.toISOString() })
    return result
  })
}

const promoteSchema = z.strictObject({ schemaVersion: z.literal(1), operationId, groupId: id, assetId: id, purpose: z.enum(['expense-receipt', 'comment-attachment']) })
export async function promoteDraftService(db: Firestore, storage: Storage, uid: string, raw: unknown, now = new Date()): Promise<DocumentData> {
  const input = parse(promoteSchema, raw)
  const hash = hashRequest(input)
  const operationRef = db.doc(`users/${uid}/operations/${input.operationId}`)
  const [operation, membership] = await Promise.all([operationRef.get(), db.doc(`groups/${input.groupId}/members/${uid}`).get()])
  if (membership.data()?.status !== 'active') throw new LedgerError('permission-denied', 'Active group membership is required.')
  if (operation.exists) {
    const data = operation.data()!
    if (data.kind !== 'asset.promote' || data.requestHash !== hash) throw new LedgerError('already-exists', 'This operation ID was already used.')
    return data.result
  }
  const bucket = storage.bucket()
  const draft = bucket.file(`drafts/${uid}/${input.assetId}`)
  const [metadata] = await draft.getMetadata().catch(() => { throw new LedgerError('not-found', 'Draft upload was not found.') })
  if (metadata.metadata?.ownerUid !== uid || metadata.metadata.operationId !== input.operationId || metadata.metadata.purpose !== input.purpose) throw new LedgerError('invalid-argument', 'Draft metadata does not match the promotion request.')
  const [bytes] = await draft.download()
  const contentType = sniffImage(bytes)
  if (!contentType || contentType !== metadata.contentType) throw new LedgerError('invalid-argument', 'Uploaded bytes do not match the declared image type.')
  const finalPath = `groups/${input.groupId}/assets/${input.assetId}`
  const destination = bucket.file(finalPath)
  if (!(await destination.exists())[0]) await draft.copy(destination)
  const result = { status: 'ready', assetId: input.assetId, groupId: input.groupId, contentType }
  await db.runTransaction(async (transaction) => {
    const [savedOperation, activeMember] = await Promise.all([transaction.get(operationRef), transaction.get(db.doc(`groups/${input.groupId}/members/${uid}`))])
    if (activeMember.data()?.status !== 'active') throw new LedgerError('permission-denied', 'Active group membership is required.')
    if (savedOperation.exists) {
      if (savedOperation.data()!.kind !== 'asset.promote' || savedOperation.data()!.requestHash !== hash) throw new LedgerError('already-exists', 'This operation ID was already used.')
      return
    }
    transaction.set(db.doc(`groups/${input.groupId}/assets/${input.assetId}`), { ...result, ownerUid: uid, purpose: input.purpose, storagePath: finalPath, createdAt: now.toISOString() })
    transaction.create(operationRef, { schemaVersion: 1, uid, kind: 'asset.promote', requestHash: hash, groupId: input.groupId, status: 'succeeded', result, committedAt: now.toISOString() })
  })
  await draft.delete().catch(() => undefined)
  return result
}

const jobSchema = z.strictObject({ schemaVersion: z.literal(1), operationId, groupId: id, assetId: id.optional(), format: z.enum(['csv', 'json']).optional() })
export async function createJobService(db: Firestore, uid: string, raw: unknown, type: 'receipt-ocr' | 'large-export', now = new Date()): Promise<DocumentData> {
  const input = parse(jobSchema, raw)
  if (type === 'receipt-ocr' && (!input.assetId || input.format !== undefined)) throw new LedgerError('invalid-argument', 'OCR requires exactly one promoted receipt asset.')
  if (type === 'large-export' && (input.assetId !== undefined || input.format === undefined)) throw new LedgerError('invalid-argument', 'Large exports require a supported format and cannot reference an asset.')
  const jobId = deterministicId(type === 'receipt-ocr' ? 'ocr' : 'export', uid, input.operationId)
  const hash = hashRequest({ ...input, type })
  return db.runTransaction(async (transaction) => {
    const operationRef = db.doc(`users/${uid}/operations/${input.operationId}`)
    const reads = [transaction.get(operationRef), transaction.get(db.doc(`groups/${input.groupId}/members/${uid}`))]
    if (input.assetId) reads.push(transaction.get(db.doc(`groups/${input.groupId}/assets/${input.assetId}`)))
    const [operation, membership, asset] = await Promise.all(reads)
    if (membership.data()?.status !== 'active') throw new LedgerError('permission-denied', 'Active group membership is required.')
    if (input.assetId && (!asset?.exists || asset.data()?.groupId !== input.groupId || asset.data()?.status !== 'ready')) throw new LedgerError('invalid-argument', 'OCR requires your group’s promoted asset.')
    if (operation.exists) {
      const data = operation.data()!
      if (data.kind !== `job.${type}` || data.requestHash !== hash) throw new LedgerError('already-exists', 'This operation ID was already used.')
      return data.result
    }
    const result = { status: 'queued', jobId, groupId: input.groupId, type }
    transaction.create(db.doc(`users/${uid}/jobs/${jobId}`), { schemaVersion: 1, ...result, ownerUid: uid, operationId: input.operationId, assetId: input.assetId ?? null, format: input.format ?? 'csv', createdAt: now.toISOString(), updatedAt: now.toISOString() })
    transaction.create(operationRef, { schemaVersion: 1, uid, kind: `job.${type}`, requestHash: hash, groupId: input.groupId, status: 'succeeded', result, committedAt: now.toISOString() })
    return result
  })
}

const deviceSchema = z.strictObject({ schemaVersion: z.literal(1), operationId, token: z.string().trim().min(20).max(4096), platform: z.enum(['ios', 'android', 'web']) })
export async function registerPushDeviceService(db: Firestore, uid: string, raw: unknown, now = new Date()): Promise<DocumentData> {
  const input = parse(deviceSchema, raw)
  const deviceId = `dev_${createHash('sha256').update(input.token).digest('hex').slice(0, 40)}`
  await db.doc(`users/${uid}/devices/${deviceId}`).set({ token: input.token, platform: input.platform, status: 'active', updatedAt: now.toISOString() }, { merge: true })
  return { status: 'registered', deviceId }
}

const recurrenceSchema = z.strictObject({ schemaVersion: z.literal(1), groupId: id, templateId: id, throughDate: z.iso.date().optional() })
export async function materializeRecurrenceService(db: Firestore, uid: string, raw: unknown, now = new Date()): Promise<DocumentData> {
  const input = parse(recurrenceSchema, raw)
  const member = await db.doc(`groups/${input.groupId}/members/${uid}`).get()
  if (member.data()?.status !== 'active') throw new LedgerError('permission-denied', 'Active group membership is required.')
  return materializeTemplate(db, input.groupId, input.templateId, input.throughDate ?? now.toISOString().slice(0, 10))
}

export async function materializeTemplate(db: Firestore, groupId: string, templateId: string, throughDate: string): Promise<DocumentData> {
  const templateRef = db.doc(`groups/${groupId}/recurringTemplates/${templateId}`)
  const template = await templateRef.get()
  if (!template.exists || template.data()?.status !== 'active') return { status: 'inactive', materialized: [] }
  const data = template.data()!
  const created: string[] = []
  let date = String(data.nextDate)
  let guard = 0
  while (date <= throughDate && guard < 24) {
    const occurrenceId = `${templateId}:${date}`
    const op = deterministicUuid(templateId, date)
    await executeLedgerCommand(db, String(data.createdBy.id), { schemaVersion: 1, command: { kind: 'expense.add', operationId: op, groupId, description: data.description, date, total: data.total, payments: data.payments, allocations: data.allocations, category: data.category, splitMethod: data.splitMethod, attachmentRefs: [], occurrenceEditScope: 'occurrence' } })
    created.push(occurrenceId)
    date = nextOccurrence(date, data.recurrence)
    guard += 1
  }
  if (guard >= 24 && date <= throughDate) throw new LedgerError('resource-exhausted', 'Recurrence catch-up is limited to 24 occurrences per run.')
  await templateRef.update({ nextDate: date, updatedAt: new Date().toISOString() })
  return { status: 'complete', materialized: created, nextDate: date }
}

export async function processScheduledRecurrences(db: Firestore, today = new Date().toISOString().slice(0, 10)): Promise<number> {
  const due = await db.collectionGroup('recurringTemplates').where('status', '==', 'active').where('nextDate', '<=', today).orderBy('nextDate').limit(50).get()
  for (const template of due.docs) {
    const groupId = template.ref.parent.parent?.id
    if (groupId) await materializeTemplate(db, groupId, template.id, today)
  }
  return due.size
}

export async function fanOutActivity(db: Firestore, groupId: string, activityId: string, activity: DocumentData): Promise<void> {
  const members = await db.collection(`groups/${groupId}/members`).where('status', '==', 'active').limit(400).get()
  for (let offset = 0; offset < members.docs.length; offset += 20) {
    await Promise.all(members.docs.slice(offset, offset + 20).map(async (member) => {
      const activityRef = db.doc(`users/${member.id}/activity/${activityId}`)
      const notificationRef = db.doc(`users/${member.id}/notifications/${activityId}`)
      const cursorRef = db.doc(`users/${member.id}/settings/notificationReadCursor`)
      await db.runTransaction(async (transaction) => {
        const [projected, notification] = await Promise.all([
          transaction.get(activityRef),
          member.id === activity.actor?.id ? Promise.resolve(undefined) : transaction.get(notificationRef),
        ])
        if (!projected.exists) transaction.create(activityRef, { ...activity, groupId })
        if (member.id !== activity.actor?.id && !notification?.exists) {
          transaction.create(notificationRef, { notificationId: activityId, principalId: member.id, groupId, activityId, kind: activity.kind, subject: activity.subject, actor: activity.actor, createdAt: activity.createdAt, readAt: null })
          transaction.set(cursorRef, { schemaVersion: 1, unreadCount: FieldValue.increment(1), updatedAt: new Date().toISOString() }, { merge: true })
        }
      })
    }))
  }
}

export async function runJobWorker(db: Firestore, storage: Storage, uid: string, jobId: string, job: DocumentData, emulator: boolean): Promise<void> {
  const ref = db.doc(`users/${uid}/jobs/${jobId}`)
  if (job.status !== 'queued') return
  const claimed = await db.runTransaction(async (transaction) => {
    const [current, membership] = await Promise.all([transaction.get(ref), transaction.get(db.doc(`groups/${job.groupId}/members/${uid}`))])
    if (!current.exists || current.data()?.status !== 'queued') return false
    if (membership.data()?.status !== 'active') {
      transaction.update(ref, { status: 'failed', errorCode: 'permission-denied', updatedAt: new Date().toISOString() })
      return false
    }
    transaction.update(ref, { status: 'running', updatedAt: new Date().toISOString() })
    return true
  })
  if (!claimed) return
  try {
    if (job.type === 'receipt-ocr') {
      if (!emulator) throw new LedgerError('failed-precondition', 'OCR provider credentials are not configured.')
      await ref.update({ status: 'complete', suggestion: { merchant: 'Emulator receipt', date: '2026-01-01', total: null, confidence: 0, editable: true, items: [{ description: 'Receipt item', amountText: '' }] }, provider: { kind: 'deterministic-emulator', contactedLiveService: false }, updatedAt: new Date().toISOString() })
      return
    }
    const group = await db.doc(`groups/${job.groupId}`).get()
    const expenses = await db.collection(`groups/${job.groupId}/expenses`).orderBy('date').limit(1000).get()
    const safeRows = expenses.docs.map((document) => { const item = document.data(); return { id: document.id, date: item.date, description: item.description, category: item.category, currency: item.total?.currency, minorAmount: item.total?.minorAmount, deletedAt: item.deletedAt ?? null } })
    const contents = job.format === 'json' ? JSON.stringify({ group: { id: group.id, name: group.data()?.name }, expenses: safeRows }, null, 2) : exportCsv(safeRows)
    const extension = job.format === 'json' ? 'json' : 'csv'
    const storagePath = `exports/${uid}/${jobId}/split-unwise-export.${extension}`
    await storage.bucket().file(storagePath).save(contents, { contentType: job.format === 'json' ? 'application/json' : 'text/csv', resumable: false })
    await ref.update({ status: 'complete', storagePath, rowCount: safeRows.length, updatedAt: new Date().toISOString() })
  } catch (error) {
    await ref.update({ status: 'failed', errorCode: error instanceof LedgerError ? error.code : 'internal', updatedAt: new Date().toISOString() })
  }
}

function assertInvitationUsable(data: DocumentData, rawToken: string, identity: Identity, now: Date, uid?: string): void {
  const actual = Buffer.from(hashToken(rawToken))
  const expected = Buffer.from(String(data.tokenHash))
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new LedgerError('permission-denied', 'Invitation secret is invalid.')
  if (data.status === 'revoked') throw new LedgerError('failed-precondition', 'Invitation was revoked.')
  if (data.status !== 'active' && !(data.status === 'used' && data.usedByUid === uid)) throw new LedgerError('failed-precondition', 'Invitation was already used.')
  if (Date.parse(data.expiresAt) <= now.getTime()) throw new LedgerError('failed-precondition', 'Invitation expired.')
  if (data.targetEmail && (!identity.emailVerified || identity.email?.toLowerCase() !== data.targetEmail)) throw new LedgerError('permission-denied', 'Sign in with the verified email this invitation was sent to.')
}

export function deriveInvitationToken(secret: string, uid: string, operation: string): string {
  if (secret.length < 32) throw new LedgerError('failed-precondition', 'Invitation service is not configured.')
  return createHmac('sha256', secret).update(`split-unwise-invite-v1\0${uid}\0${operation}`).digest('base64url')
}
function hashToken(value: string): string { return createHash('sha256').update(value).digest('base64url') }
function hashRequest(value: unknown): string { return createHash('sha256').update(canonicalize(value)).digest('hex') }
function deterministicId(prefix: string, ...values: string[]): string { return `${prefix}_${createHash('sha256').update(values.join('\0')).digest('hex').slice(0, 32)}` }
export function deterministicUuid(...values: string[]): string { const hash = createHash('sha256').update(values.join('\0')).digest('hex'); return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}` }
function canManage(data: DocumentData | undefined): boolean { return data?.canManage === true || data?.role === 'owner' || data?.role === 'admin' }
function normalizeDisplayName(value: string): string { const result = value.trim().replace(/\s+/g, ' ').slice(0, 120); if (!result) throw new LedgerError('invalid-argument', 'Display name is required.'); return result }
function parse<T>(schema: z.ZodType<T>, raw: unknown): T { const result = schema.safeParse(raw); if (!result.success) throw new LedgerError('invalid-argument', 'The request payload is invalid.'); return result.data }

function sniffImage(bytes: Buffer): string | undefined {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  if (bytes.length >= 12 && bytes.toString('ascii', 4, 8) === 'ftyp') {
    const brand = bytes.toString('ascii', 8, 12)
    if (['heic', 'heix', 'hevc', 'hevx'].includes(brand)) return 'image/heic'
    if (['mif1', 'msf1'].includes(brand)) return 'image/heif'
  }
  return undefined
}

function exportCsv(rows: readonly Record<string, unknown>[]): string {
  const columns = ['id', 'date', 'description', 'category', 'currency', 'minorAmount', 'deletedAt']
  const escape = (value: unknown) => `"${String(value ?? '').replaceAll('"', '""')}"`
  return `${columns.join(',')}\n${rows.map((row) => columns.map((column) => escape(row[column])).join(',')).join('\n')}\n`
}

export interface Identity { readonly email?: string; readonly emailVerified: boolean; readonly displayName?: string; readonly photoURL?: string }
