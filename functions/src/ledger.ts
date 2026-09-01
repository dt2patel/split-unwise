import { createHash } from 'node:crypto'
import type { Firestore, Transaction, DocumentReference, DocumentData, QueryDocumentSnapshot } from 'firebase-admin/firestore'
import { assertSplitMatchesAllocations, canonicalize, computeLedgerBalancePlans, parseExecuteCommandRequest, validateLedgerExpense, type ExecuteCommandRequest, type SharedCommandEnvelope } from '@split-unwise/shared'

export type CallableResult = Record<string, unknown>

export class LedgerError extends Error {
  constructor(readonly code: 'already-exists' | 'failed-precondition' | 'invalid-argument' | 'not-found' | 'permission-denied' | 'resource-exhausted', message: string) {
    super(message)
    this.name = 'LedgerError'
  }
}

export function hashCanonicalRequest(request: ExecuteCommandRequest): string {
  return createHash('sha256').update(canonicalize(request)).digest('hex')
}

export async function executeLedgerCommand(db: Firestore, uid: string, rawRequest: unknown, now = new Date()): Promise<CallableResult> {
  let request: ExecuteCommandRequest
  try { request = parseExecuteCommandRequest(rawRequest) } catch { throw new LedgerError('invalid-argument', 'The command payload is invalid.') }
  const hash = hashCanonicalRequest(request)
  const command = request.command
  const isoNow = validNow(now)
  return db.runTransaction(async (transaction) => {
    const operationRef = db.doc(`users/${uid}/operations/${command.operationId}`)
    const operationSnapshot = await transaction.get(operationRef)
    const groupId = commandGroupId(command)
    const memberSnapshot = groupId ? await transaction.get(db.doc(`groups/${groupId}/members/${uid}`)) : undefined
    if (groupId && memberSnapshot?.data()?.status !== 'active') throw new LedgerError('permission-denied', 'Active group membership is required.')
    if (operationSnapshot.exists) {
      const stored = operationSnapshot.data()!
      if (stored.uid !== uid || stored.kind !== command.kind || stored.requestHash !== hash) throw new LedgerError('already-exists', 'This operation ID was already used for a different command.')
      if (!isRecord(stored.result)) throw new LedgerError('failed-precondition', 'The saved operation result is invalid.')
      return stored.result
    }

    const result = groupId
      ? await executeGroupCommand({ db, transaction, uid, command, groupId, membership: memberSnapshot!.data()!, isoNow })
      : await executePrivateCommand({ db, transaction, uid, command, isoNow })
    transaction.create(operationRef, { schemaVersion: 1, uid, kind: command.kind, requestHash: hash, groupId: groupId ?? null, status: 'succeeded', result, committedAt: isoNow })
    return result
  })
}

interface PrivateContext { db: Firestore; transaction: Transaction; uid: string; command: SharedCommandEnvelope; isoNow: string }

async function executePrivateCommand({ db, transaction, uid, command, isoNow }: PrivateContext): Promise<CallableResult> {
  if (command.kind === 'profile.update') {
    const userRef = db.doc(`users/${uid}`)
    const [current, projections] = await Promise.all([
      transaction.get(userRef),
      transaction.get(db.collection(`users/${uid}/groups`).limit(101)),
    ])
    if (projections.size > 100) throw new LedgerError('resource-exhausted', 'Profile updates support at most 100 group memberships.')
    const groupIds = projections.docs.map((projection) => projection.id)
    const memberRefs = groupIds.map((groupId) => db.doc(`groups/${groupId}/members/${uid}`))
    const groupRefs = groupIds.map((groupId) => db.doc(`groups/${groupId}`))
    const membershipSnapshots = groupIds.length > 0
      ? await transaction.getAll(...memberRefs, ...groupRefs)
      : []
    const members = membershipSnapshots.slice(0, groupIds.length)
    const groups = membershipSnapshots.slice(groupIds.length)
    const friendships = groupIds.flatMap((groupId, index) => {
      const member = members[index]
      const group = groups[index]
      const data = group?.data()
      if (member?.data()?.status !== 'active' || !group?.exists || !isRecord(data) || data.kind !== 'friendship' || !Array.isArray(data.memberIds)) return []
      const memberIds = data.memberIds
      if (memberIds.length !== 2 || memberIds.some((memberId) => typeof memberId !== 'string') || new Set(memberIds).size !== 2 || !memberIds.includes(uid)) return []
      const counterpartUid = memberIds.find((memberId) => memberId !== uid)
      return typeof counterpartUid === 'string' ? [{ groupId, counterpartUid }] : []
    })
    const counterpartMemberRefs = friendships.map(({ groupId, counterpartUid }) => db.doc(`groups/${groupId}/members/${counterpartUid}`))
    const counterpartProjectionRefs = friendships.map(({ groupId, counterpartUid }) => db.doc(`users/${counterpartUid}/groups/${groupId}`))
    const counterpartSnapshots = friendships.length > 0
      ? await transaction.getAll(...counterpartMemberRefs, ...counterpartProjectionRefs)
      : []
    const initials = command.initials ?? initialsFor(command.displayName)
    const profile = { displayName: command.displayName, initials, updatedAt: isoNow }
    current.exists ? transaction.update(userRef, profile) : transaction.create(userRef, { ...profile, createdAt: isoNow })
    members.forEach((member, index) => {
      if (member.data()?.status === 'active') transaction.update(memberRefs[index]!, { displayName: command.displayName, initials })
    })
    friendships.forEach((_, index) => {
      const counterpartMember = counterpartSnapshots[index]
      const counterpartProjection = counterpartSnapshots[index + friendships.length]
      if (counterpartMember?.data()?.status !== 'active') return
      if (!counterpartProjection?.exists || counterpartProjection.data()?.status !== 'active') throw new LedgerError('failed-precondition', 'The friendship projection is missing or inactive.')
      transaction.update(counterpartProjectionRefs[index]!, { contextLabel: command.displayName, updatedAt: isoNow })
    })
    return savedResource(command, uid)
  }
  if (command.kind === 'notification.preferences') {
    transaction.set(db.doc(`users/${uid}/settings/notifications`), { ...command.preferences, updatedAt: isoNow }, { merge: true })
    return { kind: command.kind, operationId: command.operationId, status: 'saved', preferences: command.preferences }
  }
  if (command.kind === 'notification.read') {
    const ref = db.doc(`users/${uid}/notifications/${command.notificationId}`)
    const cursorRef = db.doc(`users/${uid}/settings/notificationReadCursor`)
    const [snapshot, cursor] = await Promise.all([transaction.get(ref), transaction.get(cursorRef)])
    if (!snapshot.exists) throw new LedgerError('not-found', 'Notification was not found.')
    const existing = snapshot.data()!
    const notification = { ...existing, readAt: typeof existing.readAt === 'string' ? existing.readAt : isoNow }
    transaction.update(ref, { readAt: notification.readAt })
    if (typeof existing.readAt !== 'string') transaction.set(cursorRef, { schemaVersion: 1, unreadCount: Math.max(0, Number(cursor.data()?.unreadCount ?? 1) - 1), updatedAt: isoNow }, { merge: true })
    return { kind: command.kind, operationId: command.operationId, status: 'saved', notification }
  }
  if (command.kind === 'notification.read-all') {
    const cursorRef = db.doc(`users/${uid}/settings/notificationReadCursor`)
    transaction.set(cursorRef, { schemaVersion: 1, cutoff: command.cutoff, unreadCount: 0, updatedAt: isoNow }, { merge: true })
    return { kind: command.kind, operationId: command.operationId, status: 'saved', cutoff: command.cutoff, readNotificationIds: [] }
  }
  throw new LedgerError('invalid-argument', 'This command requires a group.')
}

interface GroupContext { db: Firestore; transaction: Transaction; uid: string; command: SharedCommandEnvelope; groupId: string; membership: DocumentData; isoNow: string }

async function executeGroupCommand(context: GroupContext): Promise<CallableResult> {
  const { db, transaction, uid, command, groupId, membership, isoNow } = context
  const actor = await actorSnapshot(db, transaction, uid)
  if (command.kind === 'expense.add' || command.kind === 'expense.edit' || command.kind === 'expense.delete') {
    return executeExpenseCommand(context, actor)
  }
  if (command.kind === 'comment.add' || command.kind === 'comment.delete') {
    return executeCommentCommand(context, actor)
  }
  if (command.kind === 'settlement.record' || command.kind === 'settlement.void') {
    return executeSettlementCommand(context, actor)
  }
  if (command.kind === 'group.default-split') {
    if (!canManage(membership)) throw new LedgerError('permission-denied', 'Only a group manager can change the default split.')
    const ref = db.doc(`groups/${groupId}/settings/defaults`)
    const snapshot = await transaction.get(ref)
    const revision = snapshot.exists ? positiveRevision(snapshot.data()!.revision) : 1
    if (revision !== command.expectedRevision) throw new LedgerError('failed-precondition', 'Group settings changed remotely.')
    if (command.defaultSplit) await assertMembersActive(db, transaction, groupId, command.defaultSplit.participantIds)
    const simplifyDebtsEnabled = snapshot.data()?.simplifyDebtsEnabled
    if (simplifyDebtsEnabled !== undefined && typeof simplifyDebtsEnabled !== 'boolean') throw new LedgerError('failed-precondition', 'Stored group settings are invalid.')
    const next = { schemaVersion: 1, groupId, revision: revision + 1, ...(command.defaultSplit ? { defaultSplit: command.defaultSplit } : {}), ...(simplifyDebtsEnabled !== undefined ? { simplifyDebtsEnabled } : {}), updatedAt: isoNow, updatedBy: actor }
    transaction.set(ref, next)
    return savedResource(command, groupId)
  }
  if (command.kind === 'group.simplify-debts') {
    const settingsRef = db.doc(`groups/${groupId}/settings/defaults`)
    const balanceRef = db.doc(`groups/${groupId}/balance/current`)
    const settingsSnapshot = await transaction.get(settingsRef)
    const balanceSnapshot = await transaction.get(balanceRef)
    const settings = settingsSnapshot.data() ?? {}
    const revision = settingsSnapshot.exists ? positiveRevision(settings.revision) : 1
    if (revision !== command.expectedRevision) throw new LedgerError('failed-precondition', 'Group settings changed remotely.')
    const balance = balanceSnapshot.data()
    if (!balanceSnapshot.exists || !balance || !Number.isSafeInteger(balance.balanceRevision) || Number(balance.balanceRevision) < 0
      || !Array.isArray(balance.pairwise) || !Array.isArray(balance.simplified)) {
      throw new LedgerError('failed-precondition', 'Stored group balance is invalid.')
    }
    if (Number(balance.balanceRevision) >= Number.MAX_SAFE_INTEGER || revision >= Number.MAX_SAFE_INTEGER) throw new LedgerError('failed-precondition', 'Group revision cannot advance.')
    const nextSettings = {
      schemaVersion: 1,
      groupId,
      revision: revision + 1,
      ...(settings.defaultSplit !== undefined ? { defaultSplit: settings.defaultSplit } : {}),
      simplifyDebtsEnabled: command.simplifyDebtsEnabled,
      updatedAt: isoNow,
      updatedBy: actor,
    }
    const nextBalance = {
      groupId,
      balanceRevision: Number(balance.balanceRevision) + 1,
      simplifyDebtsEnabled: command.simplifyDebtsEnabled,
      pairwise: balance.pairwise,
      simplified: balance.simplified,
    }
    const activity = {
      id: deterministicId('act', command.operationId),
      groupId,
      operationId: command.operationId,
      kind: 'group.event',
      subject: { kind: 'group', id: groupId, label: `Simplify debts ${command.simplifyDebtsEnabled ? 'enabled' : 'disabled'}` },
      actor,
      createdAt: isoNow,
    }
    transaction.set(settingsRef, nextSettings)
    transaction.set(balanceRef, nextBalance)
    transaction.create(db.doc(`groups/${groupId}/activity/${activity.id}`), activity)
    return savedResource(command, groupId)
  }
  throw new LedgerError('invalid-argument', 'This command cannot be used with a group.')
}

async function executeExpenseCommand(context: GroupContext, actor: Actor): Promise<CallableResult> {
  const { db, transaction, uid, command, groupId, membership, isoNow } = context
  if (command.kind !== 'expense.add' && command.kind !== 'expense.edit' && command.kind !== 'expense.delete') throw new LedgerError('invalid-argument', 'Expense command is invalid.')
  const expenseId = command.kind === 'expense.add' ? deterministicId('exp', command.operationId) : command.expenseId
  const expenseRef = db.doc(`groups/${groupId}/expenses/${expenseId}`)
  const existingSnapshot = command.kind === 'expense.add' ? undefined : await transaction.get(expenseRef)
  const existing = existingSnapshot?.data()
  if (command.kind !== 'expense.add') {
    if (!existingSnapshot?.exists || !existing) throw new LedgerError('not-found', 'Expense was not found.')
    if (positiveRevision(existing.revision) !== command.expectedRevision) throw new LedgerError('failed-precondition', 'Expense changed remotely.')
    if (existing.deletedAt) throw new LedgerError('failed-precondition', 'Deleted expenses cannot be changed.')
    if (existing.createdBy?.id !== uid && !canManage(membership)) throw new LedgerError('permission-denied', 'Only the expense author or a group manager can change it.')
  } else if ((await transaction.get(expenseRef)).exists) {
    throw new LedgerError('already-exists', 'The deterministic expense already exists.')
  }

  const draft = command.kind === 'expense.edit' ? command.draft : command.kind === 'expense.add' ? command : undefined
  if (draft) {
    try {
      validateLedgerExpense({ id: expenseId, total: draft.total, payments: draft.payments, allocations: draft.allocations })
      assertSplitMatchesAllocations(draft.total, draft.splitMethod, draft.allocations)
    } catch (error) { throw new LedgerError('invalid-argument', message(error)) }
    await assertMembersActive(db, transaction, groupId, [...draft.payments, ...draft.allocations].map(({ participantId }) => participantId))
    await assertPromotedAssets(db, transaction, groupId, draft.attachmentRefs)
  }

  const currentRevision = existing ? positiveRevision(existing.revision) : 0
  const revision = currentRevision + 1
  const expense: DocumentData = command.kind === 'expense.delete'
    ? { ...existing!, revision, updatedAt: isoNow, updatedBy: actor, deletedAt: isoNow }
    : {
        id: expenseId, groupId, description: draft!.description, date: draft!.date, total: draft!.total,
        payments: draft!.payments, allocations: draft!.allocations, category: draft!.category, splitMethod: draft!.splitMethod,
        attachmentRefs: draft!.attachmentRefs, ...(draft!.notes ? { notes: draft!.notes } : {}),
        ...(draft!.recurrence ? { recurrence: draft!.recurrence } : {}), ...(draft!.occurrenceEditScope ? { occurrenceEditScope: draft!.occurrenceEditScope } : {}),
        createdAt: existing?.createdAt ?? isoNow, createdBy: existing?.createdBy ?? actor, updatedAt: isoNow, updatedBy: actor, revision,
      }
  const action = command.kind === 'expense.add' ? 'created' : command.kind === 'expense.edit' ? 'updated' : 'deleted'
  const kind = `expense.${action}`
  const activity = expenseActivity(groupId, expenseId, command.operationId, kind, revision, actor, isoNow, expense.description as string)
  const balanceRef = db.doc(`groups/${groupId}/balance/current`)
  const currentBalance = await transaction.get(balanceRef)
  const balanceRevision = currentBalance.exists && Number.isSafeInteger(currentBalance.data()!.balanceRevision) ? currentBalance.data()!.balanceRevision + 1 : 1
  const nextBalance = await calculateBalanceWithMutation(db, transaction, groupId, { type: command.kind, id: expenseId, document: expense }, balanceRevision, currentBalance.data()?.simplifyDebtsEnabled !== false)
  transaction.set(expenseRef, expense)
  transaction.create(expenseRef.collection('revisions').doc(String(revision).padStart(10, '0')), { groupId, expenseId, revision, operationId: command.operationId, action, actor, createdAt: isoNow, expense })
  transaction.create(db.doc(`groups/${groupId}/activity/${deterministicId('act', command.operationId)}`), activity)
  transaction.set(balanceRef, nextBalance)

  if (draft?.recurrence && command.kind === 'expense.add') {
    const templateId = deterministicId('rec', command.operationId)
    transaction.set(db.doc(`groups/${groupId}/recurringTemplates/${templateId}`), { schemaVersion: 1, id: templateId, groupId, status: 'active', description: draft.description, total: draft.total, payments: draft.payments, allocations: draft.allocations, category: draft.category, splitMethod: draft.splitMethod, attachmentRefs: [], recurrence: draft.recurrence, anchorDate: draft.date, nextDate: nextOccurrence(draft.date, draft.recurrence), revision: 1, createdAt: isoNow, createdBy: actor })
  }

  if (command.kind === 'expense.delete') return { kind: command.kind, operationId: command.operationId, status: 'saved', tombstone: { id: expenseId, groupId, revision, deletedAt: isoNow } }
  return { kind: command.kind, operationId: command.operationId, status: 'saved', expense }
}

async function executeCommentCommand(context: GroupContext, actor: Actor): Promise<CallableResult> {
  const { db, transaction, uid, command, groupId, membership, isoNow } = context
  if (command.kind !== 'comment.add' && command.kind !== 'comment.delete') throw new LedgerError('invalid-argument', 'Comment command is invalid.')
  const expenseId = command.expenseId
  const expense = await transaction.get(db.doc(`groups/${groupId}/expenses/${expenseId}`))
  if (!expense.exists || expense.data()!.deletedAt) throw new LedgerError('not-found', 'Expense was not found.')
  const commentId = command.kind === 'comment.add' ? deterministicId('cmt', command.operationId) : command.commentId
  const ref = db.doc(`groups/${groupId}/comments/${commentId}`)
  const prior = command.kind === 'comment.delete' ? await transaction.get(ref) : undefined
  if (command.kind === 'comment.delete' && (!prior?.exists || prior.data()!.deletedAt)) throw new LedgerError('not-found', 'Comment was not found.')
  if (command.kind === 'comment.delete' && prior!.data()!.author?.id !== uid && !canManage(membership)) throw new LedgerError('permission-denied', 'Only the comment author or a group manager can delete it.')
  if (command.kind === 'comment.add') await assertPromotedAssets(db, transaction, groupId, command.attachmentRefs)
  const comment = command.kind === 'comment.add'
    ? { groupId, expenseId, operationId: command.operationId, author: actor, body: command.body, attachmentRefs: command.attachmentRefs, createdAt: isoNow }
    : { ...prior!.data()!, deletedAt: isoNow }
  const action = command.kind === 'comment.add' ? 'added' : 'deleted'
  const activity = { id: deterministicId('act', command.operationId), groupId, operationId: command.operationId, kind: `comment.${action}`, subject: { kind: 'comment', id: commentId }, actor, expenseId, commentId, createdAt: isoNow }
  transaction.set(ref, comment)
  transaction.create(db.doc(`groups/${groupId}/activity/${activity.id}`), activity)
  return { kind: command.kind, operationId: command.operationId, status: 'saved', comment: { commentId, ...comment }, activity }
}

async function executeSettlementCommand(context: GroupContext, actor: Actor): Promise<CallableResult> {
  const { db, transaction, uid, command, groupId, membership, isoNow } = context
  if (command.kind !== 'settlement.record' && command.kind !== 'settlement.void') throw new LedgerError('invalid-argument', 'Settlement command is invalid.')
  const settlementId = command.kind === 'settlement.record' ? deterministicId('set', command.operationId) : command.settlementId
  const ref = db.doc(`groups/${groupId}/settlements/${settlementId}`)
  const existing = command.kind === 'settlement.void' ? await transaction.get(ref) : undefined
  if (command.kind === 'settlement.void') {
    if (!existing?.exists) throw new LedgerError('not-found', 'Settlement was not found.')
    if (positiveRevision(existing.data()!.revision) !== command.expectedRevision || existing.data()!.void) throw new LedgerError('failed-precondition', 'Settlement changed remotely.')
    if (existing.data()!.createdBy?.id !== uid && !canManage(membership)) throw new LedgerError('permission-denied', 'Only the settlement author or a group manager can void it.')
  } else {
    if (command.basis.senderId === command.basis.recipientId || command.money.currency !== command.basis.currency || command.money.minorAmount > command.basis.debtMinor) throw new LedgerError('invalid-argument', 'Settlement basis does not match the payment.')
    if (uid !== command.basis.senderId && uid !== command.basis.recipientId) throw new LedgerError('permission-denied', 'Only a settlement participant can record the payment.')
    await assertMembersActive(db, transaction, groupId, [command.basis.senderId, command.basis.recipientId])
  }
  const balanceRef = db.doc(`groups/${groupId}/balance/current`)
  const balanceSnapshot = await transaction.get(balanceRef)
  const currentBalance: DocumentData = balanceSnapshot.exists ? balanceSnapshot.data()! : { balanceRevision: 0, pairwise: [], simplified: [], simplifyDebtsEnabled: true }
  if (currentBalance.balanceRevision !== command.expectedBalanceRevision) throw new LedgerError('failed-precondition', 'Group balance changed remotely.')
  if (command.kind === 'settlement.record') assertSettlementBasis(currentBalance, command)
  const settlement = command.kind === 'settlement.record'
    ? { settlementId, groupId, operationId: command.operationId, senderId: command.basis.senderId, recipientId: command.basis.recipientId, money: command.money, basis: command.basis, method: command.method, occurredOn: command.occurredOn, ...(command.note ? { note: command.note } : {}), createdBy: actor, createdAt: isoNow, revision: 1 }
    : { ...existing!.data()!, revision: 2, void: { operationId: command.operationId, reason: command.reason, actor, createdAt: isoNow, revision: 2 } }
  const kind = command.kind === 'settlement.record' ? 'settlement.created' : 'settlement.voided'
  const activity = { id: deterministicId('act', command.operationId), groupId, operationId: command.operationId, kind, subject: { kind: 'settlement', id: settlementId }, actor, settlementId, createdAt: isoNow }
  const nextBalance = await calculateBalanceWithMutation(db, transaction, groupId, { type: command.kind, id: settlementId, document: settlement }, Number(currentBalance.balanceRevision) + 1, currentBalance.simplifyDebtsEnabled !== false)
  transaction.set(ref, settlement)
  transaction.create(db.doc(`groups/${groupId}/activity/${activity.id}`), activity)
  transaction.set(balanceRef, nextBalance)
  return { kind: command.kind, operationId: command.operationId, status: 'saved', settlement, balanceSnapshot: nextBalance, activity }
}

async function calculateBalanceWithMutation(db: Firestore, transaction: Transaction, groupId: string, mutation: { type: string; id: string; document: DocumentData }, balanceRevision: number, simplifyDebtsEnabled: boolean): Promise<DocumentData> {
  const [expensesSnapshot, settlementsSnapshot] = await Promise.all([
    transaction.get(db.collection(`groups/${groupId}/expenses`).limit(500)),
    transaction.get(db.collection(`groups/${groupId}/settlements`).limit(500)),
  ])
  if (expensesSnapshot.size >= 500 || settlementsSnapshot.size >= 500) throw new LedgerError('resource-exhausted', 'This group is too large for an inline balance rebuild.')
  const expenses = mapDocuments(expensesSnapshot.docs)
  const settlements = mapDocuments(settlementsSnapshot.docs)
  if (mutation.type.startsWith('expense.')) replaceDocument(expenses, mutation.id, mutation.document)
  if (mutation.type.startsWith('settlement.')) replaceDocument(settlements, mutation.id, mutation.document)
  const plans = computeLedgerBalancePlans(
    expenses.filter((item) => !item.deletedAt).map(toLedgerExpense),
    settlements.map((item) => ({ id: String(item.settlementId ?? item.id), senderId: String(item.senderId), recipientId: String(item.recipientId), money: item.money, voided: Boolean(item.void) })),
  )
  return { groupId, balanceRevision, simplifyDebtsEnabled, pairwise: plans.pairwise, simplified: plans.simplified }
}

function toLedgerExpense(value: DocumentData) {
  return { id: String(value.id), total: value.total, payments: value.payments, allocations: value.allocations }
}
function mapDocuments(documents: readonly QueryDocumentSnapshot[]): DocumentData[] { return documents.map((document) => ({ id: document.id, ...document.data() })) }
function replaceDocument(documents: DocumentData[], id: string, document: DocumentData): void { const index = documents.findIndex((item) => item.id === id); if (index >= 0) documents[index] = { id, ...document }; else documents.push({ id, ...document }) }

async function actorSnapshot(db: Firestore, transaction: Transaction, uid: string): Promise<Actor> {
  const user = await transaction.get(db.doc(`users/${uid}`))
  const displayName = user.exists && typeof user.data()!.displayName === 'string' ? user.data()!.displayName.trim() : ''
  if (!displayName) throw new LedgerError('failed-precondition', 'Complete your profile before changing the ledger.')
  return { id: uid, displayName }
}

async function assertMembersActive(db: Firestore, transaction: Transaction, groupId: string, participantIds: readonly string[]): Promise<void> {
  const unique = [...new Set(participantIds)]
  if (unique.length === 0 || unique.length > 100) throw new LedgerError('invalid-argument', 'Participants are invalid.')
  const snapshots = await transaction.getAll(...unique.map((uid) => db.doc(`groups/${groupId}/members/${uid}`)))
  if (snapshots.some((snapshot) => !snapshot.exists || snapshot.data()?.status !== 'active')) throw new LedgerError('invalid-argument', 'Every payer and participant must be an active member.')
}

async function assertPromotedAssets(db: Firestore, transaction: Transaction, groupId: string, assetIds: readonly string[]): Promise<void> {
  if (assetIds.length === 0) return
  const unique = [...new Set(assetIds)]
  if (unique.length !== assetIds.length) throw new LedgerError('invalid-argument', 'Attachment IDs must be unique.')
  const snapshots = await transaction.getAll(...unique.map((id) => db.doc(`groups/${groupId}/assets/${id}`)))
  if (snapshots.some((snapshot) => !snapshot.exists || snapshot.data()?.groupId !== groupId || snapshot.data()?.status !== 'ready')) throw new LedgerError('invalid-argument', 'Every attachment must be a promoted asset in this group.')
}

function assertSettlementBasis(balance: DocumentData, command: Extract<SharedCommandEnvelope, { kind: 'settlement.record' }>): void {
  const debts = command.basis.kind === 'pairwise' ? balance.pairwise : balance.simplified
  if (!Array.isArray(debts)) throw new LedgerError('failed-precondition', 'The current balance is invalid.')
  const debt = debts.find((item) => item?.fromParticipantId === command.basis.senderId && item?.toParticipantId === command.basis.recipientId && item?.money?.currency === command.basis.currency)
  if (!debt || debt.money.minorAmount !== command.basis.debtMinor || command.money.minorAmount > debt.money.minorAmount) throw new LedgerError('failed-precondition', 'The settlement basis is stale.')
}

function commandGroupId(command: SharedCommandEnvelope): string | undefined { return 'groupId' in command ? command.groupId : undefined }
function canManage(membership: DocumentData): boolean { return membership.canManage === true || membership.role === 'owner' || membership.role === 'admin' }
function positiveRevision(value: unknown): number { if (!Number.isSafeInteger(value) || Number(value) < 1) throw new LedgerError('failed-precondition', 'Stored revision is invalid.'); return Number(value) }
function savedResource(command: SharedCommandEnvelope, resourceId: string): CallableResult { return { kind: command.kind, operationId: command.operationId, status: 'saved', resourceId } }
function deterministicId(prefix: string, operationId: string): string { return `${prefix}_${operationId.replaceAll('-', '')}` }
function initialsFor(displayName: string): string { return displayName.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0].toUpperCase()).join('') || '?' }
function validNow(now: Date): string { if (!Number.isFinite(now.getTime())) throw new LedgerError('invalid-argument', 'Current time is invalid.'); return now.toISOString() }
function message(error: unknown): string { return error instanceof Error ? error.message : 'The ledger command is invalid.' }
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
interface Actor { readonly id: string; readonly displayName: string }

function expenseActivity(groupId: string, expenseId: string, operationId: string, kind: string, revision: number, actor: Actor, createdAt: string, label: string): DocumentData {
  return { id: deterministicId('act', operationId), groupId, operationId, kind, subject: { kind: 'expense', id: expenseId, label }, actor, expenseId, revision, createdAt }
}

export function nextOccurrence(date: string, recurrence: { frequency: 'weekly' | 'fortnightly' | 'monthly' | 'yearly'; anchor: { month: number; day: number }; timeZone: string }): string {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!parts) throw new LedgerError('invalid-argument', 'Recurrence date is invalid.')
  const source = new Date(Date.UTC(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3])))
  if (source.toISOString().slice(0, 10) !== date) throw new LedgerError('invalid-argument', 'Recurrence date is invalid.')
  if (recurrence.frequency === 'weekly' || recurrence.frequency === 'fortnightly') source.setUTCDate(source.getUTCDate() + (recurrence.frequency === 'weekly' ? 7 : 14))
  else if (recurrence.frequency === 'monthly') {
    const targetMonth = source.getUTCMonth() + 1
    const last = new Date(Date.UTC(source.getUTCFullYear(), targetMonth + 1, 0)).getUTCDate()
    source.setUTCFullYear(source.getUTCFullYear(), targetMonth, Math.min(recurrence.anchor.day, last))
  } else {
    const year = source.getUTCFullYear() + 1
    const month = recurrence.anchor.month - 1
    const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
    source.setUTCFullYear(year, month, Math.min(recurrence.anchor.day, last))
  }
  return source.toISOString().slice(0, 10)
}
