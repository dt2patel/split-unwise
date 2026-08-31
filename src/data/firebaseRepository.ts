import type { FirebaseConfiguration } from './firebase'
import { buildCurrencyTotals, buildGroupCharts } from './aggregates'
import { decodeActivity, decodeBalanceSnapshot, decodeComment, decodeExpense, decodeExpenseRevision, decodeGroup, decodeGroupProjection, decodeMember, decodeNotification, decodeRecurringExpense, decodeSettlement } from './firebaseDecoders'
import { resolveFirebaseSession } from './firebaseSession'
import type { ActivityFilter, ActivityItem, AppRepository, CommandEnvelope, CommandResult, ExpenseDeleteResult, ExpenseEditResult, ExpenseRow, Member, NotificationItem, TimelineCursor } from './repositories'
import { decodeDefaultSplit, type GroupSettings } from '../domain/groupSettings'

type FirestoreModule = typeof import('firebase/firestore')
type AuthModule = typeof import('firebase/auth')
type FirebaseClient = { readonly auth: ReturnType<AuthModule['getAuth']>; readonly db: ReturnType<FirestoreModule['getFirestore']>; readonly firestore: FirestoreModule }
type FirebaseContext = FirebaseClient & { readonly userId: string }

/** Firebase facade: SDK modules are loaded only on the first actual repository call. */
export function createFirebaseRepository(configuration: FirebaseConfiguration, expectedUserId?: string): AppRepository {
  let clientPromise: Promise<FirebaseClient> | undefined
  const client = () => clientPromise ??= connect(configuration)

  async function context(): Promise<FirebaseContext> {
    const firebase = await client()
    const { userId } = await resolveFirebaseSession(firebase.auth)
    if (expectedUserId !== undefined && userId !== expectedUserId) throw new Error('Firebase authenticated principal changed')
    return { ...firebase, userId }
  }
  async function currentUser(): Promise<Member> {
    const { db, firestore, userId } = await context()
    const snapshot = await firestore.getDoc(firestore.doc(db, 'users', userId))
    if (!snapshot.exists()) throw new Error('Current Firebase user profile is missing')
    return decodeMember(userId, snapshot.data(), true)
  }
  async function listExpenses(groupId: string, readyContext = context()): Promise<readonly ExpenseRow[]> {
    const { db, firestore } = await readyContext
    const snapshot = await firestore.getDocs(firestore.query(firestore.collection(db, 'groups', groupId, 'expenses'), firestore.orderBy('date', 'asc')))
    return snapshot.docs.map((document) => decodeExpense(groupId, document.id, document.data())).filter(({ deletedAt }) => deletedAt === undefined)
  }

  async function execute(command: CommandEnvelope): Promise<CommandResult> {
    return { kind: command.kind, operationId: command.operationId, status: 'not-supported', reason: 'Secure financial writes require the authenticated callable service configured in Task 11.' } as CommandResult
  }

  return {
    mode: 'firebase',
    projectId: configuration.projectId,
    app: { getCurrentUser: currentUser, updateProfile: execute },
    groups: {
      async list() {
        const { db, firestore, userId } = await context()
        const projection = await firestore.getDocs(firestore.collection(db, 'users', userId, 'groups'))
        const groups = await Promise.all(projection.docs.map(async (membership) => {
          const groupId = decodeGroupProjection(membership.id, membership.data())
          const group = await firestore.getDoc(firestore.doc(db, 'groups', groupId))
          return group.exists() ? decodeGroup(group.id, group.data()) : undefined
        }))
        return groups.filter((group): group is NonNullable<typeof group> => group !== undefined).sort((left, right) => left.name.localeCompare(right.name))
      },
      async getById(groupId) {
        const { db, firestore } = await context()
        const snapshot = await firestore.getDoc(firestore.doc(db, 'groups', groupId))
        return snapshot.exists() ? decodeGroup(snapshot.id, snapshot.data()) : undefined
      },
      async listMembers(groupId) {
        const { db, firestore, userId } = await context()
        const snapshot = await firestore.getDocs(firestore.collection(db, 'groups', groupId, 'members'))
        return snapshot.docs.map((document) => decodeMember(document.id, document.data(), document.id === userId)).sort((left, right) => left.displayName.localeCompare(right.displayName))
      },
      async getBalanceSnapshot(groupId) {
        const { db, firestore } = await context()
        const snapshot = await firestore.getDoc(firestore.doc(db, 'groups', groupId, 'balance', 'current'))
        if (!snapshot.exists()) throw new Error('Authoritative group balance snapshot is unavailable')
        return decodeBalanceSnapshot(groupId, snapshot.data())
      },
      async getSettings(groupId) {
        const { db, firestore } = await context()
        const snapshot = await firestore.getDoc(firestore.doc(db, 'groups', groupId, 'settings', 'defaults'))
        return snapshot.exists() ? decodeGroupSettings(groupId, snapshot.data()) : { schemaVersion: 1, groupId, revision: 1 }
      },
      async getTotals(groupId) { const readyContext = context(); return buildCurrencyTotals(await listExpenses(groupId, readyContext), (await readyContext).userId) },
      async getCharts(groupId) { const readyContext = context(); return buildGroupCharts(await listExpenses(groupId, readyContext)) },
      async listRecurring(groupId) {
        const { db, firestore } = await context()
        const snapshot = await firestore.getDocs(firestore.collection(db, 'groups', groupId, 'recurring'))
        return snapshot.docs.map((document) => decodeRecurringExpense(groupId, document.id, document.data()))
      },
      setDefaultSplit: execute,
    },
    expenses: {
      listForGroup: listExpenses,
      async getById(groupId, expenseId) {
        const { db, firestore } = await context()
        const snapshot = await firestore.getDoc(firestore.doc(db, 'groups', groupId, 'expenses', expenseId))
        return snapshot.exists() ? decodeExpense(groupId, snapshot.id, snapshot.data()) : undefined
      },
      async add(command) { const result = await execute(command); if (result.kind !== 'expense.add') throw new Error('Unexpected expense result'); return result },
      async edit(command): Promise<ExpenseEditResult> { const result = await execute(command); if (result.kind !== 'expense.edit') throw new Error('Unexpected expense edit result'); return result },
      async delete(command): Promise<ExpenseDeleteResult> { const result = await execute(command); if (result.kind !== 'expense.delete') throw new Error('Unexpected expense delete result'); return result },
      async listRevisions(groupId, expenseId) {
        const { db, firestore } = await context()
        const snapshot = await firestore.getDocs(firestore.query(firestore.collection(db, 'groups', groupId, 'expenses', expenseId, 'revisions'), firestore.orderBy('revision', 'asc'), firestore.orderBy(firestore.documentId(), 'asc')))
        return snapshot.docs.map((document) => decodeExpenseRevision(groupId, expenseId, document.id, document.data()))
      },
    },
    comments: {
      async listForExpense(groupId, expenseId) {
        const { db, firestore } = await context()
        const snapshot = await firestore.getDocs(firestore.query(firestore.collection(db, 'groups', groupId, 'comments'), firestore.where('expenseId', '==', expenseId), firestore.orderBy('createdAt', 'asc'), firestore.orderBy(firestore.documentId(), 'asc')))
        return snapshot.docs.map((document) => decodeComment(groupId, expenseId, document.id, document.data()))
      },
      async add(command) { const result = await execute(command); if (result.kind !== 'comment.add') throw new Error('Unexpected comment result'); return result },
      async delete(command) { const result = await execute(command); if (result.kind !== 'comment.delete') throw new Error('Unexpected comment delete result'); return result },
    },
    settlements: {
      async listForGroup(groupId) {
        const { db, firestore } = await context()
        const snapshot = await firestore.getDocs(firestore.query(
          firestore.collection(db, 'groups', groupId, 'settlements'),
          firestore.orderBy('occurredOn', 'asc'),
          firestore.orderBy(firestore.documentId(), 'asc'),
        ))
        return snapshot.docs.map((document) => decodeSettlement(groupId, document.id, document.data()))
      },
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
        const snapshot = await firestore.getDocs(firestore.query(firestore.collection(db, 'groups', groupId, 'activity'), firestore.orderBy('createdAt', 'asc'), firestore.orderBy(firestore.documentId(), 'asc')))
        return snapshot.docs.map((document) => decodeActivity(groupId, document.id, document.data()))
      },
      async listForAccount(query) {
        const { db, firestore, userId } = await context()
        assertTimelineLimit(query.limit)
        const constraints = [
          ...activityFilterConstraints(firestore, query.filter),
          firestore.orderBy('createdAt', 'desc'),
          firestore.orderBy(firestore.documentId(), 'desc'),
          ...(query.cursor ? [firestore.startAfter(query.cursor.createdAt, query.cursor.id)] : []),
          firestore.limit(query.limit + 1),
        ]
        const snapshot = await firestore.getDocs(firestore.query(firestore.collection(db, 'users', userId, 'activity'), ...constraints))
        const decoded = snapshot.docs.map((document) => decodeActivity(String(document.data().groupId ?? ''), document.id, document.data()))
        return serverPage(decoded, query.limit, (item) => item.id)
      },
    },
    notifications: {
      async list(query) {
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
        const { db, firestore, userId } = await context()
        const snapshot = await firestore.getDocs(firestore.query(firestore.collection(db, 'users', userId, 'notifications'), firestore.where('readAt', '==', null)))
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

function decodeGroupSettings(groupId: string, value: unknown): GroupSettings {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.groupId !== groupId || !Number.isSafeInteger(value.revision) || (value.revision as number) < 1) throw new Error('Group settings document is invalid')
  const defaultSplit = value.defaultSplit
  if (defaultSplit === undefined) return { schemaVersion: 1, groupId, revision: value.revision as number }
  try { return { schemaVersion: 1, groupId, revision: value.revision as number, defaultSplit: decodeDefaultSplit(defaultSplit) } } catch { throw new Error('Group default split is invalid') }
}

function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }

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
  const [appModule, authModule, firestore] = await Promise.all([import('firebase/app'), import('firebase/auth'), import('firebase/firestore')])
  const app = appModule.getApps().find((candidate) => candidate.options.projectId === configuration.projectId) ?? appModule.initializeApp(configuration, `split-unwise-${configuration.projectId}`)
  return { auth: authModule.getAuth(app), db: firestore.getFirestore(app), firestore }
}
