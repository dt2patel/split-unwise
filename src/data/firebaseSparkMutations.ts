import { getAuth, type User } from 'firebase/auth'
import { arrayUnion, doc, getDoc, getFirestore, runTransaction, serverTimestamp, Timestamp, updateDoc, writeBatch, type DocumentData } from 'firebase/firestore'
import { assertCurrencyCode } from '../domain/money'
import { canonicalHttpsOrigin, generateInvitationSecret, hashInvitationSecret, type PreparedInvitation } from '../features/invitations/invitations'
import type { FirebaseConfiguration } from './firebase'
import { getSplitUnwiseFirebaseApp } from './firebaseBootstrap'
import { isStrictId } from './identifiers'

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

export function buildFirebaseProfile(identity: FirebaseIdentity): FirebaseProfileDocument {
  const fallback = identity.email?.split('@')[0] ?? 'Split Unwise member'
  const displayName = normalizeDisplayName(identity.displayName ?? fallback)
  const initials = displayName.split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? '').join('').slice(0, 4) || 'SU'
  return { displayName, initials, avatarUrl: safeAvatarUrl(identity.photoURL) }
}

export function normalizeSparkGroup(input: { readonly operationId: string; readonly name: string; readonly currency: string }): { readonly groupId: string; readonly name: string; readonly currency: string } {
  if (!isStrictId(input.operationId)) throw new Error('Group operation ID is invalid.')
  const groupId = `grp-${input.operationId}`
  if (!isStrictId(groupId)) throw new Error('Group operation ID is too long.')
  const name = input.name.trim().replace(/\s+/g, ' ')
  if (!name || name.length > 120) throw new Error('Group name must be between 1 and 120 characters.')
  const currency = input.currency.trim().toUpperCase()
  try { assertCurrencyCode(currency) } catch { throw new Error('Choose a supported group currency.') }
  return { groupId, name, currency }
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
  return runTransaction(db, async (transaction) => {
    const reference = doc(db, `users/${user.uid}`)
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
  const db = getFirestore(app)
  await runTransaction(db, async (transaction) => {
    const reference = doc(db, `users/${user.uid}`)
    const existing = await transaction.get(reference)
    if (!existing.exists()) {
      transaction.set(reference, { ...profile, createdAt: serverTimestamp(), updatedAt: serverTimestamp() })
      return
    }
    const data = existing.data()
    if (data.displayName !== profile.displayName || data.initials !== profile.initials || (data.avatarUrl ?? null) !== profile.avatarUrl) {
      transaction.update(reference, { ...profile, updatedAt: serverTimestamp() })
    }
  })
}

export async function createSparkGroup(configuration: FirebaseConfiguration, input: { readonly operationId: string; readonly name: string; readonly currency: string }): Promise<{ readonly groupId: string }> {
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
    id: normalized.groupId, name: normalized.name, currency: normalized.currency, memberIds: [user.uid], createdByUid: user.uid,
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
    groupId: normalized.groupId, status: 'active', joinedAt: serverTimestamp(), updatedAt: serverTimestamp(),
  })
  await batch.commit()
  return { groupId: normalized.groupId }
}

export async function createSparkInvitation(configuration: FirebaseConfiguration, input: { readonly groupId: string; readonly canonicalOrigin: string; readonly targetEmail?: string }): Promise<PreparedInvitation> {
  const prepared = await buildSparkInvitation(input)
  const app = await getSplitUnwiseFirebaseApp(configuration)
  const auth = getAuth(app)
  const user = auth.currentUser
  if (!user) throw new Error('Sign in before inviting people.')
  const db = getFirestore(app)
  const group = await getDoc(doc(db, `groups/${input.groupId}`))
  if (!group.exists()) throw new Error('This group is not available.')
  await writeInvitation(db, prepared, user.uid, String(group.data().name ?? 'Group'))
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
  const profile = requireProfile(profileSnapshot.data())
  const batch = writeBatch(db)
  batch.update(invitationReference, { status: 'used', usedByUid: user.uid, usedAt: serverTimestamp(), updatedAt: serverTimestamp() })
  batch.update(doc(db, `groups/${groupId}`), { memberIds: arrayUnion(user.uid), updatedAt: serverTimestamp() })
  batch.set(doc(db, `groups/${groupId}/members/${user.uid}`), {
    status: 'active', role: 'member', canManage: false, ...profile, invitationId, joinedAt: serverTimestamp(),
  })
  batch.set(doc(db, `users/${user.uid}/groups/${groupId}`), {
    groupId, status: 'active', invitationId, joinedAt: serverTimestamp(), updatedAt: serverTimestamp(),
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

async function writeInvitation(db: ReturnType<typeof getFirestore>, prepared: PreparedInvitation & { readonly secret: string }, uid: string, rawGroupName: string): Promise<void> {
  const groupName = normalizeDisplayName(rawGroupName)
  const data: Record<string, unknown> = {
    schemaVersion: 1, invitationId: prepared.invitationId, tokenHash: prepared.invitationId, groupId: prepared.groupId, groupName,
    status: 'active', createdByUid: uid, createdAt: serverTimestamp(), updatedAt: serverTimestamp(), expiresAt: Timestamp.fromDate(new Date(prepared.expiresAt)),
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
