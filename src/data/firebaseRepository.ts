import type { FirebaseConfiguration } from './firebase'
import { getSplitUnwiseFirebaseApp, getSplitUnwiseFirebaseAuth } from './firebaseBootstrap'
import { buildCurrencyTotals, buildGroupCharts } from './aggregates'
import { decodeActivity, decodeBalanceSnapshot, decodeComment, decodeExpense, decodeExpenseRevision, decodeGroup, decodeGroupProjection, decodeMember, decodeNotification, decodeRecurringExpense, decodeSettlement, type DecodedGroupProjection } from './firebaseDecoders'
import { resolveFirebaseSession } from './firebaseSession'
import type { ActivityFilter, ActivityItem, ActivityPage, ActivityQuery, AppRepository, CommandEnvelope, CommandResult, CommentAddCommand, CommentAddResult, CommentDeleteCommand, CommentDeleteResult, ExpenseAddCommand, ExpenseAddResult, ExpenseDeleteCommand, ExpenseDeleteResult, ExpenseEditCommand, ExpenseEditResult, ExpenseRow, Group, GroupBalanceSnapshot, GroupDefaultSplitCommand, GroupSimplifyDebtsCommand, Member, NotificationItem, NotificationPage, NotificationPreferencesCommand, NotificationPreferencesResult, NotificationReadAllCommand, NotificationReadAllResult, NotificationReadCommand, NotificationReadResult, ProfileUpdateCommand, RecurrenceCancelCommand, RecurrenceCancelResult, RecurrenceMaterializeCommand, RecurrenceMaterializeResult, RecurringExpense, SavedCommandResult, SettlementRecord, SettlementRecordCommand, SettlementRecordResult, SettlementVoidCommand, SettlementVoidResult, TimelineCursor } from './repositories'
import { decodeDefaultSplit, type GroupSettings } from '../domain/groupSettings'
import { computeBalancePlans } from '../domain/balances'
import { buildSparkCommentDeleteRecord, buildSparkCommentRecord, buildSparkExpenseActivityRecord, buildSparkExpenseMutationRecord, buildSparkExpenseRecord, buildSparkFutureRecurringTemplateRecord, buildSparkGroupSettingsRecord, buildSparkMaterializationOperationId, buildSparkNotificationPreferencesRecord, buildSparkNotificationReadAllRecord, buildSparkNotificationReadRecord, buildSparkProfileUpdateRecord, buildSparkRecurrenceCancellationRecord, buildSparkRecurrenceMaterializationRecord, buildSparkSettlementRecord, buildSparkSettlementVoidRecord, type SparkExpenseActivityRecord } from './firebaseSparkMutations'
import { createOperationIdentity, OperationReplayConflictError } from './operationIdentity'
import { parseExecuteCommandRequest } from '@split-unwise/shared'
import { CommandConflictError } from './commandQueue'
import { compareTimelineAscending } from './timeline'
import { recurringOccurrenceId } from '../domain/recurrence'

type FirestoreModule = typeof import('firebase/firestore')
type AuthModule = typeof import('firebase/auth')
type FirebaseClient = { readonly auth: ReturnType<AuthModule['getAuth']>; readonly db: ReturnType<FirestoreModule['getFirestore']>; readonly firestore: FirestoreModule }
type FirebaseContext = FirebaseClient & { readonly userId: string }

/** Firebase facade: SDK modules are loaded only on the first actual repository call. */
export function createFirebaseRepository(configuration: FirebaseConfiguration, expectedUserId?: string, functionsRegion?: string): AppRepository {
  let clientPromise: Promise<FirebaseClient> | undefined
  let callablePromise: Promise<(request: unknown) => Promise<{ readonly data: unknown }>> | undefined
  let currentUserPromise: Promise<Member> | undefined
  const groupCache = new Map<string, Group>()
  const groupRequests = new Map<string, Promise<Group | undefined>>()
  const sparkActivityRequests = new Map<string, Promise<ActivityPage>>()
  const client = () => clientPromise ??= connect(configuration)

  async function context(): Promise<FirebaseContext> {
    const firebase = await client()
    const { userId } = await resolveFirebaseSession(firebase.auth)
    if (expectedUserId !== undefined && userId !== expectedUserId) throw new Error('Firebase authenticated principal changed')
    return { ...firebase, userId }
  }
  function currentUser(): Promise<Member> {
    if (currentUserPromise) return currentUserPromise
    const pending = (async () => {
      const { db, firestore, userId } = await context()
      const snapshot = await firestore.getDoc(firestore.doc(db, 'users', userId))
      if (!snapshot.exists()) throw new Error('Current Firebase user profile is missing')
      return decodeMember(userId, snapshot.data(), true)
    })()
    currentUserPromise = pending
    void pending.catch(() => {
      if (currentUserPromise === pending) currentUserPromise = undefined
    })
    return pending
  }
  function loadGroup(groupId: string, readyContext = context(), knownProjection?: DecodedGroupProjection): Promise<Group | undefined> {
    const cached = groupCache.get(groupId)
    if (cached) return Promise.resolve(cached)
    const existing = groupRequests.get(groupId)
    if (existing) return existing
    const pending = (async () => {
      const { db, firestore, userId } = await readyContext
      const [snapshot, projection] = await Promise.all([
        firestore.getDoc(firestore.doc(db, 'groups', groupId)),
        knownProjection
          ? Promise.resolve(knownProjection)
          : firestore.getDoc(firestore.doc(db, 'users', userId, 'groups', groupId)).then((membership) => membership.exists() ? decodeGroupProjection(membership.id, membership.data()) : undefined),
      ])
      if (!snapshot.exists()) return undefined
      const decoded = decodeGroup(snapshot.id, snapshot.data())
      const group = decoded.kind === 'friendship' && projection?.contextLabel
        ? { ...decoded, name: projection.contextLabel }
        : decoded
      groupCache.set(group.id, group)
      return group
    })()
    groupRequests.set(groupId, pending)
    void pending.finally(() => { if (groupRequests.get(groupId) === pending) groupRequests.delete(groupId) }).catch(() => undefined)
    return pending
  }
  async function listExpenseHeads(groupId: string, readyContext = context()): Promise<readonly ExpenseRow[]> {
    const { db, firestore } = await readyContext
    const snapshot = await firestore.getDocs(firestore.query(firestore.collection(db, 'groups', groupId, 'expenses'), firestore.limit(100)))
    const expenses = await Promise.all(snapshot.docs.map((document) => resolveSparkExpenseHead(db, firestore, groupId, document.id, document.data())))
    return expenses.sort(oldestExpenseFirst)
  }
  async function listExpenses(groupId: string, readyContext = context()): Promise<readonly ExpenseRow[]> {
    return (await listExpenseHeads(groupId, readyContext)).filter(({ deletedAt }) => deletedAt === undefined)
  }
  async function listRecurring(groupId: string, readyContext = context()): Promise<readonly RecurringExpense[]> {
    const { db, firestore } = await readyContext
    const snapshot = await firestore.getDocs(firestore.query(firestore.collection(db, 'groups', groupId, 'recurringTemplates'), firestore.limit(100)))
    return snapshot.docs.map((document) => decodeRecurringExpense(groupId, document.id, document.data()))
  }
  async function listSettlements(groupId: string, readyContext = context()): Promise<readonly SettlementRecord[]> {
    const { db, firestore } = await readyContext
    const snapshot = await firestore.getDocs(firestore.query(
      firestore.collection(db, 'groups', groupId, 'settlements'),
      firestore.orderBy('occurredOn', 'asc'),
      firestore.orderBy(firestore.documentId(), 'asc'),
      firestore.limit(100),
    ))
    return snapshot.docs.map((document) => decodeSettlement(groupId, document.id, document.data()))
  }
  function listAccountActivity(activityQuery: ActivityQuery): Promise<ActivityPage> {
    if (functionsRegion) return loadAccountActivity(activityQuery)
    const key = JSON.stringify(activityQuery)
    const existing = sparkActivityRequests.get(key)
    if (existing) return existing
    const pending = loadAccountActivity(activityQuery)
    sparkActivityRequests.set(key, pending)
    void pending.then(
      () => { if (sparkActivityRequests.get(key) === pending) sparkActivityRequests.delete(key) },
      () => { if (sparkActivityRequests.get(key) === pending) sparkActivityRequests.delete(key) },
    )
    return pending
  }
  async function loadAccountActivity(activityQuery: ActivityQuery): Promise<ActivityPage> {
    const { db, firestore, userId } = await context()
    assertTimelineLimit(activityQuery.limit)
    const constraints = [
      ...activityFilterConstraints(firestore, activityQuery.filter),
      firestore.orderBy('createdAt', 'desc'),
      firestore.orderBy(firestore.documentId(), 'desc'),
      ...(activityQuery.cursor ? [firestore.startAfter(activityQuery.cursor.createdAt, activityQuery.cursor.id)] : []),
      firestore.limit(Math.min(100, activityQuery.limit + 1)),
    ]
    if (functionsRegion) {
      const snapshot = await firestore.getDocs(firestore.query(firestore.collection(db, 'users', userId, 'activity'), ...constraints))
      const decoded = snapshot.docs.map((document) => decodeActivity(String(document.data().groupId ?? ''), document.id, document.data()))
      return serverPage(decoded, activityQuery.limit, (item) => item.id)
    }
    const projections = await firestore.getDocs(firestore.query(firestore.collection(db, 'users', userId, 'groups'), firestore.limit(100)))
    const groupIds = projections.docs.map((snapshot) => decodeGroupProjection(snapshot.id, snapshot.data()).groupId)
    const pages = await Promise.all(groupIds.map(async (groupId) => {
      const snapshot = await firestore.getDocs(firestore.query(firestore.collection(db, 'groups', groupId, 'activity'), ...constraints))
      return snapshot.docs.map((document) => decodeActivity(groupId, document.id, document.data()))
    }))
    const decoded = pages.flat().sort(newestActivityFirst).slice(0, activityQuery.limit + 1)
    return serverPage(decoded, activityQuery.limit, (item) => item.id)
  }
  async function listSparkNotifications(notificationQuery: { readonly limit: number; readonly cursor?: TimelineCursor }): Promise<NotificationPage> {
    assertTimelineLimit(notificationQuery.limit)
    const source = await listAccountActivity({ filter: 'all', limit: notificationQuery.limit, ...(notificationQuery.cursor ? { cursor: notificationQuery.cursor } : {}) })
    const readyContext = context()
    const { userId } = await readyContext
    const activities = source.items.filter((activity) => activity.actor.id !== userId)
    const state = await getSparkNotificationReadState(activities, readyContext)
    const items = activities.map((activity) => activityNotification(userId, activity, state.readAtByNotificationId.get(activity.id)
      ?? (state.cursor && compareTimelineAscending({ createdAt: activity.createdAt, id: activity.id }, state.cursor) <= 0 ? state.cursorReadAt : undefined)))
    return { items, ...(source.nextCursor ? { nextCursor: source.nextCursor } : {}) }
  }
  async function getSparkNotificationReadState(activities: readonly ActivityItem[], readyContext = context()): Promise<{
    readonly readAtByNotificationId: ReadonlyMap<string, string>
    readonly cursor?: TimelineCursor
    readonly cursorReadAt?: string
  }> {
    const { db, firestore, userId } = await readyContext
    const cursorReference = firestore.doc(db, 'users', userId, 'settings', 'sparkNotificationReadCursor')
    const chunks = chunk(activities.map(({ id }) => id), 30)
    const [cursorSnapshot, ...receiptPages] = await Promise.all([
      firestore.getDoc(cursorReference),
      ...chunks.map((ids) => firestore.getDocs(firestore.query(
        firestore.collection(db, 'users', userId, 'notificationReads'),
        firestore.where(firestore.documentId(), 'in', ids), firestore.limit(ids.length),
      ))),
    ])
    const readAtByNotificationId = new Map<string, string>()
    for (const page of receiptPages) for (const receipt of page.docs) {
      const data = receipt.data()
      if (data.notificationId !== receipt.id || data.activityId !== receipt.id) throw new Error('Notification read receipt is invalid')
      readAtByNotificationId.set(receipt.id, firebaseTimestamp(data.readAt, 'notification read receipt'))
    }
    if (!cursorSnapshot.exists()) return { readAtByNotificationId }
    const data = cursorSnapshot.data()
    if (!isRecord(data) || typeof data.cutoffCreatedAt !== 'string' || typeof data.cutoffId !== 'string') throw new Error('Notification read cursor is invalid')
    return {
      readAtByNotificationId,
      cursor: { createdAt: data.cutoffCreatedAt, id: data.cutoffId },
      cursorReadAt: firebaseTimestamp(data.updatedAt, 'notification read cursor'),
    }
  }
  async function findSparkNotification(notificationId: string, readyContext = context()): Promise<NotificationItem> {
    const { db, firestore, userId } = await readyContext
    const projections = await firestore.getDocs(firestore.query(firestore.collection(db, 'users', userId, 'groups'), firestore.limit(100)))
    const groupIds = projections.docs.map((snapshot) => decodeGroupProjection(snapshot.id, snapshot.data()).groupId)
    const snapshots = await Promise.all(groupIds.map(async (groupId) => ({
      groupId,
      snapshot: await firestore.getDoc(firestore.doc(db, 'groups', groupId, 'activity', notificationId)),
    })))
    const matches = snapshots.filter(({ snapshot }) => snapshot.exists())
    if (matches.length !== 1) throw new Error('Notification was not found')
    const activity = decodeActivity(matches[0]!.groupId, notificationId, matches[0]!.snapshot.data())
    if (activity.actor.id === userId) throw new Error('A user cannot receive a notification for their own activity')
    return activityNotification(userId, activity)
  }
  async function getGroupSettings(groupId: string, readyContext = context()): Promise<GroupSettings> {
    const { db, firestore } = await readyContext
    const snapshot = await firestore.getDoc(firestore.doc(db, 'groups', groupId, 'settings', 'defaults'))
    return snapshot.exists() ? decodeGroupSettings(groupId, snapshot.data()) : { schemaVersion: 1, groupId, revision: 1, simplifyDebtsEnabled: true }
  }
  async function getSparkSettingsBalanceRevision(groupId: string, readyContext = context()): Promise<number> {
    const { db, firestore } = await readyContext
    const snapshot = await firestore.getDoc(firestore.doc(db, 'groups', groupId, 'balance', 'current'))
    const data = snapshot.data()
    if (!snapshot.exists() || !isRecord(data) || data.groupId !== groupId || !Number.isSafeInteger(data.balanceRevision) || Number(data.balanceRevision) < 0) throw new Error('Stored group balance is invalid')
    return Number(data.balanceRevision)
  }
  async function getSparkBalanceSnapshot(groupId: string, readyContext = context()): Promise<GroupBalanceSnapshot> {
    const [allExpenses, settlements, settings, settingsBalanceRevision] = await Promise.all([
      listExpenseHeads(groupId, readyContext),
      listSettlements(groupId, readyContext),
      getGroupSettings(groupId, readyContext),
      getSparkSettingsBalanceRevision(groupId, readyContext),
    ])
    const expenses = allExpenses.filter(({ deletedAt }) => deletedAt === undefined)
    const balances = computeBalancePlans(expenses, settlements.map((settlement) => ({
      id: settlement.settlementId,
      senderId: settlement.senderId,
      recipientId: settlement.recipientId,
      money: settlement.money,
      voided: settlement.void !== undefined,
    })))
    return {
      groupId,
      balanceRevision: allExpenses.reduce((total, expense) => total + expense.revision, 0)
        + settlements.reduce((total, settlement) => total + settlement.revision, 0) + settingsBalanceRevision,
      simplifyDebtsEnabled: settings.simplifyDebtsEnabled !== false,
      ...balances,
    }
  }
  async function persistSparkExpenseActivity(db: FirebaseClient['db'], firestore: FirestoreModule, groupId: string, record: SparkExpenseActivityRecord): Promise<void> {
    const reference = firestore.doc(db, 'groups', groupId, 'activity', record.activityId)
    const expected = decodeActivity(groupId, record.activityId, record.activityDocument)
    const resourceToken = record.activityDocument.resourceToken
    if (typeof resourceToken !== 'string') throw new Error('Spark expense activity identity is invalid')
    await firestore.runTransaction(db, async (transaction) => {
      const existing = await transaction.get(reference)
      if (existing.exists()) {
        const data = existing.data()
        if (data.resourceToken !== resourceToken || !sameExpenseActivity(decodeActivity(groupId, existing.id, data), expected)) throw new OperationReplayConflictError()
        return
      }
      transaction.set(reference, record.activityDocument)
    })
  }

  async function executeSparkExpenseAdd(command: ExpenseAddCommand): Promise<ExpenseAddResult> {
    const readyContext = context()
    const { db, firestore, userId } = await readyContext
    const identity = await createOperationIdentity(userId, command)
    const member = await firestore.getDoc(firestore.doc(db, 'groups', command.groupId, 'members', userId))
    const memberData = member.data()
    if (!member.exists() || !isRecord(memberData) || memberData.status !== 'active' || typeof memberData.displayName !== 'string') {
      throw new Error('Only active group members can add an expense')
    }
    const record = buildSparkExpenseRecord(command, { id: userId, displayName: memberData.displayName }, identity, firestore.serverTimestamp())
    const reference = firestore.doc(db, 'groups', command.groupId, 'expenses', record.expenseId)
    const templateReference = record.templateId ? firestore.doc(db, 'groups', command.groupId, 'recurringTemplates', record.templateId) : undefined
    await firestore.runTransaction(db, async (transaction) => {
      const [existing, existingTemplate] = await Promise.all([
        transaction.get(reference),
        templateReference ? transaction.get(templateReference) : Promise.resolve(undefined),
      ])
      if (existing.exists()) {
        const data = existing.data()
        const creator = isRecord(data.createdBy) ? data.createdBy : undefined
        if (data.operationId !== identity.operationId
          || data.requestFingerprint !== identity.requestFingerprint
          || data.resourceToken !== identity.resourceId.slice('operation-'.length)
          || creator?.id !== identity.userId) throw new OperationReplayConflictError()
        if (templateReference) {
          const templateData = existingTemplate?.data()
          if (!existingTemplate?.exists() || !isRecord(templateData) || templateData.sourceExpenseId !== record.expenseId
            || templateData.operationId !== identity.operationId || templateData.requestFingerprint !== identity.requestFingerprint
            || templateData.resourceToken !== identity.resourceId.slice('operation-'.length)) throw new OperationReplayConflictError()
        }
        return
      }
      if (existingTemplate?.exists()) throw new OperationReplayConflictError()
      transaction.set(reference, record.expenseDocument)
      if (templateReference && record.templateDocument) transaction.set(templateReference, record.templateDocument)
    })
    const [saved, savedTemplate] = await Promise.all([
      firestore.getDoc(reference),
      templateReference ? firestore.getDoc(templateReference) : Promise.resolve(undefined),
    ])
    if (!saved.exists()) throw new Error('Saved expense is unavailable')
    const savedData = saved.data()
    const expense = decodeExpense(command.groupId, saved.id, savedData)
    if (!expense.createdBy) throw new Error('Saved expense creator is unavailable')
    if (templateReference) {
      if (!savedTemplate?.exists()) throw new Error('Saved recurring template is unavailable')
      const template = decodeRecurringExpense(command.groupId, templateReference.id, savedTemplate.data())
      if (template.status !== 'active' || expense.recurringTemplateId !== template.id) throw new Error('Saved recurring expense linkage is unavailable')
    }
    await persistSparkExpenseActivity(db, firestore, command.groupId, buildSparkExpenseActivityRecord({
      groupId: command.groupId, operationId: command.operationId, kind: 'expense.created', actor: expense.createdBy,
      expenseId: expense.id, resourceToken: identity.resourceId.slice('operation-'.length), revision: 1,
      label: expense.description, committedAt: savedData.createdAt,
    }))
    return { kind: 'expense.add', operationId: command.operationId, status: 'saved', expense }
  }

  async function executeSparkExpenseMutation(command: ExpenseEditCommand | ExpenseDeleteCommand): Promise<ExpenseEditResult | ExpenseDeleteResult> {
    const { db, firestore, userId } = await context()
    const identity = await createOperationIdentity(userId, command)
    const token = identity.resourceId.slice('operation-'.length)
    const memberReference = firestore.doc(db, 'groups', command.groupId, 'members', userId)
    const expenseReference = firestore.doc(db, 'groups', command.groupId, 'expenses', command.expenseId)
    await firestore.runTransaction(db, async (transaction) => {
      const [member, head] = await Promise.all([transaction.get(memberReference), transaction.get(expenseReference)])
      const memberData = member.data()
      if (!member.exists() || !isRecord(memberData) || memberData.status !== 'active' || typeof memberData.displayName !== 'string') {
        throw new Error('Only active group members can change an expense')
      }
      if (!head.exists()) throw new Error('Expense was not found')
      const headData = head.data()
      const root = decodeExpense(command.groupId, command.expenseId, headData)
      const headRevision = Number.isSafeInteger(headData.headRevision) ? Number(headData.headRevision) : root.revision
      const headToken = typeof headData.lastResourceToken === 'string'
        ? headData.lastResourceToken
        : typeof headData.resourceToken === 'string' ? headData.resourceToken : ''
      const embeddedCurrent = isRecord(headData.current) ? headData.current : undefined
      let currentData: Readonly<Record<string, unknown>> = embeddedCurrent ?? headData
      if (!embeddedCurrent && headRevision > root.revision) {
        const versionReference = firestore.doc(db, 'groups', command.groupId, 'expenses', command.expenseId, 'revisions', headToken)
        const version = await transaction.get(versionReference)
        if (!version.exists() || !isRecord(version.data().expense)) throw new Error('Current expense version is unavailable')
        currentData = version.data().expense as Readonly<Record<string, unknown>>
      }
      const current = decodeExpense(command.groupId, command.expenseId, currentData)
      if (headData.lastOperationId === identity.operationId) {
        if (headData.lastRequestFingerprint !== identity.requestFingerprint || headToken !== identity.resourceId.slice('operation-'.length)) throw new OperationReplayConflictError()
        return
      }
      if (command.kind === 'expense.edit' && current.recurringTemplateId && !command.draft.occurrenceEditScope) {
        throw new Error('Choose whether to edit this occurrence or future expenses')
      }
      const templateReference = command.kind === 'expense.edit' && command.draft.occurrenceEditScope === 'future' && current.recurringTemplateId
        ? firestore.doc(db, 'groups', command.groupId, 'recurringTemplates', current.recurringTemplateId)
        : undefined
      const templateSnapshot = templateReference ? await transaction.get(templateReference) : undefined
      if (templateReference && !templateSnapshot?.exists()) throw new Error('Linked recurring template is unavailable')
      try {
        const mutation = buildSparkExpenseMutationRecord(
          command,
          headData,
          currentData,
          { actor: { id: userId, displayName: memberData.displayName }, canManage: memberData.canManage === true },
          identity,
          firestore.serverTimestamp(),
        )
        transaction.set(expenseReference, mutation.headDocument)
        transaction.set(
          firestore.doc(db, 'groups', command.groupId, 'expenses', command.expenseId, 'revisions', mutation.revisionId),
          mutation.revisionDocument,
        )
        if (templateReference && templateSnapshot?.exists() && command.kind === 'expense.edit') {
          transaction.set(templateReference, buildSparkFutureRecurringTemplateRecord(
            command, current, templateSnapshot.data(), { id: userId, displayName: memberData.displayName }, identity, firestore.serverTimestamp(),
          ))
        }
      } catch (error) {
        if (error instanceof Error && /changed remotely|latest recurring occurrence/i.test(error.message)) throw new CommandConflictError(error.message, { remote: current })
        throw error
      }
    })
    const revisionReference = firestore.doc(db, 'groups', command.groupId, 'expenses', command.expenseId, 'revisions', token)
    const [savedHead, savedVersion] = await Promise.all([firestore.getDoc(expenseReference), firestore.getDoc(revisionReference)])
    if (!savedHead.exists() || !savedVersion.exists()) throw new Error('Saved expense revision is unavailable')
    const saved = await resolveSparkExpenseHead(db, firestore, command.groupId, command.expenseId, savedHead.data())
    const revision = decodeExpenseRevision(command.groupId, command.expenseId, token, savedVersion.data())
    const expectedAction = command.kind === 'expense.delete' ? 'deleted' : 'updated'
    if (revision.action !== expectedAction || revision.operationId !== command.operationId) throw new OperationReplayConflictError()
    await persistSparkExpenseActivity(db, firestore, command.groupId, buildSparkExpenseActivityRecord({
      groupId: command.groupId, operationId: command.operationId,
      kind: command.kind === 'expense.delete' ? 'expense.deleted' : 'expense.updated', actor: revision.actor,
      expenseId: command.expenseId, resourceToken: token, revision: revision.revision,
      label: revision.expense.description, committedAt: savedVersion.data().createdAt,
    }))
    if (command.kind === 'expense.edit') {
      return { kind: 'expense.edit', operationId: command.operationId, status: 'saved', expense: saved }
    }
    if (!saved.deletedAt) throw new Error('Saved expense tombstone is unavailable')
    return {
      kind: 'expense.delete', operationId: command.operationId, status: 'saved',
      tombstone: { id: saved.id, groupId: saved.groupId, revision: saved.revision, deletedAt: saved.deletedAt },
    }
  }

  async function executeSparkCommentAdd(command: CommentAddCommand): Promise<CommentAddResult> {
    const { db, firestore, userId } = await context()
    const identity = await createOperationIdentity(userId, command)
    const memberReference = firestore.doc(db, 'groups', command.groupId, 'members', userId)
    const expenseReference = firestore.doc(db, 'groups', command.groupId, 'expenses', command.expenseId)
    const token = identity.resourceId.slice('operation-'.length)
    const commentId = `comment-${token}`
    const commentReference = firestore.doc(db, 'groups', command.groupId, 'comments', commentId)
    const activityReference = firestore.doc(db, 'groups', command.groupId, 'activity', `activity-${token}`)
    await firestore.runTransaction(db, async (transaction) => {
      const [member, expense, existing] = await Promise.all([
        transaction.get(memberReference), transaction.get(expenseReference), transaction.get(commentReference),
      ])
      const memberData = member.data()
      if (!member.exists() || !isRecord(memberData) || memberData.status !== 'active' || typeof memberData.displayName !== 'string') throw new Error('Only active group members can add a comment')
      if (existing.exists()) {
        const data = existing.data()
        const author = isRecord(data.author) ? data.author : undefined
        if (data.operationId !== identity.operationId || data.requestFingerprint !== identity.requestFingerprint || data.resourceToken !== token || author?.id !== userId || data.deletedAt !== undefined) throw new OperationReplayConflictError()
        return
      }
      if (!expense.exists() || expense.data().headDeleted === true) throw new Error('Cannot comment on a deleted expense')
      const record = buildSparkCommentRecord(command, { id: userId, displayName: memberData.displayName }, identity, firestore.serverTimestamp())
      transaction.set(commentReference, record.commentDocument)
      transaction.set(activityReference, record.activityDocument)
    })
    const [savedComment, savedActivity] = await Promise.all([firestore.getDoc(commentReference), firestore.getDoc(activityReference)])
    if (!savedComment.exists() || !savedActivity.exists()) throw new Error('Saved comment is unavailable')
    return {
      kind: 'comment.add', operationId: command.operationId, status: 'saved',
      comment: decodeComment(command.groupId, command.expenseId, commentId, savedComment.data()),
      activity: decodeActivity(command.groupId, activityReference.id, savedActivity.data()),
    }
  }

  async function executeSparkCommentDelete(command: CommentDeleteCommand): Promise<CommentDeleteResult> {
    const { db, firestore, userId } = await context()
    const identity = await createOperationIdentity(userId, command)
    const memberReference = firestore.doc(db, 'groups', command.groupId, 'members', userId)
    const commentReference = firestore.doc(db, 'groups', command.groupId, 'comments', command.commentId)
    const token = identity.resourceId.slice('operation-'.length)
    const activityReference = firestore.doc(db, 'groups', command.groupId, 'activity', `activity-${token}`)
    await firestore.runTransaction(db, async (transaction) => {
      const [member, current] = await Promise.all([transaction.get(memberReference), transaction.get(commentReference)])
      const memberData = member.data()
      if (!member.exists() || !isRecord(memberData) || memberData.status !== 'active' || typeof memberData.displayName !== 'string') throw new Error('Only active group members can delete a comment')
      if (!current.exists()) throw new Error('Comment is not available')
      const data = current.data()
      if (data.lastOperationId === identity.operationId) {
        if (data.lastRequestFingerprint !== identity.requestFingerprint || data.lastResourceToken !== token) throw new OperationReplayConflictError()
        return
      }
      const record = buildSparkCommentDeleteRecord(command, data, { id: userId, displayName: memberData.displayName }, identity, firestore.serverTimestamp())
      transaction.set(commentReference, record.commentDocument)
      transaction.set(activityReference, record.activityDocument)
    })
    const [savedComment, savedActivity] = await Promise.all([firestore.getDoc(commentReference), firestore.getDoc(activityReference)])
    if (!savedComment.exists() || !savedActivity.exists()) throw new Error('Saved comment deletion is unavailable')
    return {
      kind: 'comment.delete', operationId: command.operationId, status: 'saved',
      comment: decodeComment(command.groupId, command.expenseId, command.commentId, savedComment.data()),
      activity: decodeActivity(command.groupId, activityReference.id, savedActivity.data()),
    }
  }

  async function executeSparkSettlementRecord(command: SettlementRecordCommand): Promise<SettlementRecordResult> {
    const readyContext = context()
    const { db, firestore, userId } = await readyContext
    const identity = await createOperationIdentity(userId, command)
    const token = identity.resourceId.slice('operation-'.length)
    const settlementId = `settlement-${token}`
    const settlementReference = firestore.doc(db, 'groups', command.groupId, 'settlements', settlementId)
    const activityReference = firestore.doc(db, 'groups', command.groupId, 'activity', `activity-${token}`)
    const memberReferences = [...new Set([userId, command.basis.senderId, command.basis.recipientId])]
      .map((memberId) => firestore.doc(db, 'groups', command.groupId, 'members', memberId))
    const [balanceSnapshot, existingSettlement, ...memberSnapshots] = await Promise.all([
      getSparkBalanceSnapshot(command.groupId, readyContext),
      firestore.getDoc(settlementReference),
      ...memberReferences.map((reference) => firestore.getDoc(reference)),
    ])
    if (existingSettlement.exists()) {
      const data = existingSettlement.data()
      const creator = isRecord(data.createdBy) ? data.createdBy : undefined
      if (data.operationId !== identity.operationId || data.requestFingerprint !== identity.requestFingerprint
        || data.resourceToken !== token || creator?.id !== userId) throw new OperationReplayConflictError()
      const savedActivity = await firestore.getDoc(activityReference)
      if (!savedActivity.exists()) throw new Error('Saved settlement activity is unavailable')
      return {
        kind: 'settlement.record', operationId: command.operationId, status: 'saved',
        settlement: decodeSettlement(command.groupId, settlementId, data), balanceSnapshot,
        activity: decodeActivity(command.groupId, activityReference.id, savedActivity.data()),
      }
    }
    if (balanceSnapshot.balanceRevision !== command.expectedBalanceRevision || !settlementBasisMatches(balanceSnapshot, command)) {
      throw new CommandConflictError('Group balance changed remotely. Reload it before recording this payment.', { remote: balanceSnapshot })
    }
    const actorMembership = memberSnapshots[0]
    const actorData = actorMembership?.data()
    if (!actorMembership?.exists() || !isRecord(actorData) || actorData.status !== 'active' || typeof actorData.displayName !== 'string') {
      throw new Error('Only active group members can record a settlement')
    }
    if (memberSnapshots.some((snapshot) => !snapshot.exists() || snapshot.data().status !== 'active')) throw new Error('Settlement participants must be active group members')
    const record = buildSparkSettlementRecord(command, { id: userId, displayName: actorData.displayName }, identity, firestore.serverTimestamp())
    await firestore.runTransaction(db, async (transaction) => {
      const existing = await transaction.get(settlementReference)
      if (existing.exists()) {
        const data = existing.data()
        const creator = isRecord(data.createdBy) ? data.createdBy : undefined
        if (data.operationId !== identity.operationId || data.requestFingerprint !== identity.requestFingerprint
          || data.resourceToken !== token || creator?.id !== userId) throw new OperationReplayConflictError()
        return
      }
      transaction.set(settlementReference, record.settlementDocument)
      transaction.set(activityReference, record.activityDocument)
    })
    const [savedSettlement, savedActivity, savedBalance] = await Promise.all([
      firestore.getDoc(settlementReference), firestore.getDoc(activityReference), getSparkBalanceSnapshot(command.groupId, readyContext),
    ])
    if (!savedSettlement.exists() || !savedActivity.exists()) throw new Error('Saved settlement is unavailable')
    return {
      kind: 'settlement.record', operationId: command.operationId, status: 'saved',
      settlement: decodeSettlement(command.groupId, settlementId, savedSettlement.data()),
      balanceSnapshot: savedBalance,
      activity: decodeActivity(command.groupId, record.activityId, savedActivity.data()),
    }
  }

  async function executeSparkSettlementVoid(command: SettlementVoidCommand): Promise<SettlementVoidResult> {
    const readyContext = context()
    const { db, firestore, userId } = await readyContext
    const identity = await createOperationIdentity(userId, command)
    const token = identity.resourceId.slice('operation-'.length)
    const memberReference = firestore.doc(db, 'groups', command.groupId, 'members', userId)
    const settlementReference = firestore.doc(db, 'groups', command.groupId, 'settlements', command.settlementId)
    const activityReference = firestore.doc(db, 'groups', command.groupId, 'activity', `activity-${token}`)
    const [balanceSnapshot, existingSettlement] = await Promise.all([
      getSparkBalanceSnapshot(command.groupId, readyContext), firestore.getDoc(settlementReference),
    ])
    if (existingSettlement.exists() && existingSettlement.data().lastOperationId === identity.operationId) {
      const data = existingSettlement.data()
      const audit = isRecord(data.void) ? data.void : undefined
      if (data.lastRequestFingerprint !== identity.requestFingerprint || data.lastResourceToken !== token || audit?.operationId !== command.operationId) throw new OperationReplayConflictError()
      const savedActivity = await firestore.getDoc(activityReference)
      if (!savedActivity.exists()) throw new Error('Saved settlement void activity is unavailable')
      return {
        kind: 'settlement.void', operationId: command.operationId, status: 'saved',
        settlement: decodeSettlement(command.groupId, command.settlementId, data), balanceSnapshot,
        activity: decodeActivity(command.groupId, activityReference.id, savedActivity.data()),
      }
    }
    if (balanceSnapshot.balanceRevision !== command.expectedBalanceRevision) {
      throw new CommandConflictError('Group balance changed remotely. Reload it before voiding this payment.', { remote: balanceSnapshot })
    }
    await firestore.runTransaction(db, async (transaction) => {
      const [membership, current] = await Promise.all([transaction.get(memberReference), transaction.get(settlementReference)])
      const memberData = membership.data()
      if (!membership.exists() || !isRecord(memberData) || memberData.status !== 'active' || typeof memberData.displayName !== 'string') {
        throw new Error('Only active group members can void a settlement')
      }
      if (!current.exists()) throw new Error('Settlement was not found')
      const data = current.data()
      if (data.lastOperationId === identity.operationId) {
        const audit = isRecord(data.void) ? data.void : undefined
        if (data.lastRequestFingerprint !== identity.requestFingerprint || data.lastResourceToken !== token || audit?.operationId !== command.operationId) throw new OperationReplayConflictError()
        return
      }
      try {
        const record = buildSparkSettlementVoidRecord(
          command, data,
          { actor: { id: userId, displayName: memberData.displayName }, canManage: memberData.canManage === true },
          identity, firestore.serverTimestamp(),
        )
        transaction.set(settlementReference, record.settlementDocument)
        transaction.set(activityReference, record.activityDocument)
      } catch (error) {
        if (error instanceof Error && /changed remotely/i.test(error.message)) {
          throw new CommandConflictError(error.message, { remote: decodeSettlement(command.groupId, command.settlementId, data) })
        }
        throw error
      }
    })
    const [savedSettlement, savedActivity, savedBalance] = await Promise.all([
      firestore.getDoc(settlementReference), firestore.getDoc(activityReference), getSparkBalanceSnapshot(command.groupId, readyContext),
    ])
    if (!savedSettlement.exists() || !savedActivity.exists()) throw new Error('Saved settlement void is unavailable')
    return {
      kind: 'settlement.void', operationId: command.operationId, status: 'saved',
      settlement: decodeSettlement(command.groupId, command.settlementId, savedSettlement.data()),
      balanceSnapshot: savedBalance,
      activity: decodeActivity(command.groupId, activityReference.id, savedActivity.data()),
    }
  }

  async function executeSparkGroupSettings(command: GroupDefaultSplitCommand | GroupSimplifyDebtsCommand): Promise<SavedCommandResult<'group.default-split'> | SavedCommandResult<'group.simplify-debts'>> {
    const { db, firestore, userId } = await context()
    const identity = await createOperationIdentity(userId, command)
    const token = identity.resourceId.slice('operation-'.length)
    const settingsReference = firestore.doc(db, 'groups', command.groupId, 'settings', 'defaults')
    const balanceReference = firestore.doc(db, 'groups', command.groupId, 'balance', 'current')
    const activityReference = firestore.doc(db, 'groups', command.groupId, 'activity', `activity-${token}`)
    await firestore.runTransaction(db, async (transaction) => {
      const participantIds = command.kind === 'group.default-split' && command.defaultSplit ? command.defaultSplit.participantIds : []
      const memberIds = [...new Set([userId, ...participantIds])]
      const [settings, balance, ...memberSnapshots] = await Promise.all([
        transaction.get(settingsReference), transaction.get(balanceReference),
        ...memberIds.map((memberId) => transaction.get(firestore.doc(db, 'groups', command.groupId, 'members', memberId))),
      ])
      if (!settings.exists()) throw new Error('Group settings are unavailable')
      const current = settings.data()
      if (current.lastOperationId === identity.operationId) {
        if (current.lastCommandKind !== identity.kind || current.lastRequestFingerprint !== identity.requestFingerprint || current.lastResourceToken !== token) throw new OperationReplayConflictError()
        return
      }
      const members = memberSnapshots.flatMap((snapshot, index): Member[] => {
        const data = snapshot.data()
        if (!snapshot.exists() || !isRecord(data) || data.status !== 'active' || typeof data.displayName !== 'string' || typeof data.initials !== 'string') return []
        return [{
          id: memberIds[index]!, displayName: data.displayName, initials: data.initials, isCurrentUser: memberIds[index] === userId,
          ...(typeof data.avatarUrl === 'string' ? { avatarUrl: data.avatarUrl } : {}),
          ...(typeof data.canManage === 'boolean' ? { canManage: data.canManage } : {}),
        }]
      })
      const actor = members.find(({ id }) => id === userId)
      if (!actor) throw new Error('Only an active group member can change group settings')
      try {
        const record = buildSparkGroupSettingsRecord(
          command, current, balance.exists() ? balance.data() : undefined, members,
          { id: actor.id, displayName: actor.displayName }, identity, firestore.serverTimestamp(),
        )
        transaction.set(settingsReference, record.settingsDocument)
        if (record.balanceDocument) transaction.set(balanceReference, record.balanceDocument)
        transaction.set(activityReference, record.activityDocument)
      } catch (reason) {
        if (reason instanceof Error && /changed remotely/i.test(reason.message)) throw new CommandConflictError('Group settings changed remotely.')
        throw reason
      }
    })
    const [savedSettings, savedActivity] = await Promise.all([firestore.getDoc(settingsReference), firestore.getDoc(activityReference)])
    if (!savedSettings.exists() || !savedActivity.exists()) throw new Error('Saved group settings are unavailable')
    return { kind: command.kind, operationId: command.operationId, status: 'saved', resourceId: command.groupId } as SavedCommandResult<'group.default-split'> | SavedCommandResult<'group.simplify-debts'>
  }

  async function executeSparkProfileUpdate(command: ProfileUpdateCommand): Promise<SavedCommandResult<'profile.update'>> {
    const { auth, db, firestore, userId } = await context()
    const identity = await createOperationIdentity(userId, command)
    const token = identity.resourceId.slice('operation-'.length)
    const projections = await firestore.getDocs(firestore.query(firestore.collection(db, 'users', userId, 'groups'), firestore.limit(100)))
    const groupIds = projections.docs.map((snapshot) => decodeGroupProjection(snapshot.id, snapshot.data()).groupId)
    const profileReference = firestore.doc(db, 'users', userId)
    await firestore.runTransaction(db, async (transaction) => {
      const memberReferences = groupIds.map((groupId) => firestore.doc(db, 'groups', groupId, 'members', userId))
      const [profile, ...members] = await Promise.all([
        transaction.get(profileReference), ...memberReferences.map((reference) => transaction.get(reference)),
      ])
      if (!profile.exists()) throw new Error('Current Firebase user profile is missing')
      const current = profile.data()
      if (current.lastOperationId === identity.operationId) {
        if (current.lastCommandKind !== identity.kind || current.lastRequestFingerprint !== identity.requestFingerprint || current.lastResourceToken !== token) throw new OperationReplayConflictError()
        return
      }
      const record = buildSparkProfileUpdateRecord(command, current, identity, firestore.serverTimestamp())
      transaction.set(profileReference, record.profileDocument)
      members.forEach((snapshot, index) => {
        const data = snapshot.data()
        if (snapshot.exists() && isRecord(data) && data.status === 'active') transaction.update(memberReferences[index]!, record.memberPatch)
      })
    })
    const currentAuthUser = auth.currentUser
    if (!currentAuthUser || currentAuthUser.uid !== userId) throw new Error('Firebase authenticated principal changed')
    const firebaseAuth = await import('firebase/auth')
    await firebaseAuth.updateProfile(currentAuthUser, { displayName: command.displayName.trim().replace(/\s+/g, ' ') })
    const saved = await firestore.getDoc(profileReference)
    if (!saved.exists() || saved.data().lastOperationId !== identity.operationId) throw new Error('Saved Firebase profile is unavailable')
    const groupSnapshots = await Promise.all(groupIds.map((groupId) => firestore.getDoc(firestore.doc(db, 'groups', groupId))))
    await Promise.all(groupSnapshots.flatMap((group, index) => {
      const data = group.data()
      if (!group.exists() || !isRecord(data) || data.kind !== 'friendship' || !Array.isArray(data.memberIds) || data.memberIds.length !== 2) return []
      const counterpartUid = data.memberIds.find((memberId) => typeof memberId === 'string' && memberId !== userId)
      if (typeof counterpartUid !== 'string') return []
      return [firestore.updateDoc(firestore.doc(db, 'users', counterpartUid, 'groups', groupIds[index]!), {
        contextLabel: command.displayName.trim().replace(/\s+/g, ' '), updatedAt: firestore.serverTimestamp(),
      })]
    }))
    return { kind: 'profile.update', operationId: command.operationId, status: 'saved', resourceId: userId }
  }

  async function executeSparkNotificationPreferences(command: NotificationPreferencesCommand): Promise<NotificationPreferencesResult> {
    const { db, firestore, userId } = await context()
    const identity = await createOperationIdentity(userId, command)
    const token = identity.resourceId.slice('operation-'.length)
    const reference = firestore.doc(db, 'users', userId, 'settings', 'notifications')
    await firestore.runTransaction(db, async (transaction) => {
      const snapshot = await transaction.get(reference)
      const current = snapshot.exists() ? snapshot.data() : undefined
      if (current?.lastOperationId === identity.operationId) {
        if (current.lastCommandKind !== identity.kind || current.lastRequestFingerprint !== identity.requestFingerprint || current.lastResourceToken !== token) throw new OperationReplayConflictError()
        return
      }
      transaction.set(reference, buildSparkNotificationPreferencesRecord(command, current, identity, firestore.serverTimestamp()))
    })
    const saved = await firestore.getDoc(reference)
    const data = saved.data()
    if (!saved.exists() || !isRecord(data) || data.lastOperationId !== identity.operationId
      || typeof data.emailEnabled !== 'boolean' || typeof data.pushEnabled !== 'boolean') throw new Error('Saved notification preferences are unavailable')
    return {
      kind: 'notification.preferences', operationId: command.operationId, status: 'saved',
      preferences: { emailEnabled: data.emailEnabled, pushEnabled: data.pushEnabled },
    }
  }

  async function executeSparkNotificationRead(command: NotificationReadCommand): Promise<NotificationReadResult> {
    const readyContext = context()
    const { db, firestore, userId } = await readyContext
    const identity = await createOperationIdentity(userId, command)
    const token = identity.resourceId.slice('operation-'.length)
    const reference = firestore.doc(db, 'users', userId, 'notificationReads', command.notificationId)
    const existing = await firestore.getDoc(reference)
    const notification = await findSparkNotification(command.notificationId, readyContext)
    if (existing.exists()) {
      const data = existing.data()
      if (data.operationId === identity.operationId && (data.requestFingerprint !== identity.requestFingerprint || data.resourceToken !== token)) throw new OperationReplayConflictError()
      return {
        kind: command.kind, operationId: command.operationId, status: 'saved',
        notification: { ...notification, readAt: firebaseTimestamp(data.readAt, 'notification read receipt') },
      }
    }
    const record = buildSparkNotificationReadRecord(command, notification, identity, firestore.serverTimestamp())
    await firestore.runTransaction(db, async (transaction) => {
      const saved = await transaction.get(reference)
      if (saved.exists()) return
      transaction.set(reference, record.receiptDocument)
    })
    const saved = await firestore.getDoc(reference)
    if (!saved.exists()) throw new Error('Saved notification read receipt is unavailable')
    return {
      kind: command.kind, operationId: command.operationId, status: 'saved',
      notification: { ...notification, readAt: firebaseTimestamp(saved.data().readAt, 'notification read receipt') },
    }
  }

  async function executeSparkNotificationReadAll(command: NotificationReadAllCommand): Promise<NotificationReadAllResult> {
    const readyContext = context()
    const { db, firestore, userId } = await readyContext
    const identity = await createOperationIdentity(userId, command)
    const token = identity.resourceId.slice('operation-'.length)
    const reference = firestore.doc(db, 'users', userId, 'settings', 'sparkNotificationReadCursor')
    const before = await listSparkNotifications({ limit: 100 })
    const unreadIds = before.items
      .filter((notification) => notification.readAt === undefined && compareTimelineAscending({ createdAt: notification.createdAt, id: notification.notificationId }, command.cutoff) <= 0)
      .map(({ notificationId }) => notificationId)
    await firestore.runTransaction(db, async (transaction) => {
      const snapshot = await transaction.get(reference)
      const current = snapshot.exists() ? snapshot.data() : undefined
      if (current?.lastOperationId === identity.operationId) {
        if (current.lastCommandKind !== identity.kind || current.lastRequestFingerprint !== identity.requestFingerprint || current.lastResourceToken !== token) throw new OperationReplayConflictError()
        return
      }
      transaction.set(reference, buildSparkNotificationReadAllRecord(command, current, identity, firestore.serverTimestamp(), unreadIds))
    })
    const saved = await firestore.getDoc(reference)
    const data = saved.data()
    if (!saved.exists() || !isRecord(data) || data.lastOperationId !== identity.operationId || !Array.isArray(data.readNotificationIds)
      || data.readNotificationIds.some((notificationId) => typeof notificationId !== 'string')) throw new Error('Saved notification read cursor is unavailable')
    return {
      kind: command.kind, operationId: command.operationId, status: 'saved', cutoff: command.cutoff,
      readNotificationIds: data.readNotificationIds as readonly string[],
    }
  }

  async function executeSparkRecurrenceMaterialize(command: RecurrenceMaterializeCommand): Promise<RecurrenceMaterializeResult> {
    const { db, firestore, userId } = await context()
    const identity = await createOperationIdentity(userId, command)
    const token = identity.resourceId.slice('operation-'.length)
    const occurrenceId = recurringOccurrenceId(command.templateId, command.occurrenceDate)
    const memberReference = firestore.doc(db, 'groups', command.groupId, 'members', userId)
    const templateReference = firestore.doc(db, 'groups', command.groupId, 'recurringTemplates', command.templateId)
    const occurrenceReference = firestore.doc(db, 'groups', command.groupId, 'expenses', occurrenceId)
    const activityReference = firestore.doc(db, 'groups', command.groupId, 'activity', `activity-${token}`)
    try {
      await firestore.runTransaction(db, async (transaction) => {
        const [member, templateSnapshot, occurrenceSnapshot, activitySnapshot] = await Promise.all([
          transaction.get(memberReference), transaction.get(templateReference), transaction.get(occurrenceReference), transaction.get(activityReference),
        ])
        const memberData = member.data()
        if (!member.exists() || !isRecord(memberData) || memberData.status !== 'active' || typeof memberData.displayName !== 'string') {
          throw new Error('Only active group members can materialize a recurring expense')
        }
        if (!templateSnapshot.exists()) throw new Error('Recurring template was not found')
        const currentTemplate = decodeRecurringExpense(command.groupId, command.templateId, templateSnapshot.data())
        if (occurrenceSnapshot.exists()) {
          const existing = decodeExpense(command.groupId, occurrenceId, occurrenceSnapshot.data())
          if (existing.id !== occurrenceId || existing.groupId !== command.groupId || existing.recurringTemplateId !== command.templateId
            || currentTemplate.nextDate <= command.occurrenceDate) throw new OperationReplayConflictError()
          return
        }
        if (activitySnapshot.exists()) throw new OperationReplayConflictError()
        const record = buildSparkRecurrenceMaterializationRecord(
          command, templateSnapshot.data(), { id: userId, displayName: memberData.displayName }, identity, firestore.serverTimestamp(),
        )
        transaction.set(occurrenceReference, record.occurrenceDocument)
        transaction.set(templateReference, record.templateDocument)
        transaction.set(activityReference, record.activityDocument)
      })
    } catch (error) {
      // Rules intentionally reject a stale losing race after another client advances the template.
      // Re-read below and accept only the deterministic occurrence's complete semantic replay.
      if (!isFirestorePermissionDenied(error)) throw error
    }
    const [savedOccurrence, savedTemplate] = await Promise.all([firestore.getDoc(occurrenceReference), firestore.getDoc(templateReference)])
    if (!savedOccurrence.exists() || !savedTemplate.exists()) throw new Error('Saved recurring occurrence is unavailable')
    const savedOccurrenceData = savedOccurrence.data()
    const occurrence = await resolveSparkExpenseHead(db, firestore, command.groupId, occurrenceId, savedOccurrenceData)
    const template = decodeRecurringExpense(command.groupId, command.templateId, savedTemplate.data())
    if (occurrence.id !== occurrenceId || occurrence.groupId !== command.groupId || occurrence.recurringTemplateId !== command.templateId
      || template.id !== command.templateId || template.groupId !== command.groupId
      || template.nextDate <= command.occurrenceDate) throw new OperationReplayConflictError()
    const creationToken = isRecord(savedOccurrenceData) ? savedOccurrenceData.resourceToken : undefined
    if (typeof creationToken !== 'string' || !/^[a-f0-9]{48}$/.test(creationToken)) throw new OperationReplayConflictError()
    const activityId = `activity-${creationToken}`
    const savedActivity = await firestore.getDoc(firestore.doc(db, 'groups', command.groupId, 'activity', activityId))
    if (!savedActivity.exists()) throw new OperationReplayConflictError()
    const activity = decodeActivity(command.groupId, activityId, savedActivity.data())
    if (activity.kind !== 'expense.created' || activity.expenseId !== occurrenceId || activity.subject.id !== occurrenceId
      || activity.operationId !== savedOccurrenceData.operationId || activity.revision !== 1
      || activity.actor.id !== occurrence.createdBy?.id || activity.actor.displayName !== occurrence.createdBy.displayName
      || activity.createdAt !== occurrence.createdAt) throw new OperationReplayConflictError()
    return { kind: command.kind, operationId: command.operationId, status: 'saved', template, occurrence }
  }

  async function executeSparkRecurrenceCancel(command: RecurrenceCancelCommand): Promise<RecurrenceCancelResult> {
    const { db, firestore, userId } = await context()
    const identity = await createOperationIdentity(userId, command)
    const token = identity.resourceId.slice('operation-'.length)
    const memberReference = firestore.doc(db, 'groups', command.groupId, 'members', userId)
    const templateReference = firestore.doc(db, 'groups', command.groupId, 'recurringTemplates', command.templateId)
    await firestore.runTransaction(db, async (transaction) => {
      const [member, templateSnapshot] = await Promise.all([transaction.get(memberReference), transaction.get(templateReference)])
      const memberData = member.data()
      if (!member.exists() || !isRecord(memberData) || memberData.status !== 'active' || typeof memberData.displayName !== 'string') {
        throw new Error('Only active group members can cancel a recurring expense')
      }
      if (!templateSnapshot.exists()) throw new Error('Recurring template was not found')
      const data = templateSnapshot.data()
      if (data.lastOperationId === identity.operationId) {
        if (data.lastRequestFingerprint !== identity.requestFingerprint || data.lastResourceToken !== token) throw new OperationReplayConflictError()
        return
      }
      try {
        transaction.set(templateReference, buildSparkRecurrenceCancellationRecord(
          command, data, { id: userId, displayName: memberData.displayName }, identity, firestore.serverTimestamp(),
        ))
      } catch (error) {
        if (error instanceof Error && /changed remotely/i.test(error.message)) {
          throw new CommandConflictError(error.message, { remote: decodeRecurringExpense(command.groupId, command.templateId, data) })
        }
        throw error
      }
    })
    const saved = await firestore.getDoc(templateReference)
    if (!saved.exists()) throw new Error('Saved recurring template is unavailable')
    const template = decodeRecurringExpense(command.groupId, command.templateId, saved.data())
    if (template.status !== 'cancelled') throw new OperationReplayConflictError()
    return { kind: command.kind, operationId: command.operationId, status: 'saved', template }
  }

  async function execute(command: CommandEnvelope): Promise<CommandResult> {
    if (!functionsRegion) {
      if (command.kind === 'expense.add') return executeSparkExpenseAdd(command)
      if (command.kind === 'expense.edit' || command.kind === 'expense.delete') return executeSparkExpenseMutation(command)
      if (command.kind === 'comment.add') return executeSparkCommentAdd(command)
      if (command.kind === 'comment.delete') return executeSparkCommentDelete(command)
      if (command.kind === 'settlement.record') return executeSparkSettlementRecord(command)
      if (command.kind === 'settlement.void') return executeSparkSettlementVoid(command)
      if (command.kind === 'group.default-split' || command.kind === 'group.simplify-debts') return executeSparkGroupSettings(command)
      if (command.kind === 'profile.update') return executeSparkProfileUpdate(command)
      if (command.kind === 'notification.preferences') return executeSparkNotificationPreferences(command)
      if (command.kind === 'notification.read') return executeSparkNotificationRead(command)
      if (command.kind === 'notification.read-all') return executeSparkNotificationReadAll(command)
      if (command.kind === 'recurrence.materialize') return executeSparkRecurrenceMaterialize(command)
      if (command.kind === 'recurrence.cancel') return executeSparkRecurrenceCancel(command)
      throw new Error('Unsupported Spark command')
    }
    await context()
    const request = parseExecuteCommandRequest({ schemaVersion: 1, command })
    callablePromise ??= connectExecuteCommand(configuration, functionsRegion)
    const response = await (await callablePromise)(request)
    return decodeCommandResult(command, response.data)
  }

  return {
    mode: 'firebase',
    projectId: configuration.projectId,
    app: {
      getCurrentUser: currentUser,
      async updateProfile(command) {
        const result = await execute(command)
        currentUserPromise = undefined
        return result
      },
    },
    groups: {
      async list() {
        const readyContext = context()
        const { db, firestore, userId } = await readyContext
        const projection = await firestore.getDocs(firestore.query(firestore.collection(db, 'users', userId, 'groups'), firestore.limit(100)))
        const groups = await Promise.all(projection.docs.map((membership) => {
          const decodedProjection = decodeGroupProjection(membership.id, membership.data())
          return loadGroup(decodedProjection.groupId, readyContext, decodedProjection)
        }))
        return groups.filter((group): group is NonNullable<typeof group> => group !== undefined).sort((left, right) => left.name.localeCompare(right.name))
      },
      getById: loadGroup,
      async listMembers(groupId) {
        const { db, firestore, userId } = await context()
        const snapshot = await firestore.getDocs(firestore.query(firestore.collection(db, 'groups', groupId, 'members'), firestore.limit(100)))
        return snapshot.docs.map((document) => decodeMember(document.id, document.data(), document.id === userId)).sort((left, right) => left.displayName.localeCompare(right.displayName))
      },
      async getBalanceSnapshot(groupId) {
        const readyContext = context()
        if (functionsRegion) {
          const { db, firestore } = await readyContext
          const snapshot = await firestore.getDoc(firestore.doc(db, 'groups', groupId, 'balance', 'current'))
          if (!snapshot.exists()) throw new Error('Authoritative group balance snapshot is unavailable')
          return decodeBalanceSnapshot(groupId, snapshot.data())
        }
        return getSparkBalanceSnapshot(groupId, readyContext)
      },
      getSettings: getGroupSettings,
      async getTotals(groupId) { const readyContext = context(); return buildCurrencyTotals(await listExpenses(groupId, readyContext), (await readyContext).userId) },
      async getCharts(groupId) { const readyContext = context(); return buildGroupCharts(await listExpenses(groupId, readyContext)) },
      listRecurring,
      async materializeDue(groupId, throughDate, maxOccurrences = 24) {
        assertMaterializationRequest(throughDate, maxOccurrences)
        const templates = [...await listRecurring(groupId)]
        const occurrences: ExpenseRow[] = []
        while (occurrences.length < maxOccurrences) {
          const template = templates.filter((item) => item.status === 'active' && item.nextDate <= throughDate)
            .sort((left, right) => left.nextDate.localeCompare(right.nextDate) || left.id.localeCompare(right.id))[0]
          if (!template) break
          const command: RecurrenceMaterializeCommand = {
            kind: 'recurrence.materialize',
            operationId: await buildSparkMaterializationOperationId(groupId, template.id, template.nextDate),
            groupId, templateId: template.id, occurrenceDate: template.nextDate,
          }
          const result = await execute(command)
          if (result.kind !== 'recurrence.materialize' || result.status !== 'saved') throw new Error('Recurring occurrence could not be materialized')
          occurrences.push(result.occurrence)
          templates[templates.indexOf(template)] = result.template
        }
        const moreRemain = templates.some((template) => template.status === 'active' && template.nextDate <= throughDate)
        return { occurrences, moreRemain }
      },
      setDefaultSplit: execute,
      setSimplifyDebts: execute,
    },
    expenses: {
      listForGroup: listExpenses,
      async getById(groupId, expenseId) {
        const { db, firestore } = await context()
        const snapshot = await firestore.getDoc(firestore.doc(db, 'groups', groupId, 'expenses', expenseId))
        return snapshot.exists() ? resolveSparkExpenseHead(db, firestore, groupId, snapshot.id, snapshot.data()) : undefined
      },
      async add(command) { const result = await execute(command); if (result.kind !== 'expense.add') throw new Error('Unexpected expense result'); return result },
      async edit(command): Promise<ExpenseEditResult> { const result = await execute(command); if (result.kind !== 'expense.edit') throw new Error('Unexpected expense edit result'); return result },
      async delete(command): Promise<ExpenseDeleteResult> { const result = await execute(command); if (result.kind !== 'expense.delete') throw new Error('Unexpected expense delete result'); return result },
      async listRevisions(groupId, expenseId) {
        const { db, firestore } = await context()
        const [root, snapshot] = await Promise.all([
          firestore.getDoc(firestore.doc(db, 'groups', groupId, 'expenses', expenseId)),
          firestore.getDocs(firestore.query(firestore.collection(db, 'groups', groupId, 'expenses', expenseId, 'revisions'), firestore.orderBy('revision', 'asc'), firestore.orderBy(firestore.documentId(), 'asc'), firestore.limit(100))),
        ])
        if (!root.exists()) return []
        const rootData = root.data()
        const creation = decodeExpenseRevision(groupId, expenseId, String(rootData.resourceToken), {
          groupId, expenseId, revision: 1, operationId: rootData.operationId, action: 'created',
          actor: rootData.createdBy, createdAt: rootData.createdAt, expense: rootData,
        })
        return [creation, ...snapshot.docs.map((document) => decodeExpenseRevision(groupId, expenseId, document.id, document.data()))]
      },
    },
    comments: {
      async listForExpense(groupId, expenseId) {
        const { db, firestore } = await context()
        const snapshot = await firestore.getDocs(firestore.query(firestore.collection(db, 'groups', groupId, 'comments'), firestore.where('expenseId', '==', expenseId), firestore.orderBy('createdAt', 'asc'), firestore.orderBy(firestore.documentId(), 'asc'), firestore.limit(100)))
        return snapshot.docs.map((document) => decodeComment(groupId, expenseId, document.id, document.data()))
      },
      async add(command) { const result = await execute(command); if (result.kind !== 'comment.add') throw new Error('Unexpected comment result'); return result },
      async delete(command) { const result = await execute(command); if (result.kind !== 'comment.delete') throw new Error('Unexpected comment delete result'); return result },
    },
    settlements: {
      listForGroup: listSettlements,
      async getById(groupId, settlementId) {
        const { db, firestore } = await context()
        const snapshot = await firestore.getDoc(firestore.doc(db, 'groups', groupId, 'settlements', settlementId))
        return snapshot.exists() ? decodeSettlement(groupId, settlementId, snapshot.data()) : undefined
      },
      async record(command) {
        const result = await execute(command)
        if (result.kind !== 'settlement.record') throw new Error('Unexpected settlement result')
        return result
      },
      async void(command) {
        const result = await execute(command)
        if (result.kind !== 'settlement.void') throw new Error('Unexpected settlement void result')
        return result
      },
    },
    activity: {
      async listForGroup(groupId) {
        const { db, firestore } = await context()
        const snapshot = await firestore.getDocs(firestore.query(firestore.collection(db, 'groups', groupId, 'activity'), firestore.orderBy('createdAt', 'asc'), firestore.orderBy(firestore.documentId(), 'asc'), firestore.limit(100)))
        return snapshot.docs.map((document) => decodeActivity(groupId, document.id, document.data()))
      },
      listForAccount: listAccountActivity,
    },
    notifications: {
      async list(query) {
        if (!functionsRegion) return listSparkNotifications(query)
        const { db, firestore, userId } = await context()
        assertTimelineLimit(query.limit)
        const snapshot = await firestore.getDocs(firestore.query(
          firestore.collection(db, 'users', userId, 'notifications'),
          firestore.orderBy('createdAt', 'desc'),
          firestore.orderBy(firestore.documentId(), 'desc'),
          ...(query.cursor ? [firestore.startAfter(query.cursor.createdAt, query.cursor.id)] : []),
          firestore.limit(query.limit + 1),
        ))
        return serverPage(snapshot.docs.map((document) => decodeNotification(userId, document.id, document.data())), query.limit, (item) => item.notificationId)
      },
      async unreadCount() {
        if (!functionsRegion) return (await listSparkNotifications({ limit: 100 })).items.filter(({ readAt }) => readAt === undefined).length
        const { db, firestore, userId } = await context()
        const cursor = await firestore.getDoc(firestore.doc(db, 'users', userId, 'settings', 'notificationReadCursor'))
        const projected = cursor.exists() ? cursor.data().unreadCount : undefined
        if (Number.isSafeInteger(projected) && projected >= 0) return projected as number
        const snapshot = await firestore.getDocs(firestore.query(firestore.collection(db, 'users', userId, 'notifications'), firestore.where('readAt', '==', null), firestore.limit(100)))
        return snapshot.size
      },
      async markRead(command) { const result = await execute(command); if (result.kind !== 'notification.read') throw new Error('Unexpected notification result'); return result },
      async markAllRead(command) { const result = await execute(command); if (result.kind !== 'notification.read-all') throw new Error('Unexpected notification result'); return result },
      async getPreferences() {
        const { db, firestore, userId } = await context()
        const snapshot = await firestore.getDoc(firestore.doc(db, 'users', userId, 'settings', 'notifications'))
        if (!snapshot.exists()) return { emailEnabled: true, pushEnabled: true }
        const data = snapshot.data()
        if (typeof data.emailEnabled !== 'boolean' || typeof data.pushEnabled !== 'boolean') throw new Error('Notification preferences document is invalid')
        return { emailEnabled: data.emailEnabled, pushEnabled: data.pushEnabled }
      },
      async updatePreferences(command) { const result = await execute(command); if (result.kind !== 'notification.preferences') throw new Error('Unexpected notification preferences result'); return result },
    },
    commands: { execute },
  }
}

async function resolveSparkExpenseHead(
  db: FirebaseClient['db'],
  firestore: FirestoreModule,
  groupId: string,
  expenseId: string,
  head: Readonly<Record<string, unknown>>,
): Promise<ExpenseRow> {
  const root = decodeExpense(groupId, expenseId, head)
  const headRevision = Number.isSafeInteger(head.headRevision) ? Number(head.headRevision) : root.revision
  if (isRecord(head.current)) {
    const current = decodeExpense(groupId, expenseId, head.current)
    if (current.revision !== headRevision || (head.headDeleted === true) !== Boolean(current.deletedAt)) {
      throw new Error('Expense head projection does not match its pointer')
    }
    return current
  }
  if (headRevision === root.revision) return root
  if (headRevision < root.revision || typeof head.lastResourceToken !== 'string') throw new Error('Expense head pointer is invalid')
  const version = await firestore.getDoc(firestore.doc(db, 'groups', groupId, 'expenses', expenseId, 'revisions', head.lastResourceToken))
  if (!version.exists()) throw new Error('Current expense version is unavailable')
  const decoded = decodeExpenseRevision(groupId, expenseId, version.id, version.data())
  if (decoded.revision !== headRevision || (head.headDeleted === true) !== (decoded.action === 'deleted')) throw new Error('Expense head pointer does not match its immutable version')
  return decoded.expense
}

function oldestExpenseFirst(left: ExpenseRow, right: ExpenseRow): number {
  return left.date.localeCompare(right.date) || left.id.localeCompare(right.id)
}

function assertMaterializationRequest(throughDate: string, maxOccurrences: number): void {
  const parsed = new Date(`${throughDate}T00:00:00.000Z`)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(throughDate) || Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== throughDate) {
    throw new Error('Through date must be a valid ISO date')
  }
  if (!Number.isSafeInteger(maxOccurrences) || maxOccurrences < 1 || maxOccurrences > 24) {
    throw new Error('Recurring catch-up limit must be between 1 and 24')
  }
}

function newestActivityFirst(left: ActivityItem, right: ActivityItem): number {
  return descendingText(left.createdAt, right.createdAt) || descendingText(left.id, right.id) || descendingText(left.groupId, right.groupId)
}

function sameExpenseActivity(left: ActivityItem, right: ActivityItem): boolean {
  return left.id === right.id && left.groupId === right.groupId && left.operationId === right.operationId
    && left.kind === right.kind && left.subject.kind === right.subject.kind && left.subject.id === right.subject.id
    && left.subject.label === right.subject.label && left.actor.id === right.actor.id && left.actor.displayName === right.actor.displayName
    && left.expenseId === right.expenseId && left.revision === right.revision && left.createdAt === right.createdAt
}

function activityNotification(principalId: string, activity: ActivityItem, readAt?: string): NotificationItem {
  return {
    notificationId: activity.id, principalId, groupId: activity.groupId, activityId: activity.id,
    kind: activity.kind, subject: { ...activity.subject }, actor: { ...activity.actor }, createdAt: activity.createdAt,
    ...(readAt ? { readAt } : {}), syncState: 'fresh',
  }
}

function firebaseTimestamp(value: unknown, label: string): string {
  const date = typeof value === 'string'
    ? new Date(value)
    : value !== null && typeof value === 'object' && typeof (value as { toDate?: unknown }).toDate === 'function'
      ? (value as { toDate(): Date }).toDate()
      : undefined
  if (!date || Number.isNaN(date.getTime())) throw new Error(`${label} timestamp is invalid`)
  return date.toISOString()
}

function chunk<T>(values: readonly T[], size: number): readonly (readonly T[])[] {
  const chunks: T[][] = []
  for (let index = 0; index < values.length; index += size) chunks.push(values.slice(index, index + size))
  return chunks
}

function settlementBasisMatches(snapshot: GroupBalanceSnapshot, command: SettlementRecordCommand): boolean {
  const debts = command.basis.kind === 'pairwise' ? snapshot.pairwise : snapshot.simplified
  return debts.some((debt) => debt.fromParticipantId === command.basis.senderId
    && debt.toParticipantId === command.basis.recipientId
    && debt.money.currency === command.basis.currency
    && debt.money.minorAmount === command.basis.debtMinor
    && command.money.currency === debt.money.currency
    && command.money.minorAmount <= debt.money.minorAmount)
}

function descendingText(left: string, right: string): number { return left === right ? 0 : left < right ? 1 : -1 }

function decodeGroupSettings(groupId: string, value: unknown): GroupSettings {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.groupId !== groupId || !Number.isSafeInteger(value.revision) || (value.revision as number) < 1) throw new Error('Group settings document is invalid')
  if (value.simplifyDebtsEnabled !== undefined && typeof value.simplifyDebtsEnabled !== 'boolean') throw new Error('Group settings document is invalid')
  const base = { schemaVersion: 1 as const, groupId, revision: value.revision as number, simplifyDebtsEnabled: value.simplifyDebtsEnabled !== false }
  const defaultSplit = value.defaultSplit
  if (defaultSplit === undefined) return base
  try { return { ...base, defaultSplit: decodeDefaultSplit(defaultSplit) } } catch { throw new Error('Group default split is invalid') }
}

function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }

function isFirestorePermissionDenied(error: unknown): boolean {
  if (!isRecord(error)) return false
  return error.code === 'permission-denied' || error.code === 'firestore/permission-denied'
}

function serverPage<T extends ActivityItem | NotificationItem>(values: readonly T[], limit: number, id: (value: T) => string): { items: readonly T[]; nextCursor?: TimelineCursor } {
  const items = values.slice(0, limit)
  if (values.length <= limit) return { items }
  const last = items.at(-1)!
  return { items, nextCursor: { createdAt: last.createdAt, id: id(last) } }
}

function assertTimelineLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Timeline limit must be between 1 and 100')
}

function activityFilterConstraints(firestore: FirestoreModule, filter: ActivityFilter): readonly ReturnType<FirestoreModule['where']>[] {
  if (filter === 'all') return []
  const kinds = filter === 'expenses'
    ? ['expense.created', 'expense.updated', 'expense.deleted']
    : filter === 'comments'
      ? ['comment.added', 'comment.deleted']
      : ['settlement.created', 'settlement.voided']
  return [firestore.where('kind', 'in', kinds)]
}

async function connect(configuration: FirebaseConfiguration): Promise<FirebaseClient> {
  const [app, auth, firestore] = await Promise.all([getSplitUnwiseFirebaseApp(configuration), getSplitUnwiseFirebaseAuth(configuration), import('firebase/firestore')])
  return { auth, db: firestore.getFirestore(app), firestore }
}

async function connectExecuteCommand(configuration: FirebaseConfiguration, region: string): Promise<(request: unknown) => Promise<{ readonly data: unknown }>> {
  const [app, functions] = await Promise.all([getSplitUnwiseFirebaseApp(configuration), import('firebase/functions')])
  const callable = functions.httpsCallable(functions.getFunctions(app, region), 'executeCommand', { limitedUseAppCheckTokens: true })
  return (request) => callable(request)
}

function decodeCommandResult(command: CommandEnvelope, value: unknown): CommandResult {
  if (!isRecord(value) || value.kind !== command.kind || value.operationId !== command.operationId || value.status !== 'saved') throw new Error('Callable command result is invalid')
  return value as unknown as CommandResult
}
