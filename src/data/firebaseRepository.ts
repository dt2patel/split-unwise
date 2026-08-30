import { computeBalances, simplifyDebts } from '../domain/balances'
import type { FirebaseConfiguration } from './firebase'
import { decodeActivity, decodeComment, decodeExpense, decodeGroup, decodeGroupProjection, decodeMember, decodeRecurringExpense } from './firebaseDecoders'
import type { AppRepository, CommandEnvelope, CommandResult, CurrencyTotals, ExpenseAddResult, ExpenseRow, GroupCharts, Member } from './repositories'

type FirestoreModule = typeof import('firebase/firestore')
type AuthModule = typeof import('firebase/auth')
type FirebaseClient = { readonly auth: ReturnType<AuthModule['getAuth']>; readonly db: ReturnType<FirestoreModule['getFirestore']>; readonly firestore: FirestoreModule }

/** Firebase facade: SDK modules are loaded only on the first actual repository call. */
export function createFirebaseRepository(configuration: FirebaseConfiguration): AppRepository {
  let clientPromise: Promise<FirebaseClient> | undefined
  const client = () => clientPromise ??= connect(configuration)

  async function authenticatedUserId(): Promise<string> {
    const { auth } = await client()
    await auth.authStateReady()
    if (!auth.currentUser) throw new Error('A signed-in Firebase user is required')
    return auth.currentUser.uid
  }
  async function currentUser(): Promise<Member> {
    const { db, firestore } = await client()
    const userId = await authenticatedUserId()
    const snapshot = await firestore.getDoc(firestore.doc(db, 'users', userId))
    if (!snapshot.exists()) throw new Error('Current Firebase user profile is missing')
    return decodeMember(userId, snapshot.data(), true)
  }
  async function listExpenses(groupId: string): Promise<readonly ExpenseRow[]> {
    const { db, firestore } = await client()
    const snapshot = await firestore.getDocs(firestore.query(firestore.collection(db, 'groups', groupId, 'expenses'), firestore.orderBy('date', 'asc')))
    return snapshot.docs.map((document) => decodeExpense(groupId, document.id, document.data()))
  }

  async function execute(command: CommandEnvelope): Promise<CommandResult> {
    if (command.kind === 'expense.add') return executeExpenseAdd(command)
    return executeNotSupported(command)
  }
  async function executeExpenseAdd(command: Extract<CommandEnvelope, { kind: 'expense.add' }>): Promise<ExpenseAddResult> {
    const { db, firestore } = await client()
    const userId = await authenticatedUserId()
    const ledger = firestore.doc(db, 'users', userId, 'operations', ledgerId(command.operationId))
    return firestore.runTransaction(db, async (transaction) => {
      const previous = await transaction.get(ledger)
      if (previous.exists()) {
        const result = resultFromLedger(command, previous.data())
        if (result.kind !== 'expense.add') throw new Error('Operation ledger returned an incompatible result')
        return result
      }
      const expenseId = `operation-${ledgerId(command.operationId)}`
      const createdAt = `${command.date}T12:00:00.000Z`
      const raw = { groupId: command.groupId, description: command.description, date: command.date, total: command.total, payerId: command.payerId, allocations: command.allocations, category: command.category, createdAt, ...(command.recurringTemplateId ? { recurringTemplateId: command.recurringTemplateId } : {}) }
      const expense = decodeExpense(command.groupId, expenseId, raw)
      const result: ExpenseAddResult = { kind: 'expense.add', operationId: command.operationId, status: 'saved', expense }
      transaction.set(firestore.doc(db, 'groups', command.groupId, 'expenses', expenseId), raw)
      transaction.set(ledger, { operationId: command.operationId, kind: command.kind, result: { kind: result.kind, operationId: result.operationId, status: result.status, expenseId, expense: raw } })
      return result
    })
  }
  async function executeNotSupported(command: Exclude<CommandEnvelope, { kind: 'expense.add' }>): Promise<CommandResult> {
    const { db, firestore } = await client()
    const userId = await authenticatedUserId()
    const ledger = firestore.doc(db, 'users', userId, 'operations', ledgerId(command.operationId))
    return firestore.runTransaction(db, async (transaction) => {
      const previous = await transaction.get(ledger)
      if (previous.exists()) return resultFromLedger(command, previous.data())
      const result: CommandResult = { kind: command.kind, operationId: command.operationId, status: 'not-supported', reason: 'This Firebase mutation is not implemented yet.' }
      transaction.set(ledger, { operationId: command.operationId, kind: command.kind, result })
      return result
    })
  }

  return {
    mode: 'firebase',
    app: { getCurrentUser: currentUser, updateProfile: execute },
    groups: {
      async list() {
        const { db, firestore } = await client()
        const userId = await authenticatedUserId()
        const projection = await firestore.getDocs(firestore.collection(db, 'users', userId, 'groups'))
        const groups = await Promise.all(projection.docs.map(async (membership) => {
          const groupId = decodeGroupProjection(membership.id, membership.data())
          const group = await firestore.getDoc(firestore.doc(db, 'groups', groupId))
          return group.exists() ? decodeGroup(group.id, group.data()) : undefined
        }))
        return groups.filter((group): group is NonNullable<typeof group> => group !== undefined).sort((left, right) => left.name.localeCompare(right.name))
      },
      async getById(groupId) {
        const { db, firestore } = await client()
        const snapshot = await firestore.getDoc(firestore.doc(db, 'groups', groupId))
        return snapshot.exists() ? decodeGroup(snapshot.id, snapshot.data()) : undefined
      },
      async listMembers(groupId) {
        const { db, firestore } = await client()
        const userId = await authenticatedUserId()
        const snapshot = await firestore.getDocs(firestore.collection(db, 'groups', groupId, 'members'))
        return snapshot.docs.map((document) => decodeMember(document.id, document.data(), document.id === userId)).sort((left, right) => left.displayName.localeCompare(right.displayName))
      },
      async getBalances(groupId) { return simplifyDebts(computeBalances(await listExpenses(groupId))) },
      async getTotals(groupId) { return totalsFor(await listExpenses(groupId), (await currentUser()).id) },
      async getCharts(groupId): Promise<GroupCharts> { return chartsFor(await listExpenses(groupId)) },
      async listRecurring(groupId) {
        const { db, firestore } = await client()
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
        const { db, firestore } = await client()
        const snapshot = await firestore.getDocs(firestore.query(firestore.collection(db, 'groups', groupId, 'comments'), firestore.where('expenseId', '==', expenseId), firestore.orderBy('createdAt', 'asc')))
        return snapshot.docs.map((document) => decodeComment(expenseId, document.id, document.data()))
      },
    },
    comments: { add: execute },
    settlements: { record: execute },
    activity: {
      async listForGroup(groupId) {
        const { db, firestore } = await client()
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

function resultFromLedger(command: CommandEnvelope, value: unknown): CommandResult {
  const data = record(value, 'operation ledger')
  const result = record(data.result, 'operation ledger result')
  if (result.operationId !== command.operationId || result.kind !== command.kind) throw new Error('Operation ledger result does not match request')
  if (result.status === 'not-supported') return { kind: command.kind, operationId: command.operationId, status: 'not-supported', reason: requiredString(result.reason, 'operation ledger reason') }
  if (result.status !== 'saved') throw new Error('Operation ledger result has invalid status')
  if (command.kind === 'expense.add') return { kind: command.kind, operationId: command.operationId, status: 'saved', expense: decodeExpense(command.groupId, requiredString(result.expenseId, 'operation ledger expenseId'), result.expense) }
  return { kind: command.kind, operationId: command.operationId, status: 'saved', resourceId: requiredString(result.resourceId, 'operation ledger resourceId') } as CommandResult
}
function totalsFor(rows: readonly ExpenseRow[], currentUserId: string): readonly CurrencyTotals[] {
  return [...new Set(rows.map((row) => row.total.currency))].sort().map((currency) => {
    const matching = rows.filter((row) => row.total.currency === currency)
    const currentUserPaid = matching.filter((row) => row.payerId === currentUserId).reduce((total, row) => total + row.total.minorAmount, 0)
    const currentUserShare = matching.reduce((total, row) => total + (row.allocations.find(({ participantId }) => participantId === currentUserId)?.money.minorAmount ?? 0), 0)
    return { currency, totalPaid: matching.reduce((total, row) => total + row.total.minorAmount, 0), currentUserPaid, currentUserShare, currentUserNet: currentUserPaid - currentUserShare }
  })
}
function chartsFor(rows: readonly ExpenseRow[]): GroupCharts {
  const sum = (key: (row: ExpenseRow) => string, sortByAmount: boolean) => {
    const totals = new Map<string, number>()
    rows.forEach((row) => { const id = `${row.total.currency}\u0000${key(row)}`; totals.set(id, (totals.get(id) ?? 0) + row.total.minorAmount) })
    return [...totals].map(([id, amount]) => { const [currency, name] = id.split('\u0000'); return [currency as ExpenseRow['total']['currency'], name, amount] as const }).sort(([a, b, c], [d, e, f]) => a.localeCompare(d) || (sortByAmount ? f - c : 0) || b.localeCompare(e))
  }
  return { categorySpending: sum((row) => row.category, true).map(([currency, category, minorAmount]) => ({ currency, category, minorAmount })), dailySpending: sum((row) => row.date, false).map(([currency, date, minorAmount]) => ({ currency, date, minorAmount })) }
}
function ledgerId(operationId: string): string { return encodeURIComponent(operationId) }
function record(value: unknown, path: string): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path} must be an object`); return value as Record<string, unknown> }
function requiredString(value: unknown, path: string): string { if (typeof value !== 'string' || !value) throw new Error(`${path} must be a string`); return value }
