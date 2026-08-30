import { computeBalances, simplifyDebts } from '../domain/balances'
import type { FirebaseConfiguration } from './firebase'
import type {
  ActivityItem,
  AppRepository,
  ExpenseComment,
  ExpenseDraft,
  ExpenseRow,
  Group,
  GroupCharts,
  GroupTotals,
  Member,
  RecurringExpense,
} from './repositories'

type FirestoreModule = typeof import('firebase/firestore')
type AuthModule = typeof import('firebase/auth')
type FirebaseClient = {
  readonly auth: ReturnType<AuthModule['getAuth']>
  readonly db: ReturnType<FirestoreModule['getFirestore']>
  readonly firestore: FirestoreModule
}

/**
 * Firebase facade that loads SDK modules only on first repository call. Creating
 * this adapter never initializes Firebase or opens a connection.
 */
export function createFirebaseRepository(configuration: FirebaseConfiguration): AppRepository {
  let clientPromise: Promise<FirebaseClient> | undefined
  const client = () => clientPromise ??= connect(configuration)

  async function currentUser(): Promise<Member> {
    const { auth, db, firestore } = await client()
    const user = auth.currentUser
    if (!user) throw new Error('A signed-in Firebase user is required')
    const snapshot = await firestore.getDoc(firestore.doc(db, 'users', user.uid))
    const profile = snapshot.data() ?? {}
    return {
      id: user.uid,
      displayName: stringValue(profile.displayName, user.displayName ?? 'Unnamed member'),
      initials: stringValue(profile.initials, initials(user.displayName ?? 'Unnamed member')),
      ...(typeof profile.avatarUrl === 'string' ? { avatarUrl: profile.avatarUrl } : {}),
      isCurrentUser: true,
    }
  }

  async function listExpenses(groupId: string): Promise<readonly ExpenseRow[]> {
    const { db, firestore } = await client()
    const snapshot = await firestore.getDocs(firestore.query(
      firestore.collection(db, 'groups', groupId, 'expenses'),
      firestore.orderBy('date', 'asc'),
    ))
    return snapshot.docs.map((document) => expenseFromData(groupId, document.id, document.data()))
  }

  async function totals(groupId: string): Promise<GroupTotals> {
    const [rows, user] = await Promise.all([listExpenses(groupId), currentUser()])
    const currentUserPaid = rows.filter((row) => row.payerId === user.id).reduce((total, row) => total + row.total.minorAmount, 0)
    const currentUserShare = rows.reduce((total, row) => total + (row.allocations.find(({ participantId }) => participantId === user.id)?.money.minorAmount ?? 0), 0)
    return {
      currency: rows[0]?.total.currency ?? 'USD',
      totalPaid: rows.reduce((total, row) => total + row.total.minorAmount, 0),
      currentUserPaid,
      currentUserShare,
      currentUserNet: currentUserPaid - currentUserShare,
    }
  }

  return {
    mode: 'firebase',
    app: { getCurrentUser: currentUser },
    groups: {
      async list(): Promise<readonly Group[]> {
        const { db, firestore } = await client()
        const user = await currentUser()
        const projection = await firestore.getDocs(firestore.collection(db, 'users', user.id, 'groups'))
        const groups = await Promise.all(projection.docs.map(async (membership) => {
          const groupId = stringValue(membership.data().groupId, membership.id)
          const group = await firestore.getDoc(firestore.doc(db, 'groups', groupId))
          return group.exists() ? groupFromData(group.id, group.data()) : undefined
        }))
        return groups.filter((group): group is Group => group !== undefined).sort((left, right) => left.name.localeCompare(right.name))
      },
      async getById(groupId): Promise<Group | undefined> {
        const { db, firestore } = await client()
        const snapshot = await firestore.getDoc(firestore.doc(db, 'groups', groupId))
        return snapshot.exists() ? groupFromData(snapshot.id, snapshot.data()) : undefined
      },
      async listMembers(groupId): Promise<readonly Member[]> {
        const { db, firestore } = await client()
        const user = await currentUser()
        const snapshot = await firestore.getDocs(firestore.collection(db, 'groups', groupId, 'members'))
        return snapshot.docs.map((document) => memberFromData(document.id, document.data(), document.id === user.id))
          .sort((left, right) => left.displayName.localeCompare(right.displayName))
      },
      async getBalances(groupId) { return simplifyDebts(computeBalances(await listExpenses(groupId))) },
      async getTotals(groupId) { return totals(groupId) },
      async getCharts(groupId): Promise<GroupCharts> {
        const rows = await listExpenses(groupId)
        return {
          categorySpending: sumRows(rows, (row) => row.category).map(([category, minorAmount]) => ({ category, minorAmount })),
          dailySpending: sumRows(rows, (row) => row.date).map(([date, minorAmount]) => ({ date, minorAmount })),
        }
      },
      async listRecurring(groupId): Promise<readonly RecurringExpense[]> {
        const { db, firestore } = await client()
        const snapshot = await firestore.getDocs(firestore.collection(db, 'groups', groupId, 'recurring'))
        return snapshot.docs.map((document) => recurringFromData(groupId, document.id, document.data()))
      },
    },
    expenses: {
      listForGroup: listExpenses,
      async add(draft: ExpenseDraft): Promise<ExpenseRow> {
        const { db, firestore } = await client()
        const document = await firestore.addDoc(firestore.collection(db, 'groups', draft.groupId, 'expenses'), {
          ...draft,
          total: { ...draft.total },
          allocations: draft.allocations.map((allocation) => ({ participantId: allocation.participantId, money: { ...allocation.money } })),
          createdAt: `${draft.date}T12:00:00.000Z`,
        })
        return expenseFromData(draft.groupId, document.id, { ...draft, createdAt: `${draft.date}T12:00:00.000Z` })
      },
      async listComments(groupId, expenseId): Promise<readonly ExpenseComment[]> {
        const { db, firestore } = await client()
        const snapshot = await firestore.getDocs(firestore.query(
          firestore.collection(db, 'groups', groupId, 'comments'),
          firestore.where('expenseId', '==', expenseId),
          firestore.orderBy('createdAt', 'asc'),
        ))
        return snapshot.docs.map((document) => commentFromData(expenseId, document.id, document.data()))
      },
    },
    activity: {
      async listForGroup(groupId): Promise<readonly ActivityItem[]> {
        const { db, firestore } = await client()
        const snapshot = await firestore.getDocs(firestore.query(
          firestore.collection(db, 'groups', groupId, 'activity'),
          firestore.orderBy('createdAt', 'asc'),
        ))
        return snapshot.docs.map((document) => activityFromData(groupId, document.id, document.data()))
      },
    },
  }
}

async function connect(configuration: FirebaseConfiguration): Promise<FirebaseClient> {
  const [appModule, authModule, firestore] = await Promise.all([
    import('firebase/app'),
    import('firebase/auth'),
    import('firebase/firestore'),
  ])
  const app = appModule.getApps().find((candidate) => candidate.options.projectId === configuration.projectId)
    ?? appModule.initializeApp(configuration, `split-unwise-${configuration.projectId}`)
  return { auth: authModule.getAuth(app), db: firestore.getFirestore(app), firestore }
}

function groupFromData(id: string, data: Record<string, unknown>): Group {
  return {
    id,
    name: stringValue(data.name, id),
    currency: stringValue(data.currency, 'USD') as Group['currency'],
    ...(typeof data.coverImageUrl === 'string' ? { coverImageUrl: data.coverImageUrl } : {}),
    memberIds: stringArray(data.memberIds),
    syncState: 'fresh',
  }
}

function memberFromData(id: string, data: Record<string, unknown>, isCurrentUser: boolean): Member {
  const displayName = stringValue(data.displayName, id)
  return { id, displayName, initials: stringValue(data.initials, initials(displayName)), ...(typeof data.avatarUrl === 'string' ? { avatarUrl: data.avatarUrl } : {}), isCurrentUser }
}

function expenseFromData(groupId: string, id: string, data: Record<string, unknown>): ExpenseRow {
  const total = moneyFromData(data.total)
  return {
    id, groupId, description: stringValue(data.description, 'Untitled expense'), date: stringValue(data.date, '1970-01-01'), total,
    payerId: stringValue(data.payerId, ''), allocations: allocationArray(data.allocations), category: stringValue(data.category, 'Other'),
    createdAt: stringValue(data.createdAt, `${stringValue(data.date, '1970-01-01')}T00:00:00.000Z`), syncState: 'fresh',
    ...(typeof data.recurringTemplateId === 'string' ? { recurringTemplateId: data.recurringTemplateId } : {}),
  }
}

function commentFromData(expenseId: string, id: string, data: Record<string, unknown>): ExpenseComment {
  return { id, expenseId, authorId: stringValue(data.authorId, ''), body: stringValue(data.body, ''), createdAt: stringValue(data.createdAt, ''), syncState: 'fresh' }
}

function activityFromData(groupId: string, id: string, data: Record<string, unknown>): ActivityItem {
  const type = data.type === 'comment-added' || data.type === 'expense-updated' ? data.type : 'expense-created'
  return { id, groupId, ...(typeof data.expenseId === 'string' ? { expenseId: data.expenseId } : {}), actorId: stringValue(data.actorId, ''), type, createdAt: stringValue(data.createdAt, ''), summary: stringValue(data.summary, ''), syncState: 'fresh' }
}

function recurringFromData(groupId: string, id: string, data: Record<string, unknown>): RecurringExpense {
  const recurrence = data.recurrence as { frequency?: RecurringExpense['recurrence']['frequency']; anchor?: { month?: number; day?: number } }
  return {
    id, groupId, description: stringValue(data.description, 'Untitled recurring expense'), total: moneyFromData(data.total), payerId: stringValue(data.payerId, ''),
    recurrence: { frequency: recurrence.frequency ?? 'monthly', anchor: { month: recurrence.anchor?.month ?? 1, day: recurrence.anchor?.day ?? 1 } },
    nextDate: stringValue(data.nextDate, '1970-01-01'), syncState: 'fresh',
  }
}

function moneyFromData(value: unknown): ExpenseRow['total'] {
  const data = value as { currency?: unknown; minorAmount?: unknown }
  return { currency: stringValue(data?.currency, 'USD') as ExpenseRow['total']['currency'], minorAmount: numberValue(data?.minorAmount, 0) }
}

function allocationArray(value: unknown): ExpenseRow['allocations'] {
  if (!Array.isArray(value)) return []
  return value.map((item) => {
    const data = item as { participantId?: unknown; money?: unknown }
    return { participantId: stringValue(data.participantId, ''), money: moneyFromData(data.money) }
  })
}

function sumRows(rows: readonly ExpenseRow[], key: (row: ExpenseRow) => string): readonly (readonly [string, number])[] {
  const totals = new Map<string, number>()
  rows.forEach((row) => totals.set(key(row), (totals.get(key(row)) ?? 0) + row.total.minorAmount))
  return [...totals].sort(([left], [right]) => left.localeCompare(right))
}

function stringValue(value: unknown, fallback: string): string { return typeof value === 'string' ? value : fallback }
function numberValue(value: unknown, fallback: number): number { return typeof value === 'number' && Number.isSafeInteger(value) ? value : fallback }
function stringArray(value: unknown): readonly string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [] }
function initials(displayName: string): string { return displayName.split(/\s+/).filter(Boolean).map((part) => part[0]).join('').slice(0, 2).toUpperCase() }
