import { computeBalances, simplifyDebts } from '../domain/balances'
import type { FirebaseConfiguration } from './firebase'
import { buildCurrencyTotals, buildGroupCharts } from './aggregates'
import { decodeActivity, decodeComment, decodeExpense, decodeGroup, decodeGroupProjection, decodeMember, decodeRecurringExpense } from './firebaseDecoders'
import { resolveFirebaseSession } from './firebaseSession'
import type { AppRepository, CommandEnvelope, CommandResult, ExpenseAddResult, ExpenseDeleteResult, ExpenseEditResult, ExpenseRow, Member } from './repositories'

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
    return snapshot.docs.map((document) => decodeExpense(groupId, document.id, document.data()))
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
      async getById(groupId, expenseId) {
        const { db, firestore } = await context()
        const snapshot = await firestore.getDoc(firestore.doc(db, 'groups', groupId, 'expenses', expenseId))
        return snapshot.exists() ? decodeExpense(groupId, snapshot.id, snapshot.data()) : undefined
      },
      async add(command) { const result = await execute(command); if (result.kind !== 'expense.add') throw new Error('Unexpected expense result'); return result },
      async edit(command): Promise<ExpenseEditResult> { const result = await execute(command); if (result.kind !== 'expense.edit') throw new Error('Unexpected expense edit result'); return result },
      async delete(command): Promise<ExpenseDeleteResult> { const result = await execute(command); if (result.kind !== 'expense.delete') throw new Error('Unexpected expense delete result'); return result },
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
