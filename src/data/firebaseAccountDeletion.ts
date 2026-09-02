import type { FirebaseApp } from 'firebase/app'
import type { FirebaseConfiguration } from './firebase'
import { assertFirebaseAppMatchesConfiguration, getSplitUnwiseFirebaseApp } from './firebaseBootstrap'
import {
  DELETED_ACCOUNT_NAME,
  anonymizeSharedDocument,
  buildAccountDeletionTombstone,
  buildDeletionGroupContinuity,
  buildDeletionRecurringTemplate,
  buildDeletionSettings,
} from './accountDeletion'

const PAGE_SIZE = 100
const MAX_BATCH_WRITES = 20
const PRIVATE_COLLECTIONS = ['groups', 'activity', 'notifications', 'notificationReads', 'settings', 'jobs', 'exports', 'devices'] as const
const PRIVATE_COLLECTION_LIMITS: Readonly<Record<(typeof PRIVATE_COLLECTIONS)[number], number>> = {
  groups: 100, activity: 100, notifications: 100, notificationReads: 100, settings: 100,
  jobs: 50, exports: 50, devices: 25,
}

export type AccountDeletionCommitEvent =
  | 'profile:deleting'
  | `group:${string}:history`
  | `group:${string}:continuity`
  | 'invitations:delete'
  | 'private:delete'
  | 'profile:prepared'

export type AccountDeletionProgressStage = 'starting' | 'shared-data' | 'group-continuity' | 'private-data' | 'prepared'

export interface AccountDeletionProgress {
  readonly stage: AccountDeletionProgressStage
  readonly completedGroups: number
  readonly totalGroups: number
}

export interface AccountDeletionPreparationInput {
  readonly uid: string
  readonly email?: string
  readonly deletionId?: string
  readonly onProgress?: (progress: AccountDeletionProgress) => void
}

export interface AccountDeletionPreparation {
  readonly deletionId: string
  readonly phase: 'prepared'
  readonly groupsProcessed: number
  readonly sharedDocumentsChanged: number
  readonly privateDocumentsDeleted: number
  readonly invitationsDeleted: number
}

export interface AccountDeletionDocument {
  readonly id: string
  readonly path: string
  readonly data: Readonly<Record<string, unknown>>
}

export interface AccountDeletionFilter {
  readonly field: string
  readonly value: string
}

export interface AccountDeletionListRequest {
  readonly collectionPath: string
  readonly filters: readonly AccountDeletionFilter[]
  readonly startAfter?: string
  readonly limit: number
}

export type AccountDeletionMutation =
  | { readonly kind: 'set'; readonly path: string; readonly data: Readonly<Record<string, unknown>> }
  | { readonly kind: 'delete'; readonly path: string }

export interface AccountDeletionFirestorePort {
  serverTimestamp(): unknown
  createDeletionId(): string
  get(path: string): Promise<AccountDeletionDocument | undefined>
  list(request: AccountDeletionListRequest): Promise<readonly AccountDeletionDocument[]>
  commit(event: AccountDeletionCommitEvent, mutations: readonly AccountDeletionMutation[]): Promise<void>
}

export type AccountDeletionPreparer = (input: AccountDeletionPreparationInput) => Promise<AccountDeletionPreparation>

/** Builds the replay-safe account preparation flow around an injected persistence port. */
export function createAccountDeletionPreparer(port: AccountDeletionFirestorePort): AccountDeletionPreparer {
  return async (input) => {
    assertStrictId(input.uid, 'account UID')
    const normalizedEmail = normalizeEmail(input.email)
    const profilePath = `users/${input.uid}`
    const initialProfile = await requiredDocument(port, profilePath, 'Current Firebase user profile is missing.')
    const existingStatus = initialProfile.data.deletionStatus
    if (existingStatus !== undefined && existingStatus !== 'deleting' && existingStatus !== 'prepared') {
      throw new Error('Current Firebase account deletion state is invalid.')
    }
    const existingDeletionId = typeof initialProfile.data.deletionId === 'string' ? initialProfile.data.deletionId : undefined
    if (existingDeletionId && input.deletionId && existingDeletionId !== input.deletionId) {
      throw new Error('Account deletion identity does not match the pending request.')
    }
    const deletionId = existingDeletionId ?? input.deletionId ?? port.createDeletionId()
    assertDeletionId(deletionId)
    if (existingStatus === 'prepared') return emptyPreparation(deletionId)

    const groupIds = existingStatus === 'deleting'
      ? deletionGroupIds(initialProfile.data)
      : await currentGroupIds(port, input.uid)
    input.onProgress?.({ stage: 'starting', completedGroups: 0, totalGroups: groupIds.length })

    let deletingProfile = initialProfile.data
    if (existingStatus !== 'deleting') {
      deletingProfile = buildAccountDeletionTombstone(initialProfile.data, {
        uid: input.uid,
        deletionId,
        groupIds,
        phase: 'deleting',
        committedAt: port.serverTimestamp(),
      })
      await port.commit('profile:deleting', [{ kind: 'set', path: profilePath, data: deletingProfile }])
      deletingProfile = (await requiredDocument(port, profilePath, 'Current Firebase deletion profile is missing.')).data
    }

    let groupsProcessed = 0
    let sharedDocumentsChanged = 0
    let privateDocumentsDeleted = 0
    for (const groupId of groupIds) {
      const projectionPath = `users/${input.uid}/groups/${groupId}`
      const projection = await port.get(projectionPath)
      if (!projection) {
        groupsProcessed += 1
        input.onProgress?.({ stage: 'group-continuity', completedGroups: groupsProcessed, totalGroups: groupIds.length })
        continue
      }
      const group = await requiredDocument(port, `groups/${groupId}`, `Account deletion group ${groupId} is missing.`)
      const committedAt = port.serverTimestamp()
      const historyMutations = await buildHistoryMutations(port, groupId, input.uid, deletionId, committedAt)
      await commitChunks(port, `group:${groupId}:history`, historyMutations)
      sharedDocumentsChanged += historyMutations.length
      input.onProgress?.({ stage: 'shared-data', completedGroups: groupsProcessed, totalGroups: groupIds.length })

      const members = await listAll(port, `groups/${groupId}/members`)
      const continuity = buildDeletionGroupContinuity(
        group.data,
        members.map(({ id, data }) => ({ ...data, id })),
        input.uid,
        deletionId,
        committedAt,
      )
      const continuityMutations: AccountDeletionMutation[] = [
        { kind: 'set', path: group.path, data: continuity.group },
        { kind: 'set', path: `groups/${groupId}/members/${input.uid}`, data: continuity.deletedMember },
      ]
      if (continuity.promotedMember) {
        const { id, ...promotedMember } = continuity.promotedMember
        continuityMutations.push({ kind: 'set', path: `groups/${groupId}/members/${id}`, data: promotedMember })
      }
      if (group.data.kind === 'friendship') {
        const counterpartId = remainingMemberIds(continuity.group)[0]
        if (counterpartId) {
          const counterpartPath = `users/${counterpartId}/groups/${groupId}`
          const counterpart = await port.get(counterpartPath)
          if (counterpart) continuityMutations.push({
            kind: 'set',
            path: counterpartPath,
            data: {
              ...counterpart.data,
              contextLabel: DELETED_ACCOUNT_NAME,
              updatedAt: committedAt,
              accountDeletionId: deletionId,
              accountDeletedUid: input.uid,
            },
          })
        }
      }
      continuityMutations.push({ kind: 'delete', path: projectionPath })
      await port.commit(`group:${groupId}:continuity`, continuityMutations)
      sharedDocumentsChanged += continuityMutations.length - 1
      privateDocumentsDeleted += 1
      groupsProcessed += 1
      input.onProgress?.({ stage: 'group-continuity', completedGroups: groupsProcessed, totalGroups: groupIds.length })
    }

    const invitationMutations = await invitationDeletes(port, input.uid, normalizedEmail)
    await commitChunks(port, 'invitations:delete', invitationMutations)

    const privateMutations = await privateDeletes(port, input.uid)
    await commitChunks(port, 'private:delete', privateMutations)
    privateDocumentsDeleted += privateMutations.length
    input.onProgress?.({ stage: 'private-data', completedGroups: groupsProcessed, totalGroups: groupIds.length })

    const preparedProfile = buildAccountDeletionTombstone(deletingProfile, {
      uid: input.uid,
      deletionId,
      groupIds,
      phase: 'prepared',
      committedAt: port.serverTimestamp(),
    })
    await port.commit('profile:prepared', [{ kind: 'set', path: profilePath, data: preparedProfile }])
    input.onProgress?.({ stage: 'prepared', completedGroups: groupsProcessed, totalGroups: groupIds.length })
    return {
      deletionId,
      phase: 'prepared',
      groupsProcessed,
      sharedDocumentsChanged,
      privateDocumentsDeleted,
      invitationsDeleted: invitationMutations.length,
    }
  }
}

/** Creates a real modular Firebase client port on the app's existing named Firebase app. */
export async function createFirebaseAccountDeletionFirestorePort(
  configuration: FirebaseConfiguration,
  firebaseApp?: FirebaseApp,
): Promise<AccountDeletionFirestorePort> {
  const app = firebaseApp ?? await getSplitUnwiseFirebaseApp(configuration)
  if (firebaseApp) assertFirebaseAppMatchesConfiguration(firebaseApp, configuration)
  const firestore = await import('firebase/firestore')
  const db = firestore.getFirestore(app)
  return {
    serverTimestamp: () => firestore.serverTimestamp(),
    createDeletionId: () => createDeletionId(),
    async get(path) {
      const snapshot = await firestore.getDoc(firestore.doc(db, ...accountDeletionFirestorePathSegments(path)))
      return snapshot.exists() ? { id: snapshot.id, path, data: snapshot.data() } : undefined
    },
    async list(request) {
      assertPageLimit(request.limit)
      const constraints: import('firebase/firestore').QueryConstraint[] = [
        ...request.filters.map(({ field, value }) => firestore.where(field, '==', value)),
        firestore.orderBy(firestore.documentId(), 'asc'),
        ...(request.startAfter ? [firestore.startAfter(request.startAfter)] : []),
        firestore.limit(request.limit),
      ]
      const snapshot = await firestore.getDocs(firestore.query(
        firestore.collection(db, ...accountDeletionFirestorePathSegments(request.collectionPath)),
        ...constraints,
      ))
      return snapshot.docs.map((document) => ({ id: document.id, path: `${request.collectionPath}/${document.id}`, data: document.data() }))
    },
    async commit(_event, mutations) {
      if (mutations.length === 0) return
      if (mutations.length > MAX_BATCH_WRITES) throw new Error('Account deletion batch is too large.')
      const batch = firestore.writeBatch(db)
      for (const mutation of mutations) {
        const reference = firestore.doc(db, ...accountDeletionFirestorePathSegments(mutation.path))
        if (mutation.kind === 'delete') batch.delete(reference)
        else batch.set(reference, mutation.data)
      }
      await batch.commit()
    },
  }
}

export async function prepareFirebaseAccountDeletion(
  configuration: FirebaseConfiguration,
  input: AccountDeletionPreparationInput,
  firebaseApp?: FirebaseApp,
): Promise<AccountDeletionPreparation> {
  return createAccountDeletionPreparer(await createFirebaseAccountDeletionFirestorePort(configuration, firebaseApp))(input)
}

async function buildHistoryMutations(
  port: AccountDeletionFirestorePort,
  groupId: string,
  uid: string,
  deletionId: string,
  committedAt: unknown,
): Promise<readonly AccountDeletionMutation[]> {
  const mutations: AccountDeletionMutation[] = []
  const expenses = await listAll(port, `groups/${groupId}/expenses`)
  for (const expense of expenses) {
    appendAnonymized(mutations, 'expense', expense, uid)
    const revisions = await listAll(port, `groups/${groupId}/expenses/${expense.id}/revisions`)
    for (const revision of revisions) appendAnonymized(mutations, 'revision', revision, uid)
  }
  for (const activity of await listAll(port, `groups/${groupId}/activity`)) appendAnonymized(mutations, 'activity', activity, uid)
  for (const comment of await listAll(port, `groups/${groupId}/comments`)) appendAnonymized(mutations, 'comment', comment, uid)
  for (const settlement of await listAll(port, `groups/${groupId}/settlements`)) appendAnonymized(mutations, 'settlement', settlement, uid)
  for (const recurring of await listAll(port, `groups/${groupId}/recurringTemplates`)) {
    const next = buildDeletionRecurringTemplate(recurring.data, uid, deletionId, committedAt)
    if (next) mutations.push({ kind: 'set', path: recurring.path, data: next })
  }
  const settings = await port.get(`groups/${groupId}/settings/defaults`)
  if (settings) {
    const next = buildDeletionSettings(settings.data, uid, deletionId, committedAt)
    if (next) mutations.push({ kind: 'set', path: settings.path, data: next })
  }
  return mutations
}

function appendAnonymized(
  mutations: AccountDeletionMutation[],
  kind: 'activity' | 'comment' | 'expense' | 'revision' | 'settlement',
  document: AccountDeletionDocument,
  uid: string,
): void {
  const next = anonymizeSharedDocument(kind, document.data, uid)
  if (next) mutations.push({ kind: 'set', path: document.path, data: next })
}

async function invitationDeletes(
  port: AccountDeletionFirestorePort,
  uid: string,
  email: string | undefined,
): Promise<readonly AccountDeletionMutation[]> {
  const matches = await listAll(port, 'invitations', [{ field: 'createdByUid', value: uid }])
  if (email) matches.push(...await listAll(port, 'invitations', [{ field: 'targetEmail', value: email }]))
  return [...new Map(matches.map((document) => [document.path, document])).values()]
    .map(({ path }) => ({ kind: 'delete' as const, path }))
}

async function privateDeletes(port: AccountDeletionFirestorePort, uid: string): Promise<readonly AccountDeletionMutation[]> {
  const documents: AccountDeletionDocument[] = []
  for (const collectionName of PRIVATE_COLLECTIONS) {
    documents.push(...await listAll(port, `users/${uid}/${collectionName}`, [], PRIVATE_COLLECTION_LIMITS[collectionName]))
  }
  return documents.map(({ path }) => ({ kind: 'delete' as const, path }))
}

async function currentGroupIds(port: AccountDeletionFirestorePort, uid: string): Promise<readonly string[]> {
  const projections = await listAll(port, `users/${uid}/groups`)
  const groupIds = projections.map(({ id, data }) => typeof data.groupId === 'string' ? data.groupId : id)
  groupIds.forEach((groupId) => assertStrictId(groupId, 'account deletion group ID'))
  if (groupIds.length > 100) throw new Error('Account deletion supports at most 100 groups.')
  return [...new Set(groupIds)].sort((left, right) => left.localeCompare(right))
}

async function listAll(
  port: AccountDeletionFirestorePort,
  collectionPath: string,
  filters: readonly AccountDeletionFilter[] = [],
  pageSize = PAGE_SIZE,
): Promise<AccountDeletionDocument[]> {
  assertPageLimit(pageSize)
  const documents: AccountDeletionDocument[] = []
  let startAfter: string | undefined
  while (true) {
    const page = await port.list({ collectionPath, filters, ...(startAfter ? { startAfter } : {}), limit: pageSize })
    documents.push(...page)
    if (page.length < pageSize) return documents
    const nextCursor = page.at(-1)?.id
    if (!nextCursor || nextCursor === startAfter) throw new Error(`Account deletion pagination stalled for ${collectionPath}.`)
    startAfter = nextCursor
  }
}

async function commitChunks(
  port: AccountDeletionFirestorePort,
  event: AccountDeletionCommitEvent,
  mutations: readonly AccountDeletionMutation[],
): Promise<void> {
  for (let offset = 0; offset < mutations.length; offset += MAX_BATCH_WRITES) {
    await port.commit(event, mutations.slice(offset, offset + MAX_BATCH_WRITES))
  }
}

async function requiredDocument(
  port: AccountDeletionFirestorePort,
  path: string,
  message: string,
): Promise<AccountDeletionDocument> {
  const document = await port.get(path)
  if (!document) throw new Error(message)
  return document
}

function deletionGroupIds(profile: Readonly<Record<string, unknown>>): readonly string[] {
  if (!Array.isArray(profile.deletionGroupIds)) throw new Error('Account deletion group scope is invalid.')
  const groupIds = profile.deletionGroupIds.map((value) => {
    if (typeof value !== 'string') throw new Error('Account deletion group scope is invalid.')
    assertStrictId(value, 'account deletion group ID')
    return value
  })
  if (groupIds.length > 100 || new Set(groupIds).size !== groupIds.length) throw new Error('Account deletion group scope is invalid.')
  return groupIds
}

function remainingMemberIds(group: Readonly<Record<string, unknown>>): readonly string[] {
  if (!Array.isArray(group.memberIds) || group.memberIds.some((value) => typeof value !== 'string')) {
    throw new Error('Account deletion group membership is invalid.')
  }
  return group.memberIds as string[]
}

function emptyPreparation(deletionId: string): AccountDeletionPreparation {
  return { deletionId, phase: 'prepared', groupsProcessed: 0, sharedDocumentsChanged: 0, privateDocumentsDeleted: 0, invitationsDeleted: 0 }
}

function normalizeEmail(email: string | undefined): string | undefined {
  if (email === undefined) return undefined
  const normalized = email.trim().toLowerCase()
  if (!/^[^ @]+@[^ @]+[.][^ @]+$/.test(normalized) || normalized.length > 254) throw new Error('Account email is invalid.')
  return normalized
}

function createDeletionId(): string {
  const uuid = globalThis.crypto?.randomUUID?.()
  if (!uuid) throw new Error('Secure account deletion identity is unavailable.')
  return `account-delete-${uuid}`
}

function assertPageLimit(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > PAGE_SIZE) throw new Error('Account deletion page limit is invalid.')
}

/** Validates adapter-owned paths while accepting URL-safe capability IDs. */
export function accountDeletionFirestorePathSegments(path: string): [string, ...string[]] {
  const segments = path.split('/').filter(Boolean)
  if (segments.join('/') !== path) throw new Error('Account deletion Firestore path separators are invalid.')
  const invalidIndex = segments.findIndex((segment) => !/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/.test(segment))
  if (invalidIndex >= 0) throw new Error(`Account deletion Firestore path segment ${invalidIndex + 1} is invalid (${segments[invalidIndex]!.length} characters).`)
  return segments as [string, ...string[]]
}

function assertDeletionId(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(value)) throw new Error('Account deletion ID is invalid.')
}

function assertStrictId(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) throw new Error(`${label} is invalid.`)
}
