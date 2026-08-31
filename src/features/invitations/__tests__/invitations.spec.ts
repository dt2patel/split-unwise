import { describe, expect, it, vi } from 'vitest'
import { captureInvitationFragment, canonicalHttpsOrigin, consumeTransientInvitationSecret, generateInvitationSecret, invitationStatus, prepareDemoInvitation } from '../invitations'
import { sharePreparedInvitation } from '../shareInvitation'

const fill = (bytes: Uint8Array) => bytes.fill(7)

describe('invitations', () => {
  it('creates exactly 256-bit fragment secrets and seven-day canonical links', async () => {
    expect(generateInvitationSecret(fill)).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const invite = await prepareDemoInvitation({ groupId: 'lake-house', canonicalOrigin: 'https://split-unwise.web.app', now: new Date('2026-08-31T12:00:00.000Z'), random: fill })
    expect(invite.link).toMatch(/^https:\/\/split-unwise\.web\.app\/invite\/[A-Za-z0-9_-]+#token=[A-Za-z0-9_-]{43}$/)
    expect(invite.expiresAt).toBe('2026-09-07T12:00:00.000Z')
    expect(() => canonicalHttpsOrigin('http://split-unwise.web.app')).toThrow('HTTPS')
  })

  it('strips fragments immediately and consumes the token from memory once', () => {
    const secret = generateInvitationSecret(fill)
    const replaceState = vi.fn()
    expect(captureInvitationFragment('invite-1', { hash: `#token=${secret}`, pathname: '/invite/invite-1', search: '' } as Location, { replaceState } as never)).toBe(true)
    expect(replaceState).toHaveBeenCalledWith(null, '', '/invite/invite-1')
    expect(consumeTransientInvitationSecret('invite-1')).toBe(secret)
    expect(consumeTransientInvitationSecret('invite-1')).toBeUndefined()
  })

  it('distinguishes expiry, revocation, use, and verified targeted email mismatch', () => {
    const base = { invitationId: 'i', groupId: 'g', tokenHash: 'hash', expiresAt: '2026-09-07T00:00:00.000Z' }
    expect(invitationStatus(base, { email: 'maya@example.com', emailVerified: true }, new Date('2026-09-08'))).toBe('expired')
    expect(invitationStatus({ ...base, revokedAt: '2026-09-01' }, { emailVerified: false })).toBe('revoked')
    expect(invitationStatus({ ...base, usedAt: '2026-09-01' }, { emailVerified: false })).toBe('used')
    expect(invitationStatus({ ...base, targetEmail: 'maya@example.com' }, { email: 'other@example.com', emailVerified: true }, new Date('2026-09-01'))).toBe('email-mismatch')
  })

  it('uses share, cancellation, clipboard, then manual fallback without auto-sending', async () => {
    const link = (await prepareDemoInvitation({ groupId: 'g', canonicalOrigin: 'https://split-unwise.web.app', random: fill })).link
    expect(await sharePreparedInvitation(link, { share: vi.fn().mockResolvedValue(undefined) })).toEqual({ status: 'shared' })
    expect(await sharePreparedInvitation(link, { share: vi.fn().mockRejectedValue(new DOMException('cancel', 'AbortError')) })).toEqual({ status: 'cancelled' })
    expect(await sharePreparedInvitation(link, { share: vi.fn().mockRejectedValue(new Error('no')), clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } })).toEqual({ status: 'copied' })
    expect(await sharePreparedInvitation(link, { share: vi.fn().mockRejectedValue(new Error('no')), clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } })).toEqual({ status: 'manual', url: link })
  })
})
