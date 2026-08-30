import { computeBalances, simplifyDebts } from '../domain/balances'
import type { FirebaseConfiguration } from './firebase'
import { buildCurrencyTotals, buildGroupCharts } from './aggregates'
import { decodeActivity, decodeComment, decodeExpense, decodeGroup, decodeGroupProjection, decodeMember, decodeRecurringExpense } from './firebaseDecoders'
import { assertReplayIdentity, createOperationIdentity, type OperationIdentity } from './operationIdentity'
import { resolveFirebaseSession } from './firebaseSession'
import type { AppRepository, CommandEnvelope, CommandResult, ExpenseAddResult, ExpenseRow, Member } from './repositories'

type FirestoreModule = typeof import('firebase/firestore')
type AuthModule = typeof import('firebase/auth')
type FirebaseClient = { readonly auth: ReturnType<AuthModule['getAuth']>; readonly db: ReturnType<FirestoreModule['getFirestore']>; readonly firestore: FirestoreModule }
type FirebaseContext = FirebaseClient & { readonly userId: string }

/** Firebase facade: SDK modules are loaded only on the first actual repository call. */
export function createFirebaseRepository(configuration: FirebaseConfiguration): AppRepository {
  let clientPromise: Promise<FirebaseClient> | undefined
  const client = () => clientPromise ??= connect(configuration)

  async function context(): Promise<FirebaseContext> {
    const firebase = await client()
    const { userId } = await resolveFirebaseSession(firebase.auth)
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
    return snapshot.docs.map((document) => decodeExpense(groupId, document.id, document.data()))
  }

  async function execute(command: CommandEnvelope): Promise<CommandResult> {
    if (command.kind === 'expense.add') return executeExpenseAdd(command)
    return executeNotSupported(command)
  }
  async function executeExpenseAdd(command: Extract<CommandEnvelope, { kind: 'expense.add' }>): Promise<ExpenseAddResult> {
    const readyContext = await context()
    const identity = await createOperationIdentity(readyContext.userId, command)
    const { db, firestore, userId } = readyContext
    const ledger = firestore.doc(db, 'users', userId, 'operations', command.operationId)
    return firestore.runTransaction(db, async (transaction) => {
      const previous = await transaction.get(ledger)
      if (previous.exists()) {
        const result = await resultFromLedger(command, identity, previous.data())
        if (result.kind !== 'expense.add') throw new Error('Operation ledger returned an incompatible result')
        return result
      }
      const expenseId = identity.resourceId
      const createdAt = `${command.date}T12:00:00.000Z`
      const raw = { groupId: command.groupId, description: command.description, date: command.date, total: command.total, payerId: command.payerId, allocations: command.allocations, category: command.category, createdAt, ...(command.recurringTemplateId ? { recurringTemplateId: command.recurringTemplateId } : {}) }
      const expense = decodeExpense(command.groupId, expenseId, raw)
      const result: ExpenseAddResult = { kind: 'expense.add', operationId: command.operationId, status: 'saved', expense }
      transaction.set(firestore.doc(db, 'groups', command.groupId, 'expenses', expenseId), raw)
      transaction.set(ledger, { identity, result: { kind: result.kind, operationId: result.operationId, status: result.status, expenseId, expense: raw } })
      return result
    })
  }
  async function executeNotSupported(command: Exclude<CommandEnvelope, { kind: 'expense.add' }>): Promise<CommandResult> {
    const readyContext = await context()
    const identity = await createOperationIdentity(readyContext.userId, command)
    const { db, firestore, userId } = readyContext
    const ledger = firestore.doc(db, 'users', userId, 'operations', command.operationId)
    return firestore.runTransaction(db, async (transaction) => {
      const previous = await transaction.get(ledger)
      if (previous.exists()) return resultFromLedger(command, identity, previous.data())
      const result: CommandResult = { kind: command.kind, operationId: command.operationId, status: 'not-supported', reason: 'This Firebase mutation is not implemented yet.' }
      transaction.set(ledger, { identity, result })
      return result
    })
  }

  return {
    mode: 'firebase',
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
      async getBalances(groupId) { const readyContext = context(); return simplifyDebts(computeBalances(await listExpenses(groupId, readyContext))) },
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
      async add(command) { const result = await execute(command); if (result.kind !== 'expense.add') throw new Error('Unexpected expense result'); return result },
      edit: execute,
      delete: execute,
      async listComments(groupId, expenseId) {
        const { db, firestore } = await context()
        const snapshot = await firestore.getDocs(firestore.query(firestore.collection(db, 'groups', groupId, 'comments'), firestore.where('expenseId', '==', expenseId), firestore.orderBy('createdAt', 'asc')))
        return snapshot.docs.map((document) => decodeComment(expenseId, document.id, document.data()))
      },
    },
    comments: { add: execute },
    settlements: { record: execute },
    activity: {
      async listForGroup(groupId) {
        const { db, firestore } = await context()
        const snapshot = await firestore.getDocs(firestore.query(firestore.collection(db, 'groups', groupId, 'activity'), firestore.orderBy('createdAt', 'asc')))
        return snapshot.docs.map((document) => decodeActivity(groupId, document.id, document.data()))
      },
    },
    commands: { execute },
  }
}

async function connect(configuration: FirebaseConfiguration): Promise<FirebaseClient> {
  const [appModule, authModule, firestore] = await Promise.all([import('firebase/app'), import('firebase/auth'), import('firebase/firestore')])
  const app = appModule.getApps().find((candidate) => candidate.options.projectId === configuration.projectId) ?? appModule.initializeApp(configuration, `split-unwise-${configuration.projectId}`)
  return { auth: authModule.getAuth(app), db: firestore.getFirestore(app), firestore }
}

async function resultFromLedger(command: CommandEnvelope, requestedIdentity: OperationIdentity, value: unknown): Promise<CommandResult> {
  const data = record(value, 'operation ledger')
  await assertReplayIdentity(decodeIdentity(data.identity), requestedIdentity)
  const result = record(data.result, 'operation ledger result')
  if (result.operationId !== command.operationId || result.kind !== command.kind) throw new Error('Operation ledger result does not match request')
  if (result.status === 'not-supported') return { kind: command.kind, operationId: command.operationId, status: 'not-supported', reason: requiredString(result.reason, 'operation ledger reason') }
  if (result.status !== 'saved') throw new Error('Operation ledger result has invalid status')
  if (command.kind === 'expense.add') return { kind: command.kind, operationId: command.operationId, status: 'saved', expense: decodeExpense(command.groupId, requiredString(result.expenseId, 'operation ledger expenseId'), result.expense) }
  const resourceId = requiredString(result.resourceId, 'operation ledger resourceId')
  switch (command.kind) {
    case 'comment.add': return { kind: command.kind, operationId: command.operationId, status: 'saved', resourceId }
    case 'expense.delete': return { kind: command.kind, operationId: command.operationId, status: 'saved', resourceId }
    case 'expense.edit': return { kind: command.kind, operationId: command.operationId, status: 'saved', resourceId }
    case 'group.default-split': return { kind: command.kind, operationId: command.operationId, status: 'saved', resourceId }
    case 'profile.update': return { kind: command.kind, operationId: command.operationId, status: 'saved', resourceId }
    case 'settlement.record': return { kind: command.kind, operationId: command.operationId, status: 'saved', resourceId }
  }
}
function decodeIdentity(value: unknown): OperationIdentity {
  const data = record(value, 'operation ledger identity')
  const groupId = data.groupId === null ? null : requiredString(data.groupId, 'operation ledger groupId')
  return {
    userId: requiredString(data.userId, 'operation ledger userId'), operationId: requiredString(data.operationId, 'operation ledger operationId'), kind: requiredCommandKind(data.kind), groupId,
    requestFingerprint: requiredString(data.requestFingerprint, 'operation ledger request fingerprint'), resourceId: requiredString(data.resourceId, 'operation ledger resource ID'),
  }
}
function requiredCommandKind(value: unknown): CommandEnvelope['kind'] {
  if (value === 'comment.add' || value === 'expense.add' || value === 'expense.delete' || value === 'expense.edit' || value === 'group.default-split' || value === 'profile.update' || value === 'settlement.record') return value
  throw new Error('operation ledger kind is invalid')
}
function record(value: unknown, path: string): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path} must be an object`); return value as Record<string, unknown> }
function requiredString(value: unknown, path: string): string { if (typeof value !== 'string' || !value) throw new Error(`${path} must be a string`); return value }
