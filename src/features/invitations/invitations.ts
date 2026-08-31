export type InvitationCapability = 'demo-local-preview' | 'server-required'
export type InvitationStatus = 'active' | 'expired' | 'revoked' | 'used' | 'email-mismatch'

export interface PreparedInvitation {
  readonly invitationId: string
  readonly groupId: string
  readonly link: string
  readonly expiresAt: string
  readonly capability: InvitationCapability
  readonly targetEmail?: string
}

export interface InvitationRecord {
  readonly invitationId: string
  readonly groupId: string
  readonly tokenHash: string
  readonly expiresAt: string
  readonly revokedAt?: string
  readonly usedAt?: string
  readonly targetEmail?: string
}

const transientSecrets = new Map<string, string>()

export async function prepareDemoInvitation(input: { readonly groupId: string; readonly canonicalOrigin: string; readonly targetEmail?: string; readonly now?: Date; readonly random?: (bytes: Uint8Array) => void }): Promise<PreparedInvitation> {
  const groupId = strictId(input.groupId, 'group')
  const origin = canonicalHttpsOrigin(input.canonicalOrigin)
  const targetEmail = input.targetEmail ? normalizeEmail(input.targetEmail) : undefined
  const now = input.now ?? new Date()
  if (!Number.isFinite(now.getTime())) throw new Error('Invitation time is invalid')
  const secret = generateInvitationSecret(input.random)
  const invitationId = randomId(input.random)
  transientSecrets.set(invitationId, secret)
  return {
    invitationId, groupId,
    link: `${origin}/invite/${encodeURIComponent(invitationId)}#token=${secret}`,
    expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    capability: 'demo-local-preview',
    ...(targetEmail ? { targetEmail } : {}),
  }
}

export function productionInvitationCapability(): { readonly status: 'server-required'; readonly reason: string } {
  return { status: 'server-required', reason: 'Secure invitations require the callable service.' }
}

export function generateInvitationSecret(random: (bytes: Uint8Array) => void = secureRandom): string {
  const bytes = new Uint8Array(32)
  random(bytes)
  return base64Url(bytes)
}

export async function hashInvitationSecret(secret: string): Promise<string> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(secret)) throw new Error('Invitation secret is invalid')
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret))
  return base64Url(new Uint8Array(digest))
}

/** Moves a fragment secret into memory and strips it from browser history immediately. */
export function captureInvitationFragment(invitationId: string, location: Pick<Location, 'hash' | 'pathname' | 'search'>, history: Pick<History, 'replaceState'>): boolean {
  const id = strictId(invitationId, 'invitation')
  const params = new URLSearchParams(location.hash.startsWith('#') ? location.hash.slice(1) : location.hash)
  const secret = params.get('token') ?? ''
  history.replaceState(null, '', `${location.pathname}${location.search}`)
  if (!/^[A-Za-z0-9_-]{43}$/.test(secret)) return false
  transientSecrets.set(id, secret)
  return true
}

export function consumeTransientInvitationSecret(invitationId: string): string | undefined {
  const id = strictId(invitationId, 'invitation')
  const value = transientSecrets.get(id)
  transientSecrets.delete(id)
  return value
}

export function invitationStatus(record: InvitationRecord, identity: { readonly email?: string; readonly emailVerified: boolean }, now = new Date()): InvitationStatus {
  if (record.revokedAt) return 'revoked'
  if (record.usedAt) return 'used'
  if (Date.parse(record.expiresAt) <= now.getTime()) return 'expired'
  if (record.targetEmail && (!identity.emailVerified || !identity.email || normalizeEmail(identity.email) !== normalizeEmail(record.targetEmail))) return 'email-mismatch'
  return 'active'
}

export function createOpaqueResumeNonce(random: (bytes: Uint8Array) => void = secureRandom): string {
  const bytes = new Uint8Array(24)
  random(bytes)
  return base64Url(bytes)
}

export function canonicalHttpsOrigin(value: string): string {
  let url: URL
  try { url = new URL(value) } catch { throw new Error('Invitation origin is invalid') }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Invitation origin must be a canonical HTTPS origin')
  return url.origin
}

function randomId(random: ((bytes: Uint8Array) => void) | undefined): string {
  const bytes = new Uint8Array(16)
  ;(random ?? secureRandom)(bytes)
  return base64Url(bytes)
}
function secureRandom(bytes: Uint8Array): void { crypto.getRandomValues(bytes as Uint8Array<ArrayBuffer>) }
function base64Url(bytes: Uint8Array): string {
  let binary = ''
  bytes.forEach((byte) => { binary += String.fromCharCode(byte) })
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}
function strictId(value: string, label: string): string {
  const id = value.trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) throw new Error(`${label} ID is invalid`)
  return id
}
function normalizeEmail(value: string): string {
  const email = value.trim().toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Invitation email is invalid')
  return email
}
