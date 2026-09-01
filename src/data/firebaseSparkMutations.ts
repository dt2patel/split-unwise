import { getAuth, type User } from 'firebase/auth'
import { arrayUnion, doc, getDoc, getFirestore, runTransaction, serverTimestamp, Timestamp, updateDoc, writeBatch, type DocumentData } from 'firebase/firestore'
import { assertCurrencyCode } from '../domain/money'
import { decodeDefaultSplit, updateGroupSettings, type GroupSettings } from '../domain/groupSettings'
import { canonicalHttpsOrigin, generateInvitationSecret, hashInvitationSecret, type PreparedInvitation } from '../features/invitations/invitations'
import type { FirebaseConfiguration } from './firebase'
import { getSplitUnwiseFirebaseApp } from './firebaseBootstrap'
import { decodeExpense, decodeRecurringExpense, decodeSettlement } from './firebaseDecoders'
import { isStrictId } from './identifiers'
import type { ActorSnapshot, CommentAddCommand, CommentDeleteCommand, ExpenseAddCommand, ExpenseContextKind, ExpenseDeleteCommand, ExpenseDraft, ExpenseEditCommand, ExpenseRow, GroupDefaultSplitCommand, GroupSimplifyDebtsCommand, Member, NotificationItem, NotificationPreferencesCommand, NotificationReadAllCommand, NotificationReadCommand, ProfileUpdateCommand, RecurrenceCancelCommand, RecurrenceMaterializeCommand, SettlementRecordCommand, SettlementVoidCommand } from './repositories'
import { createOperationIdentity, type OperationIdentity } from './operationIdentity'
import { compareTimelineAscending } from './timeline'
import { nextOccurrence, recurringOccurrenceId } from '../domain/recurrence'
import { assertSplitMatchesAllocations, parseExecuteCommandRequest, validateLedgerExpense } from '@split-unwise/shared'

export interface FirebaseIdentity {
  readonly uid: string
  readonly displayName: string | null
  readonly email: string | null
  readonly photoURL: string | null
}

export interface FirebaseProfileDocument {
  readonly displayName: string
  readonly initials: string
  readonly avatarUrl: string | null
}

export interface SparkInvitationPreview {
  readonly groupId: string
  readonly groupName: string
  readonly alreadyMember: boolean
}

export type SparkFriendshipCreationResult =
  | { readonly status: 'ready'; readonly groupId: string; readonly invitation: PreparedInvitation }
  | { readonly status: 'invitation-required'; readonly groupId: string; readonly reason: string }

export interface SparkExpenseRecord {
  readonly expenseId: string
  readonly expenseDocument: Readonly<Record<string, unknown>>
  readonly activityId: string
  readonly activityDocument: Readonly<Record<string, unknown>>
  readonly templateId?: string
  readonly templateDocument?: Readonly<Record<string, unknown>>
}

export interface SparkExpenseActivityRecord {
  readonly activityId: string
  readonly activityDocument: Readonly<Record<string, unknown>>
}

export interface SparkExpenseMutationRecord {
  readonly expenseId: string
  readonly headDocument: Readonly<Record<string, unknown>>
  readonly revisionId: string
  readonly revisionDocument: Readonly<Record<string, unknown>> & { readonly expense: Readonly<Record<string, unknown>> }
  readonly activityId: string
  readonly activityDocument: Readonly<Record<string, unknown>>
}

export interface SparkRecurrenceMaterializationRecord {
  readonly occurrenceId: string
  readonly occurrenceDocument: Readonly<Record<string, unknown>>
  readonly templateDocument: Readonly<Record<string, unknown>>
  readonly activityId: string
  readonly activityDocument: Readonly<Record<string, unknown>>
}

export interface SparkCommentRecord {
  readonly commentId: string
  readonly commentDocument: Readonly<Record<string, unknown>>
  readonly activityId: string
  readonly activityDocument: Readonly<Record<string, unknown>>
}

export interface SparkGroupSettingsRecord {
  readonly settingsDocument: Readonly<Record<string, unknown>>
  readonly balanceDocument?: Readonly<Record<string, unknown>>
  readonly activityId: string
  readonly activityDocument: Readonly<Record<string, unknown>>
}

export interface SparkSettlementRecord {
  readonly settlementId: string
  readonly settlementDocument: Readonly<Record<string, unknown>>
  readonly activityId: string
  readonly activityDocument: Readonly<Record<string, unknown>>
}

export interface SparkProfileUpdateRecord {
  readonly profileDocument: Readonly<Record<string, unknown>>
  readonly memberPatch: Readonly<Record<string, unknown>>
}

export interface SparkNotificationReadRecord {
  readonly receiptId: string
  readonly receiptDocument: Readonly<Record<string, unknown>>
}

/** Hashes the full recurrence key so queue operation IDs stay within the 128-character grammar. */
export async function buildSparkMaterializationOperationId(groupId: string, templateId: string, occurrenceDate: string): Promise<string> {
  if (!isStrictId(groupId)) throw new Error('Recurring group ID must be a strict ID')
  recurringOccurrenceId(templateId, occurrenceDate)
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${groupId}\u0000${templateId}\u0000${occurrenceDate}`))
  const hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  return `recurrence-${hash}`
}

/** Builds the single immutable source document authorized by the Spark rules path. */
export function buildSparkExpenseRecord(command: ExpenseAddCommand, actor: ActorSnapshot, identity: OperationIdentity, committedAt: unknown): SparkExpenseRecord {
  const parsed = parseExecuteCommandRequest({ schemaVersion: 1, command }).command
  if (parsed.kind !== 'expense.add') throw new Error('Spark expense command is invalid.')
  const token = assertSparkOperationIdentity(parsed, actor, identity)
  const expenseId = `expense-${token}`
  if (parsed.occurrenceEditScope) throw new Error('Occurrence scope requires an existing recurring expense.')
  if (parsed.recurrence) assertSparkRecurrenceAnchor(parsed.date, parsed.recurrence)
  const templateId = parsed.recurrence ? `recurring-${token}` : undefined
  const expenseDocument: Record<string, unknown> = {
    id: expenseId, groupId: parsed.groupId, operationId: parsed.operationId, requestFingerprint: identity.requestFingerprint, resourceToken: token,
    lastOperationId: parsed.operationId, lastRequestFingerprint: identity.requestFingerprint, lastResourceToken: token,
    ...normalizeSparkExpenseDraft(parsed, identity.resourceId, templateId),
    createdAt: committedAt, createdBy: normalizedActor(actor), updatedAt: committedAt, updatedBy: normalizedActor(actor), revision: 1,
  }
  const normalized = normalizedActor(actor)
  const templateDocument = parsed.recurrence ? {
    id: templateId!, groupId: parsed.groupId, sourceExpenseId: expenseId,
    operationId: parsed.operationId, requestFingerprint: identity.requestFingerprint, resourceToken: token,
    lastOperationId: parsed.operationId, lastRequestFingerprint: identity.requestFingerprint, lastResourceToken: token,
    status: 'active', description: String(expenseDocument.description), total: { ...parsed.total },
    payments: parsed.payments.map(({ participantId, money }) => ({ participantId, money: { ...money } })),
    allocations: parsed.allocations.map(({ participantId, money }) => ({ participantId, money: { ...money } })),
    payerIds: expenseDocument.payerIds, participantIds: expenseDocument.participantIds, involvedMemberIds: expenseDocument.involvedMemberIds,
    category: parsed.category.trim(), splitMethod: structuredClone(expenseDocument.splitMethod), recurrence: structuredClone(parsed.recurrence),
    anchorDate: parsed.date, nextDate: nextOccurrence(parsed.date, parsed.recurrence), revision: 1,
    createdAt: committedAt, createdBy: normalized, updatedAt: committedAt, updatedBy: normalized,
  } : undefined
  return {
    expenseId,
    expenseDocument,
    ...(templateId && templateDocument ? { templateId, templateDocument } : {}),
    ...buildSparkExpenseActivityRecord({
      groupId: parsed.groupId, operationId: parsed.operationId, kind: 'expense.created', actor: normalized,
      expenseId, resourceToken: token, revision: 1, label: String(expenseDocument.description), committedAt,
    }),
  }
}

/** Advances the small mutable head pointer and creates one immutable full expense version. */
export function buildSparkExpenseMutationRecord(
  command: ExpenseEditCommand | ExpenseDeleteCommand,
  head: Readonly<Record<string, unknown>>,
  current: Readonly<Record<string, unknown>>,
  authorization: { readonly actor: ActorSnapshot; readonly canManage: boolean },
  identity: OperationIdentity,
  committedAt: unknown,
): SparkExpenseMutationRecord {
  const parsed = parseExecuteCommandRequest({ schemaVersion: 1, command }).command
  if (parsed.kind !== 'expense.edit' && parsed.kind !== 'expense.delete') throw new Error('Spark expense mutation command is invalid.')
  const token = assertSparkOperationIdentity(parsed, authorization.actor, identity)
  const snapshot = decodeExpense(parsed.groupId, parsed.expenseId, current)
  const rootSnapshot = decodeExpense(parsed.groupId, parsed.expenseId, head)
  const headRevision = Number.isSafeInteger(head.headRevision) ? Number(head.headRevision) : rootSnapshot.revision
  const headDeleted = head.headDeleted === true
  if (snapshot.revision !== headRevision) throw new Error('Expense changed remotely. Reload it before trying again.')
  if (headDeleted) throw new Error('Expense was already deleted.')
  if (snapshot.deletedAt) throw new Error('Expense was already deleted.')
  if (snapshot.revision !== parsed.expectedRevision) throw new Error('Expense changed remotely. Reload it before trying again.')
  const creator = actorFromRecord(head.createdBy, 'createdBy')
  if (creator.id !== authorization.actor.id && !authorization.canManage) throw new Error('Only the expense author or an active group manager can change it.')
  if (head.id !== parsed.expenseId || head.groupId !== parsed.groupId || current.id !== parsed.expenseId || current.groupId !== parsed.groupId) throw new Error('Spark expense document identity is invalid.')
  const creationOperationId = strictInternalString(head.operationId, 'operationId')
  const creationFingerprint = strictHex(head.requestFingerprint, 64, 'request fingerprint')
  const creationToken = strictHex(head.resourceToken, 48, 'resource token')
  const normalized = parsed.kind === 'expense.edit' ? normalizeSparkExpenseDraft(parsed.draft, identity.resourceId, snapshot.recurringTemplateId) : undefined
  const revision = snapshot.revision + 1
  const expense: Record<string, unknown> = parsed.kind === 'expense.edit'
    ? {
        id: parsed.expenseId, groupId: parsed.groupId, operationId: creationOperationId, requestFingerprint: creationFingerprint, resourceToken: creationToken,
        lastOperationId: parsed.operationId, lastRequestFingerprint: identity.requestFingerprint, lastResourceToken: token,
        ...normalized, createdAt: head.createdAt, createdBy: creator, updatedAt: committedAt, updatedBy: normalizedActor(authorization.actor), revision,
      }
    : {
        ...current, lastOperationId: parsed.operationId, lastRequestFingerprint: identity.requestFingerprint, lastResourceToken: token,
        updatedAt: committedAt, updatedBy: normalizedActor(authorization.actor), revision, deletedAt: committedAt,
      }
  const actor = normalizedActor(authorization.actor)
  const activity = buildSparkExpenseActivityRecord({
    groupId: parsed.groupId,
    operationId: parsed.operationId,
    kind: parsed.kind === 'expense.delete' ? 'expense.deleted' : 'expense.updated',
    actor,
    expenseId: parsed.expenseId,
    resourceToken: token,
    revision,
    label: String(expense.description),
    committedAt,
  })
  return {
    expenseId: parsed.expenseId,
    headDocument: {
      ...head,
      lastOperationId: parsed.operationId,
      lastRequestFingerprint: identity.requestFingerprint,
      lastResourceToken: token,
      headRevision: revision,
      headDeleted: parsed.kind === 'expense.delete',
      current: expense,
    },
    revisionId: token,
    revisionDocument: {
      groupId: parsed.groupId, expenseId: parsed.expenseId, revision, operationId: parsed.operationId,
      action: parsed.kind === 'expense.delete' ? 'deleted' : 'updated', actor, createdAt: committedAt, expense,
    },
    ...activity,
  }
}

/** Reconstructs the exact immutable activity event from a committed expense or revision. */
export function buildSparkExpenseActivityRecord(input: {
  readonly groupId: string
  readonly operationId: string
  readonly kind: 'expense.created' | 'expense.updated' | 'expense.deleted'
  readonly actor: ActorSnapshot
  readonly expenseId: string
  readonly resourceToken: string
  readonly revision: number
  readonly label: string
  readonly committedAt: unknown
}): SparkExpenseActivityRecord {
  return {
    activityId: `activity-${input.resourceToken}`,
    activityDocument: {
      groupId: input.groupId, operationId: input.operationId, kind: input.kind,
      subject: { kind: 'expense', id: input.expenseId, label: input.label }, actor: normalizedActor(input.actor),
      expenseId: input.expenseId, resourceToken: input.resourceToken, revision: input.revision, createdAt: input.committedAt,
    },
  }
}

/** Creates one deterministic occurrence and advances its template as one transaction bundle. */
export function buildSparkRecurrenceMaterializationRecord(
  command: RecurrenceMaterializeCommand,
  currentTemplate: Readonly<Record<string, unknown>>,
  actor: ActorSnapshot,
  identity: OperationIdentity,
  committedAt: unknown,
): SparkRecurrenceMaterializationRecord {
  const parsed = command
  if (parsed.kind !== 'recurrence.materialize' || !parsed.groupId.trim()) throw new Error('Spark recurrence materialization command is invalid.')
  recurringOccurrenceId(parsed.templateId, parsed.occurrenceDate)
  const token = assertSparkOperationIdentity(parsed, actor, identity)
  if (currentTemplate.id !== undefined && currentTemplate.id !== parsed.templateId) throw new Error('Recurring template identity is invalid.')
  if (currentTemplate.groupId !== undefined && currentTemplate.groupId !== parsed.groupId) throw new Error('Recurring template group is invalid.')
  const template = decodeRecurringExpense(parsed.groupId, parsed.templateId, currentTemplate)
  if (template.status !== 'active') throw new Error('Recurring template is not active.')
  if (template.nextDate !== parsed.occurrenceDate) throw new Error('Recurring template changed remotely. Reload it before trying again.')
  const occurrenceId = recurringOccurrenceId(parsed.templateId, parsed.occurrenceDate)
  const normalized = normalizeSparkExpenseDraft({
    groupId: parsed.groupId, description: template.description, date: parsed.occurrenceDate,
    total: template.total, payments: template.payments, allocations: template.allocations, category: template.category,
    splitMethod: template.splitMethod, attachmentRefs: [], recurrence: template.recurrence,
  }, identity.resourceId, parsed.templateId)
  const normalizedActorValue = normalizedActor(actor)
  const occurrenceDocument: Readonly<Record<string, unknown>> = {
    id: occurrenceId, groupId: parsed.groupId, operationId: parsed.operationId, requestFingerprint: identity.requestFingerprint, resourceToken: token,
    lastOperationId: parsed.operationId, lastRequestFingerprint: identity.requestFingerprint, lastResourceToken: token,
    ...normalized, createdAt: committedAt, createdBy: normalizedActorValue, updatedAt: committedAt, updatedBy: normalizedActorValue, revision: 1,
  }
  const templateDocument: Readonly<Record<string, unknown>> = {
    ...currentTemplate,
    lastOperationId: parsed.operationId, lastRequestFingerprint: identity.requestFingerprint, lastResourceToken: token,
    nextDate: nextOccurrence(parsed.occurrenceDate, template.recurrence), revision: template.revision + 1,
    lastOccurrenceId: occurrenceId, lastOccurrenceDate: parsed.occurrenceDate, updatedAt: committedAt, updatedBy: normalizedActorValue,
  }
  return {
    occurrenceId,
    occurrenceDocument,
    templateDocument,
    ...buildSparkExpenseActivityRecord({
      groupId: parsed.groupId, operationId: parsed.operationId, kind: 'expense.created', actor: normalizedActorValue,
      expenseId: occurrenceId, resourceToken: token, revision: 1, label: template.description, committedAt,
    }),
  }
}

/** Applies the sole terminal template transition with optimistic revision checking. */
export function buildSparkRecurrenceCancellationRecord(
  command: RecurrenceCancelCommand,
  currentTemplate: Readonly<Record<string, unknown>>,
  actor: ActorSnapshot,
  identity: OperationIdentity,
  committedAt: unknown,
): Readonly<Record<string, unknown>> {
  const parsed = command
  if (parsed.kind !== 'recurrence.cancel' || !parsed.groupId.trim() || !isStrictId(parsed.templateId)
    || !Number.isSafeInteger(parsed.expectedRevision) || parsed.expectedRevision < 1) throw new Error('Spark recurrence cancellation command is invalid.')
  const token = assertSparkOperationIdentity(parsed, actor, identity)
  const template = decodeRecurringExpense(parsed.groupId, parsed.templateId, currentTemplate)
  if (template.status !== 'active') throw new Error('Recurring template is already cancelled.')
  if (template.revision !== parsed.expectedRevision) throw new Error('Recurring template changed remotely. Reload it before trying again.')
  const normalizedActorValue = normalizedActor(actor)
  return {
    ...currentTemplate,
    status: 'cancelled', revision: template.revision + 1,
    lastOperationId: parsed.operationId, lastRequestFingerprint: identity.requestFingerprint, lastResourceToken: token,
    updatedAt: committedAt, updatedBy: normalizedActorValue,
  }
}

/** Replaces the active template snapshot only when editing the current series frontier. */
export function buildSparkFutureRecurringTemplateRecord(
  command: ExpenseEditCommand,
  currentExpense: Pick<ExpenseRow, 'id' | 'recurringTemplateId'>,
  currentTemplate: Readonly<Record<string, unknown>>,
  actor: ActorSnapshot,
  identity: OperationIdentity,
  committedAt: unknown,
): Readonly<Record<string, unknown>> {
  const parsed = parseExecuteCommandRequest({ schemaVersion: 1, command }).command
  if (parsed.kind !== 'expense.edit' || parsed.draft.occurrenceEditScope !== 'future' || !parsed.draft.recurrence) {
    throw new Error('Spark future recurrence edit command is invalid.')
  }
  const token = assertSparkOperationIdentity(parsed, actor, identity)
  const template = decodeRecurringExpense(parsed.groupId, currentExpense.recurringTemplateId ?? '', currentTemplate)
  if (!currentExpense.recurringTemplateId || currentExpense.recurringTemplateId !== template.id) throw new Error('Expense is not linked to this recurring template.')
  if (template.status !== 'active') throw new Error('Recurring template is not active.')
  const sourceExpenseId = typeof currentTemplate.sourceExpenseId === 'string' ? currentTemplate.sourceExpenseId : undefined
  const latestExpenseId = template.lastOccurrenceId ?? sourceExpenseId
  if (!latestExpenseId || currentExpense.id !== latestExpenseId || parsed.expenseId !== currentExpense.id) {
    throw new Error('Only the latest recurring occurrence can update future expenses.')
  }
  assertSparkRecurrenceAnchor(parsed.draft.date, parsed.draft.recurrence)
  const normalized = normalizeSparkExpenseDraft(parsed.draft, identity.resourceId, template.id)
  const normalizedActorValue = normalizedActor(actor)
  return {
    ...currentTemplate,
    description: normalized.description, total: { ...parsed.draft.total },
    payments: parsed.draft.payments.map(({ participantId, money }) => ({ participantId, money: { ...money } })),
    allocations: parsed.draft.allocations.map(({ participantId, money }) => ({ participantId, money: { ...money } })),
    payerIds: normalized.payerIds, participantIds: normalized.participantIds, involvedMemberIds: normalized.involvedMemberIds,
    category: normalized.category, splitMethod: structuredClone(normalized.splitMethod), recurrence: structuredClone(parsed.draft.recurrence),
    anchorDate: parsed.draft.date, nextDate: nextOccurrence(parsed.draft.date, parsed.draft.recurrence), revision: template.revision + 1,
    lastOperationId: parsed.operationId, lastRequestFingerprint: identity.requestFingerprint, lastResourceToken: token,
    updatedAt: committedAt, updatedBy: normalizedActorValue,
  }
}

/** Builds one immutable comment and its equally immutable group activity event. */
export function buildSparkCommentRecord(command: CommentAddCommand, actor: ActorSnapshot, identity: OperationIdentity, committedAt: unknown): SparkCommentRecord {
  const parsed = parseExecuteCommandRequest({ schemaVersion: 1, command }).command
  if (parsed.kind !== 'comment.add') throw new Error('Spark comment command is invalid.')
  const token = assertSparkOperationIdentity(parsed, actor, identity)
  if (parsed.attachmentRefs.length) throw new Error('Spark comment attachments require the secure cloud asset service.')
  const normalizedAuthor = normalizedActor(actor)
  const body = parsed.body.trim()
  const commentId = `comment-${token}`
  const activityId = `activity-${token}`
  return {
    commentId,
    commentDocument: {
      groupId: parsed.groupId, expenseId: parsed.expenseId, operationId: parsed.operationId,
      requestFingerprint: identity.requestFingerprint, resourceToken: token,
      lastOperationId: parsed.operationId, lastRequestFingerprint: identity.requestFingerprint, lastResourceToken: token,
      author: normalizedAuthor, body, attachmentRefs: [], createdAt: committedAt,
    },
    activityId,
    activityDocument: sparkCommentActivity(parsed.groupId, parsed.operationId, 'comment.added', normalizedAuthor, parsed.expenseId, commentId, body, committedAt),
  }
}

/** Builds the sole author-owned comment transition: an immutable-body soft delete plus activity. */
export function buildSparkCommentDeleteRecord(command: CommentDeleteCommand, current: Readonly<Record<string, unknown>>, actor: ActorSnapshot, identity: OperationIdentity, committedAt: unknown): SparkCommentRecord {
  const parsed = parseExecuteCommandRequest({ schemaVersion: 1, command }).command
  if (parsed.kind !== 'comment.delete') throw new Error('Spark comment delete command is invalid.')
  const token = assertSparkOperationIdentity(parsed, actor, identity)
  if (current.deletedAt !== undefined) throw new Error('Comment is already deleted.')
  if (current.groupId !== parsed.groupId || current.expenseId !== parsed.expenseId) throw new Error('Spark comment document identity is invalid.')
  const creationToken = strictHex(current.resourceToken, 48, 'comment resource token')
  if (parsed.commentId !== `comment-${creationToken}`) throw new Error('Spark comment document identity is invalid.')
  strictInternalString(current.operationId, 'comment operation ID')
  strictHex(current.requestFingerprint, 64, 'comment request fingerprint')
  const author = actorFromRecord(current.author, 'comment author')
  const normalizedCurrentActor = normalizedActor(actor)
  if (author.id !== normalizedCurrentActor.id) throw new Error('Only the comment author may delete it.')
  const body = strictInternalString(current.body, 'comment body')
  if (!Array.isArray(current.attachmentRefs) || current.attachmentRefs.length) throw new Error('Spark comment attachments require the secure cloud asset service.')
  const activityId = `activity-${token}`
  return {
    commentId: parsed.commentId,
    commentDocument: {
      ...current,
      lastOperationId: parsed.operationId,
      lastRequestFingerprint: identity.requestFingerprint,
      lastResourceToken: token,
      deletedAt: committedAt,
    },
    activityId,
    activityDocument: sparkCommentActivity(parsed.groupId, parsed.operationId, 'comment.deleted', normalizedCurrentActor, parsed.expenseId, parsed.commentId, body, committedAt),
  }
}

/** Builds a confirmed participant-owned settlement and its immutable activity event. */
export function buildSparkSettlementRecord(command: SettlementRecordCommand, actor: ActorSnapshot, identity: OperationIdentity, committedAt: unknown): SparkSettlementRecord {
  const parsed = parseExecuteCommandRequest({ schemaVersion: 1, command }).command
  if (parsed.kind !== 'settlement.record') throw new Error('Spark settlement command is invalid.')
  const token = assertSparkOperationIdentity(parsed, actor, identity)
  const normalizedActor = normalizedActorSnapshot(actor)
  if (normalizedActor.id !== parsed.basis.senderId && normalizedActor.id !== parsed.basis.recipientId) throw new Error('Only a settlement participant can record the payment.')
  const settlementId = `settlement-${token}`
  const note = parsed.note?.replace(/\s+/g, ' ').trim()
  return {
    settlementId,
    settlementDocument: {
      settlementId, groupId: parsed.groupId, operationId: parsed.operationId,
      requestFingerprint: identity.requestFingerprint, resourceToken: token,
      lastOperationId: parsed.operationId, lastRequestFingerprint: identity.requestFingerprint, lastResourceToken: token,
      senderId: parsed.basis.senderId, recipientId: parsed.basis.recipientId, money: parsed.money, basis: parsed.basis,
      method: parsed.method, occurredOn: parsed.occurredOn, ...(note ? { note } : {}), outsidePaymentConfirmed: true,
      createdBy: normalizedActor, createdAt: committedAt, revision: 1,
    },
    activityId: `activity-${token}`,
    activityDocument: sparkSettlementActivity(parsed.groupId, parsed.operationId, 'settlement.created', normalizedActor, settlementId, 'Payment recorded', committedAt),
  }
}

/** Builds the sole mutable settlement transition: an authorized revision-two void. */
export function buildSparkSettlementVoidRecord(
  command: SettlementVoidCommand,
  current: Readonly<Record<string, unknown>>,
  authorization: { readonly actor: ActorSnapshot; readonly canManage: boolean },
  identity: OperationIdentity,
  committedAt: unknown,
): SparkSettlementRecord {
  const parsed = parseExecuteCommandRequest({ schemaVersion: 1, command }).command
  if (parsed.kind !== 'settlement.void') throw new Error('Spark settlement void command is invalid.')
  const token = assertSparkOperationIdentity(parsed, authorization.actor, identity)
  const snapshot = decodeSettlement(parsed.groupId, parsed.settlementId, current)
  if (snapshot.revision !== parsed.expectedRevision || snapshot.void) throw new Error('Settlement changed remotely. Reload it before trying again.')
  if (snapshot.createdBy.id !== authorization.actor.id && !authorization.canManage) throw new Error('Only the settlement author or an active group manager can void it.')
  const actor = normalizedActorSnapshot(authorization.actor)
  return {
    settlementId: parsed.settlementId,
    settlementDocument: {
      ...current, lastOperationId: parsed.operationId, lastRequestFingerprint: identity.requestFingerprint, lastResourceToken: token,
      revision: 2, void: { operationId: parsed.operationId, reason: parsed.reason.trim(), actor, createdAt: committedAt, revision: 2 },
    },
    activityId: `activity-${token}`,
    activityDocument: sparkSettlementActivity(parsed.groupId, parsed.operationId, 'settlement.voided', actor, parsed.settlementId, 'Payment voided', committedAt),
  }
}

/** Versions one shared group setting and binds it to immutable activity. */
export function buildSparkGroupSettingsRecord(
  command: GroupDefaultSplitCommand | GroupSimplifyDebtsCommand,
  current: Readonly<Record<string, unknown>>,
  currentBalance: Readonly<Record<string, unknown>> | undefined,
  members: readonly Member[],
  actor: ActorSnapshot,
  identity: OperationIdentity,
  committedAt: unknown,
): SparkGroupSettingsRecord {
  const parsed = parseExecuteCommandRequest({ schemaVersion: 1, command }).command
  if (parsed.kind !== 'group.default-split' && parsed.kind !== 'group.simplify-debts') throw new Error('Spark group settings command is invalid.')
  const token = assertSparkOperationIdentity(parsed, actor, identity)
  const normalizedCurrentActor = normalizedActor(actor)
  const actorMember = members.find(({ id }) => id === actor.id)
  if (!actorMember || actorMember.displayName !== normalizedCurrentActor.displayName) throw new Error('Only an active group member can change group settings.')
  const currentSettings = decodeSparkGroupSettings(parsed.groupId, current)
  const updated = parsed.kind === 'group.default-split'
    ? updateGroupSettings(currentSettings, { expectedRevision: parsed.expectedRevision, defaultSplit: parsed.defaultSplit }, members, actor.id)
    : updateGroupSettings(currentSettings, { expectedRevision: parsed.expectedRevision, simplifyDebtsEnabled: parsed.simplifyDebtsEnabled }, members, actor.id)
  if (updated.defaultSplit && updated.defaultSplit.participantIds.length > 6) throw new Error('Spark default splits currently support at most six active members.')
  const label = parsed.kind === 'group.default-split'
    ? parsed.defaultSplit ? 'Default split updated' : 'Default split cleared'
    : `Simplify debts ${parsed.simplifyDebtsEnabled ? 'enabled' : 'disabled'}`
  const activityId = `activity-${token}`
  const settingsDocument: Record<string, unknown> = {
    schemaVersion: 1, groupId: parsed.groupId, revision: updated.revision,
    ...(updated.defaultSplit ? { defaultSplit: updated.defaultSplit } : {}),
    ...(updated.simplifyDebtsEnabled !== undefined ? { simplifyDebtsEnabled: updated.simplifyDebtsEnabled } : {}),
    lastCommandKind: parsed.kind, lastOperationId: parsed.operationId,
    lastRequestFingerprint: identity.requestFingerprint, lastResourceToken: token,
    updatedAt: committedAt, updatedBy: normalizedCurrentActor,
  }
  const base: SparkGroupSettingsRecord = {
    settingsDocument,
    activityId,
    activityDocument: {
      groupId: parsed.groupId, operationId: parsed.operationId, kind: 'group.event',
      subject: { kind: 'group', id: parsed.groupId, label }, actor: normalizedCurrentActor, createdAt: committedAt,
    },
  }
  if (parsed.kind === 'group.default-split') return base
  const balance = decodeSparkSettingsBalance(parsed.groupId, currentSettings, currentBalance)
  return {
    ...base,
    balanceDocument: {
      groupId: parsed.groupId, balanceRevision: balance.balanceRevision + 1,
      simplifyDebtsEnabled: parsed.simplifyDebtsEnabled, pairwise: balance.pairwise, simplified: balance.simplified,
    },
  }
}

/** Versions the private profile and emits the exact public membership snapshot patch. */
export function buildSparkProfileUpdateRecord(
  command: ProfileUpdateCommand,
  current: Readonly<Record<string, unknown>>,
  identity: OperationIdentity,
  committedAt: unknown,
): SparkProfileUpdateRecord {
  const parsed = parseExecuteCommandRequest({ schemaVersion: 1, command }).command
  if (parsed.kind !== 'profile.update') throw new Error('Spark profile command is invalid.')
  const token = assertSparkPrivateOperationIdentity(parsed, identity)
  const profile = requireProfile(current)
  if (current.createdAt === undefined) throw new Error('Stored Firebase profile is invalid.')
  const displayName = normalizeDisplayName(parsed.displayName)
  const initials = parsed.initials?.trim() ?? profileInitials(displayName)
  const memberPatch = { displayName, initials, avatarUrl: profile.avatarUrl }
  return {
    profileDocument: {
      ...memberPatch, createdAt: current.createdAt, updatedAt: committedAt,
      lastCommandKind: parsed.kind, lastOperationId: parsed.operationId,
      lastRequestFingerprint: identity.requestFingerprint, lastResourceToken: token,
    },
    memberPatch,
  }
}

/** Creates or advances the private notification-preference revision. */
export function buildSparkNotificationPreferencesRecord(
  command: NotificationPreferencesCommand,
  current: Readonly<Record<string, unknown>> | undefined,
  identity: OperationIdentity,
  committedAt: unknown,
): Readonly<Record<string, unknown>> {
  const parsed = parseExecuteCommandRequest({ schemaVersion: 1, command }).command
  if (parsed.kind !== 'notification.preferences') throw new Error('Spark notification preferences command is invalid.')
  const token = assertSparkPrivateOperationIdentity(parsed, identity)
  const revision = current === undefined ? 0 : sparkPrivateSettingsRevision(current)
  if (revision >= Number.MAX_SAFE_INTEGER) throw new Error('Notification preferences revision cannot advance safely.')
  return {
    schemaVersion: 1, revision: revision + 1, ...parsed.preferences,
    lastCommandKind: parsed.kind, lastOperationId: parsed.operationId,
    lastRequestFingerprint: identity.requestFingerprint, lastResourceToken: token,
    updatedAt: committedAt,
  }
}

/** Persists private read state for one activity-derived in-app notification. */
export function buildSparkNotificationReadRecord(
  command: NotificationReadCommand,
  notification: NotificationItem,
  identity: OperationIdentity,
  committedAt: unknown,
): SparkNotificationReadRecord {
  const parsed = parseExecuteCommandRequest({ schemaVersion: 1, command }).command
  if (parsed.kind !== 'notification.read') throw new Error('Spark notification read command is invalid.')
  const token = assertSparkPrivateOperationIdentity(parsed, identity)
  if (notification.principalId !== identity.userId || notification.notificationId !== parsed.notificationId
    || notification.activityId !== parsed.notificationId || notification.actor.id === identity.userId
    || !isStrictId(notification.groupId) || !isStrictId(notification.notificationId)) throw new Error('Spark notification identity is invalid.')
  return {
    receiptId: notification.notificationId,
    receiptDocument: {
      schemaVersion: 1, notificationId: notification.notificationId, groupId: notification.groupId,
      activityId: notification.activityId, sourceCreatedAt: notification.createdAt, readAt: committedAt,
      operationId: parsed.operationId, requestFingerprint: identity.requestFingerprint, resourceToken: token,
    },
  }
}

/** Creates or monotonically advances the private inclusive read-all cursor. */
export function buildSparkNotificationReadAllRecord(
  command: NotificationReadAllCommand,
  current: Readonly<Record<string, unknown>> | undefined,
  identity: OperationIdentity,
  committedAt: unknown,
  readNotificationIds: readonly string[],
): Readonly<Record<string, unknown>> {
  const parsed = parseExecuteCommandRequest({ schemaVersion: 1, command }).command
  if (parsed.kind !== 'notification.read-all') throw new Error('Spark notification read-all command is invalid.')
  const token = assertSparkPrivateOperationIdentity(parsed, identity)
  const revision = current === undefined ? 0 : sparkNotificationReadCursorRevision(current)
  if (revision >= Number.MAX_SAFE_INTEGER) throw new Error('Notification read cursor revision cannot advance safely.')
  if (readNotificationIds.length > 100 || new Set(readNotificationIds).size !== readNotificationIds.length
    || readNotificationIds.some((notificationId) => !isStrictId(notificationId))) throw new Error('Notification read cursor IDs are invalid.')
  if (current && compareTimelineAscending(parsed.cutoff, { createdAt: String(current.cutoffCreatedAt), id: String(current.cutoffId) }) < 0) {
    throw new Error('Notification read cursor cannot move backward.')
  }
  return {
    schemaVersion: 1, revision: revision + 1,
    cutoffCreatedAt: parsed.cutoff.createdAt, cutoffId: parsed.cutoff.id, updatedAt: committedAt,
    readNotificationIds: [...readNotificationIds],
    lastCommandKind: parsed.kind, lastOperationId: parsed.operationId,
    lastRequestFingerprint: identity.requestFingerprint, lastResourceToken: token,
  }
}

function sparkCommentActivity(groupId: string, operationId: string, kind: 'comment.added' | 'comment.deleted', actor: ActorSnapshot, expenseId: string, commentId: string, label: string, createdAt: unknown): Readonly<Record<string, unknown>> {
  return { groupId, operationId, kind, subject: { kind: 'comment', id: commentId, label }, actor, expenseId, commentId, createdAt }
}

function sparkSettlementActivity(groupId: string, operationId: string, kind: 'settlement.created' | 'settlement.voided', actor: ActorSnapshot, settlementId: string, label: string, createdAt: unknown): Readonly<Record<string, unknown>> {
  return { groupId, operationId, kind, subject: { kind: 'settlement', id: settlementId, label }, actor, settlementId, createdAt }
}

function decodeSparkGroupSettings(groupId: string, value: Readonly<Record<string, unknown>>): GroupSettings {
  if (value.schemaVersion !== 1 || value.groupId !== groupId || !Number.isSafeInteger(value.revision) || Number(value.revision) < 1) throw new Error('Stored group settings are invalid.')
  if (value.simplifyDebtsEnabled !== undefined && typeof value.simplifyDebtsEnabled !== 'boolean') throw new Error('Stored group settings are invalid.')
  let defaultSplit: GroupSettings['defaultSplit']
  if (value.defaultSplit !== undefined) {
    try { defaultSplit = decodeDefaultSplit(value.defaultSplit) } catch { throw new Error('Stored group settings are invalid.') }
  }
  return {
    schemaVersion: 1, groupId, revision: Number(value.revision),
    ...(defaultSplit ? { defaultSplit } : {}),
    ...(value.simplifyDebtsEnabled !== undefined ? { simplifyDebtsEnabled: value.simplifyDebtsEnabled } : {}),
  }
}

function decodeSparkSettingsBalance(groupId: string, settings: GroupSettings, value: Readonly<Record<string, unknown>> | undefined): { readonly balanceRevision: number; readonly pairwise: readonly unknown[]; readonly simplified: readonly unknown[] } {
  if (!value || value.groupId !== groupId || !Number.isSafeInteger(value.balanceRevision) || Number(value.balanceRevision) < 0 || Number(value.balanceRevision) >= Number.MAX_SAFE_INTEGER
    || typeof value.simplifyDebtsEnabled !== 'boolean' || value.simplifyDebtsEnabled !== (settings.simplifyDebtsEnabled !== false)
    || !Array.isArray(value.pairwise) || !Array.isArray(value.simplified)) throw new Error('Stored group balance is invalid.')
  return { balanceRevision: Number(value.balanceRevision), pairwise: value.pairwise, simplified: value.simplified }
}

function normalizeSparkExpenseDraft(draft: ExpenseDraft, resourceId: string, recurringTemplateId?: string): Readonly<Record<string, unknown>> {
  if (draft.attachmentRefs.length) throw new Error('Spark expense attachments require the secure cloud asset service.')
  if ((draft.recurrence || draft.occurrenceEditScope) && !recurringTemplateId) throw new Error('Recurrence requires a linked recurring expense.')
  validateLedgerExpense({ id: resourceId, total: draft.total, payments: draft.payments, allocations: draft.allocations })
  assertSplitMatchesAllocations(draft.total, draft.splitMethod, draft.allocations)
  const payerIds = draft.payments.map(({ participantId }) => participantId)
  const participantIds = draft.allocations.map(({ participantId }) => participantId)
  const involvedMemberIds = [...new Set([...payerIds, ...participantIds])].sort((left, right) => left.localeCompare(right))
  if (involvedMemberIds.length > 6) throw new Error('Spark expenses currently support at most six involved members.')
  const exactAllocations = draft.allocations.map(({ participantId, money }) => ({ participantId, money: { ...money } }))
  const notes = draft.notes?.replace(/\s+/g, ' ').trim()
  return {
    description: draft.description.replace(/\s+/g, ' ').trim(), date: draft.date, total: { ...draft.total },
    payments: draft.payments.map(({ participantId, money }) => ({ participantId, money: { ...money } })), allocations: exactAllocations,
    payerIds, participantIds, involvedMemberIds, category: draft.category.trim(), splitType: draft.splitMethod.type,
    splitMethod: { type: 'exact', allocations: exactAllocations }, attachmentRefs: [], ...(notes ? { notes } : {}),
    ...(draft.recurrence ? { recurrence: structuredClone(draft.recurrence) } : {}),
    ...(draft.occurrenceEditScope ? { occurrenceEditScope: draft.occurrenceEditScope } : {}),
    ...(recurringTemplateId ? { recurringTemplateId } : {}),
  }
}

function assertSparkRecurrenceAnchor(date: string, recurrence: NonNullable<ExpenseDraft['recurrence']>): void {
  const anchor = `${String(recurrence.anchor.month).padStart(2, '0')}-${String(recurrence.anchor.day).padStart(2, '0')}`
  if (date.slice(5) !== anchor) throw new Error('Recurring expense date must match its recurrence anchor.')
}

function assertSparkOperationIdentity(command: { readonly kind: string; readonly operationId: string; readonly groupId: string }, actor: ActorSnapshot, identity: OperationIdentity): string {
  if (identity.userId !== actor.id || identity.operationId !== command.operationId || identity.kind !== command.kind || identity.groupId !== command.groupId) throw new Error('Spark expense operation identity does not match the command.')
  if (!/^[a-f0-9]{64}$/.test(identity.requestFingerprint)) throw new Error('Spark expense request fingerprint is invalid.')
  const token = /^operation-([a-f0-9]{48})$/.exec(identity.resourceId)?.[1]
  if (!token) throw new Error('Spark expense resource identity is invalid.')
  normalizedActor(actor)
  return token
}

function assertSparkPrivateOperationIdentity(command: { readonly kind: string; readonly operationId: string }, identity: OperationIdentity): string {
  if (!identity.userId.trim() || identity.operationId !== command.operationId || identity.kind !== command.kind || identity.groupId !== null) throw new Error('Spark private operation identity does not match the command.')
  if (!/^[a-f0-9]{64}$/.test(identity.requestFingerprint)) throw new Error('Spark private request fingerprint is invalid.')
  const token = /^operation-([a-f0-9]{48})$/.exec(identity.resourceId)?.[1]
  if (!token) throw new Error('Spark private resource identity is invalid.')
  return token
}

function sparkPrivateSettingsRevision(value: Readonly<Record<string, unknown>>): number {
  if (value.schemaVersion !== 1 || !Number.isSafeInteger(value.revision) || Number(value.revision) < 1
    || typeof value.emailEnabled !== 'boolean' || typeof value.pushEnabled !== 'boolean') throw new Error('Stored notification preferences are invalid.')
  return Number(value.revision)
}

function sparkNotificationReadCursorRevision(value: Readonly<Record<string, unknown>>): number {
  if (value.schemaVersion !== 1 || !Number.isSafeInteger(value.revision) || Number(value.revision) < 1
    || typeof value.cutoffCreatedAt !== 'string' || Number.isNaN(Date.parse(value.cutoffCreatedAt))
    || typeof value.cutoffId !== 'string' || !isStrictId(value.cutoffId)) throw new Error('Stored notification read cursor is invalid.')
  return Number(value.revision)
}

function normalizedActor(actor: ActorSnapshot): ActorSnapshot {
  const displayName = actor.displayName.trim()
  if (!actor.id.trim() || !displayName || displayName.length > 120) throw new Error('Spark expense actor is invalid.')
  return { id: actor.id, displayName }
}

function normalizedActorSnapshot(actor: ActorSnapshot): ActorSnapshot { return normalizedActor(actor) }

function actorFromRecord(value: unknown, label: string): ActorSnapshot {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.displayName !== 'string') throw new Error(`Spark expense ${label} is invalid.`)
  return normalizedActor({ id: value.id, displayName: value.displayName })
}

function strictInternalString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Spark expense ${label} is invalid.`)
  return value
}

function strictHex(value: unknown, length: number, label: string): string {
  const text = strictInternalString(value, label)
  if (!new RegExp(`^[a-f0-9]{${length}}$`).test(text)) throw new Error(`Spark expense ${label} is invalid.`)
  return text
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function buildFirebaseProfile(identity: FirebaseIdentity): FirebaseProfileDocument {
  const fallback = identity.email?.split('@')[0] ?? 'Split Unwise member'
  const displayName = normalizeDisplayName(identity.displayName ?? fallback)
  const initials = profileInitials(displayName)
  return { displayName, initials, avatarUrl: safeAvatarUrl(identity.photoURL) }
}

function profileInitials(displayName: string): string {
  return displayName.split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? '').join('').slice(0, 4) || 'SU'
}

export function normalizeSparkGroup(input: { readonly operationId: string; readonly kind?: ExpenseContextKind; readonly name: string; readonly currency: string }): { readonly groupId: string; readonly kind: ExpenseContextKind; readonly name: string; readonly currency: string } {
  if (!isStrictId(input.operationId)) throw new Error('Group operation ID is invalid.')
  const groupId = `grp-${input.operationId}`
  if (!isStrictId(groupId)) throw new Error('Group operation ID is too long.')
  const name = input.name.trim().replace(/\s+/g, ' ')
  if (!name || name.length > 120) throw new Error('Group name must be between 1 and 120 characters.')
  const kind = input.kind ?? 'group'
  if (kind !== 'group' && kind !== 'friendship') throw new Error('Expense context kind is invalid.')
  const currency = input.currency.trim().toUpperCase()
  try { assertCurrencyCode(currency) } catch { throw new Error('Choose a supported group currency.') }
  return { groupId, kind, name, currency }
}

export async function buildSparkInvitation(input: { readonly groupId: string; readonly canonicalOrigin: string; readonly targetEmail?: string; readonly now?: Date; readonly random?: (bytes: Uint8Array) => void }): Promise<PreparedInvitation & { readonly secret: string }> {
  if (!isStrictId(input.groupId)) throw new Error('Group ID is invalid.')
  const origin = canonicalHttpsOrigin(input.canonicalOrigin)
  const now = input.now ?? new Date()
  if (!Number.isFinite(now.getTime())) throw new Error('Invitation time is invalid.')
  const secret = generateInvitationSecret(input.random)
  const invitationId = await hashInvitationSecret(secret)
  const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString()
  const targetEmail = input.targetEmail ? normalizeEmail(input.targetEmail) : undefined
  return {
    invitationId, groupId: input.groupId, secret, expiresAt, capability: 'firebase-client',
    link: `${origin}/invite/join#token=${secret}`,
    ...(targetEmail ? { targetEmail } : {}),
  }
}

export async function bootstrapFirebaseProfile(configuration: FirebaseConfiguration, identity?: FirebaseIdentity): Promise<'created' | 'ready'> {
  const app = await getSplitUnwiseFirebaseApp(configuration)
  const user = authenticatedUser(app, identity)
  const profile = buildFirebaseProfile(user)
  const db = getFirestore(app)
  const reference = doc(db, `users/${user.uid}`)
  if ((await getDoc(reference)).exists()) return 'ready'
  return runTransaction(db, async (transaction) => {
    const existing = await transaction.get(reference)
    if (existing.exists()) return 'ready'
    transaction.set(reference, { ...profile, createdAt: serverTimestamp(), updatedAt: serverTimestamp() })
    return 'created'
  })
}

export async function synchronizeFirebaseProfile(configuration: FirebaseConfiguration, identity?: FirebaseIdentity): Promise<void> {
  const app = await getSplitUnwiseFirebaseApp(configuration)
  const user = authenticatedUser(app, identity)
  const profile = buildFirebaseProfile(user)
  const command: ProfileUpdateCommand = {
    kind: 'profile.update', operationId: await firebaseProfileSyncOperationId(user.uid, profile),
    displayName: profile.displayName, initials: profile.initials,
  }
  const operationIdentity = await createOperationIdentity(user.uid, command)
  const db = getFirestore(app)
  await runTransaction(db, async (transaction) => {
    const reference = doc(db, `users/${user.uid}`)
    const existing = await transaction.get(reference)
    if (!existing.exists()) {
      transaction.set(reference, { ...profile, createdAt: serverTimestamp(), updatedAt: serverTimestamp() })
      return
    }
    const data = existing.data()
    if (data.displayName !== profile.displayName || data.initials !== profile.initials) {
      transaction.set(reference, buildSparkProfileUpdateRecord(command, data, operationIdentity, serverTimestamp()).profileDocument)
    }
  })
}

async function firebaseProfileSyncOperationId(uid: string, profile: FirebaseProfileDocument): Promise<string> {
  const bytes = new TextEncoder().encode(`${uid}\u0000${profile.displayName}\u0000${profile.initials}`)
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  const token = [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('').slice(0, 32)
  return `auth-profile-${token}`
}

export async function createSparkGroup(configuration: FirebaseConfiguration, input: { readonly operationId: string; readonly kind?: ExpenseContextKind; readonly name: string; readonly currency: string }): Promise<{ readonly groupId: string }> {
  const normalized = normalizeSparkGroup(input)
  const app = await getSplitUnwiseFirebaseApp(configuration)
  const auth = getAuth(app)
  const user = auth.currentUser
  if (!user) throw new Error('Sign in before creating a group.')
  const db = getFirestore(app)
  const profileSnapshot = await getDoc(doc(db, `users/${user.uid}`))
  if (!profileSnapshot.exists()) throw new Error('Your profile is still being prepared. Try again.')
  const profile = requireProfile(profileSnapshot.data())
  const batch = writeBatch(db)
  batch.set(doc(db, `groups/${normalized.groupId}`), {
    id: normalized.groupId, kind: normalized.kind, name: normalized.name, currency: normalized.currency, memberIds: [user.uid], createdByUid: user.uid,
    createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
  })
  batch.set(doc(db, `groups/${normalized.groupId}/members/${user.uid}`), {
    status: 'active', role: 'owner', canManage: true, ...profile, joinedAt: serverTimestamp(),
  })
  batch.set(doc(db, `groups/${normalized.groupId}/settings/defaults`), {
    schemaVersion: 1, groupId: normalized.groupId, revision: 1, simplifyDebtsEnabled: true, updatedAt: serverTimestamp(),
  })
  batch.set(doc(db, `groups/${normalized.groupId}/balance/current`), {
    groupId: normalized.groupId, balanceRevision: 0, simplifyDebtsEnabled: true, pairwise: [], simplified: [],
  })
  batch.set(doc(db, `users/${user.uid}/groups/${normalized.groupId}`), {
    groupId: normalized.groupId, status: 'active', contextLabel: normalized.name, joinedAt: serverTimestamp(), updatedAt: serverTimestamp(),
  })
  await batch.commit()
  return { groupId: normalized.groupId }
}

export async function createSparkFriendship(configuration: FirebaseConfiguration, input: {
  readonly operationId: string
  readonly displayName: string
  readonly email: string
  readonly currency: string
  readonly canonicalOrigin: string
}): Promise<SparkFriendshipCreationResult> {
  const targetEmail = normalizeEmail(input.email)
  const app = await getSplitUnwiseFirebaseApp(configuration)
  const user = getAuth(app).currentUser
  if (!user) throw new Error('Sign in before adding a friend.')
  if (user.email?.trim().toLowerCase() === targetEmail) throw new Error('Use your friend’s email, not your own.')
  const { groupId } = await createSparkGroup(configuration, {
    operationId: input.operationId, kind: 'friendship', name: input.displayName, currency: input.currency,
  })
  try {
    const invitation = await createSparkInvitation(configuration, { groupId, canonicalOrigin: input.canonicalOrigin, targetEmail })
    return { status: 'ready', groupId, invitation }
  } catch (reason) {
    return { status: 'invitation-required', groupId, reason: reason instanceof Error ? reason.message : 'The invitation could not be prepared.' }
  }
}

export async function createSparkInvitation(configuration: FirebaseConfiguration, input: { readonly groupId: string; readonly canonicalOrigin: string; readonly targetEmail?: string }): Promise<PreparedInvitation> {
  const prepared = await buildSparkInvitation(input)
  const app = await getSplitUnwiseFirebaseApp(configuration)
  const auth = getAuth(app)
  const user = auth.currentUser
  if (!user) throw new Error('Sign in before inviting people.')
  const db = getFirestore(app)
  const [group, profile] = await Promise.all([
    getDoc(doc(db, `groups/${input.groupId}`)),
    getDoc(doc(db, `users/${user.uid}`)),
  ])
  if (!group.exists()) throw new Error('This group is not available.')
  if (!profile.exists()) throw new Error('Your profile is still being prepared. Try again.')
  await writeInvitation(db, prepared, user.uid, group.data().kind === 'friendship' ? 'friendship' : 'group', String(group.data().name ?? 'Group'), requireProfile(profile.data()).displayName)
  const { secret: _secret, ...publicInvitation } = prepared
  return publicInvitation
}

export async function inspectSparkInvitation(configuration: FirebaseConfiguration, invitationId: string, secret: string): Promise<SparkInvitationPreview> {
  await requireMatchingCapability(invitationId, secret)
  const app = await getSplitUnwiseFirebaseApp(configuration)
  const auth = getAuth(app)
  const user = auth.currentUser
  if (!user) throw new Error('Sign in to inspect this invitation.')
  const db = getFirestore(app)
  const invitation = await getDoc(doc(db, `invitations/${invitationId}`))
  if (!invitation.exists()) throw new Error('Invitation was not found.')
  const data = invitation.data()
  validateInvitation(data, user)
  const projection = await getDoc(doc(db, `users/${user.uid}/groups/${String(data.groupId)}`))
  return { groupId: String(data.groupId), groupName: String(data.groupName), alreadyMember: projection.data()?.status === 'active' }
}

export async function acceptSparkInvitation(configuration: FirebaseConfiguration, invitationId: string, secret: string): Promise<{ readonly groupId: string }> {
  await requireMatchingCapability(invitationId, secret)
  const app = await getSplitUnwiseFirebaseApp(configuration)
  const auth = getAuth(app)
  const user = auth.currentUser
  if (!user) throw new Error('Sign in before joining this group.')
  const db = getFirestore(app)
  const invitationReference = doc(db, `invitations/${invitationId}`)
  const invitation = await getDoc(invitationReference)
  if (!invitation.exists()) throw new Error('Invitation was not found.')
  const data = invitation.data()
  validateInvitation(data, user)
  const groupId = String(data.groupId)
  const [profileSnapshot, projection] = await Promise.all([
    getDoc(doc(db, `users/${user.uid}`)),
    getDoc(doc(db, `users/${user.uid}/groups/${groupId}`)),
  ])
  if (projection.data()?.status === 'active') return { groupId }
  if (!profileSnapshot.exists()) throw new Error('Your profile is still being prepared. Try again.')
  if (data.groupKind === 'friendship' && typeof data.createdByName !== 'string') throw new Error('This friend invitation is invalid.')
  const profile = requireProfile(profileSnapshot.data())
  const batch = writeBatch(db)
  batch.update(invitationReference, { status: 'used', usedByUid: user.uid, usedAt: serverTimestamp(), updatedAt: serverTimestamp() })
  batch.update(doc(db, `groups/${groupId}`), { memberIds: arrayUnion(user.uid), updatedAt: serverTimestamp() })
  batch.set(doc(db, `groups/${groupId}/members/${user.uid}`), {
    status: 'active', role: 'member', canManage: false, ...profile, invitationId, joinedAt: serverTimestamp(),
  })
  batch.set(doc(db, `users/${user.uid}/groups/${groupId}`), {
    groupId, status: 'active', invitationId,
    contextLabel: String(data.groupKind === 'friendship' ? data.createdByName : data.groupName),
    joinedAt: serverTimestamp(), updatedAt: serverTimestamp(),
  })
  await batch.commit()
  return { groupId }
}

export async function revokeSparkInvitation(configuration: FirebaseConfiguration, invitationId: string): Promise<void> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(invitationId)) throw new Error('Invitation ID is invalid.')
  const app = await getSplitUnwiseFirebaseApp(configuration)
  const auth = getAuth(app)
  if (!auth.currentUser) throw new Error('Sign in before revoking an invitation.')
  await updateDoc(doc(getFirestore(app), `invitations/${invitationId}`), {
    status: 'revoked', revokedByUid: auth.currentUser.uid, revokedAt: serverTimestamp(), updatedAt: serverTimestamp(),
  })
}

function authenticatedUser(app: Awaited<ReturnType<typeof getSplitUnwiseFirebaseApp>>, identity?: FirebaseIdentity): FirebaseIdentity {
  const current = getAuth(app).currentUser
  if (!current) throw new Error('A signed-in Firebase user is required.')
  if (identity && identity.uid !== current.uid) throw new Error('Firebase profile identity does not match the signed-in account.')
  return identity ?? current
}

async function writeInvitation(db: ReturnType<typeof getFirestore>, prepared: PreparedInvitation & { readonly secret: string }, uid: string, groupKind: ExpenseContextKind, rawGroupName: string, rawCreatedByName: string): Promise<void> {
  const groupName = normalizeDisplayName(rawGroupName)
  const createdByName = normalizeDisplayName(rawCreatedByName)
  const data: Record<string, unknown> = {
    schemaVersion: 1, invitationId: prepared.invitationId, tokenHash: prepared.invitationId, groupId: prepared.groupId, groupKind, groupName,
    status: 'active', createdByUid: uid, createdByName, createdAt: serverTimestamp(), updatedAt: serverTimestamp(), expiresAt: Timestamp.fromDate(new Date(prepared.expiresAt)),
  }
  if (prepared.targetEmail) data.targetEmail = prepared.targetEmail
  const batch = writeBatch(db)
  batch.set(doc(db, `invitations/${prepared.invitationId}`), data)
  await batch.commit()
}

async function requireMatchingCapability(invitationId: string, secret: string): Promise<void> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(invitationId) || await hashInvitationSecret(secret) !== invitationId) throw new Error('Invitation capability is invalid.')
}

function validateInvitation(data: DocumentData, user: Pick<User, 'uid' | 'email' | 'emailVerified'>): void {
  if (typeof data.groupId !== 'string' || typeof data.groupName !== 'string' || !(data.expiresAt instanceof Timestamp)) throw new Error('Invitation data is invalid.')
  if (data.status === 'used' && data.usedByUid === user.uid) return
  if (data.status !== 'active' || data.expiresAt.toMillis() <= Date.now()) throw new Error('Invitation is expired or no longer active.')
  if (typeof data.targetEmail === 'string' && (!user.emailVerified || user.email?.toLowerCase() !== data.targetEmail)) throw new Error('Sign in with the verified email named by this invitation.')
}

function requireProfile(data: DocumentData): FirebaseProfileDocument {
  if (typeof data.displayName !== 'string' || typeof data.initials !== 'string') throw new Error('Firebase profile data is invalid.')
  const avatarUrl = typeof data.avatarUrl === 'string' ? data.avatarUrl : null
  return { displayName: data.displayName, initials: data.initials, avatarUrl }
}

function normalizeDisplayName(value: string): string {
  const normalized = value.trim().replace(/\s+/g, ' ').slice(0, 120)
  return normalized || 'Split Unwise member'
}

function safeAvatarUrl(value: string | null): string | null {
  if (!value || value.length > 2048) return null
  try { return new URL(value).protocol === 'https:' ? value : null } catch { return null }
}

function normalizeEmail(value: string): string {
  const email = value.trim().toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Invitation email is invalid.')
  return email
}
