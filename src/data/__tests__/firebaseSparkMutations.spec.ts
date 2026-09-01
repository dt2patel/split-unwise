import { describe, expect, it } from 'vitest'
import { buildFirebaseProfile, buildSparkInvitation, normalizeSparkGroup } from '../firebaseSparkMutations'

const fill = (bytes: Uint8Array) => bytes.fill(11)

describe('Firebase Spark mutations', () => {
  it('derives a bounded public profile from the authenticated Firebase identity', () => {
    expect(buildFirebaseProfile({ uid: 'user-a', displayName: '  Maya   Patel  ', email: 'maya@example.com', photoURL: null })).toEqual({
      displayName: 'Maya Patel', initials: 'MP', avatarUrl: null,
    })
    expect(buildFirebaseProfile({ uid: 'user-b', displayName: null, email: 'friend.name@example.com', photoURL: null })).toEqual({
      displayName: 'friend.name', initials: 'F', avatarUrl: null,
    })
  })

  it('normalizes a supported group and derives a replay-stable strict ID', () => {
    expect(normalizeSparkGroup({ operationId: 'group-12345678-1234-1234-1234-123456789012', name: '  Chicago Weekend  ', currency: 'usd' })).toEqual({
      groupId: 'grp-group-12345678-1234-1234-1234-123456789012',
      name: 'Chicago Weekend', currency: 'USD',
    })
    expect(() => normalizeSparkGroup({ operationId: 'bad id', name: 'Trip', currency: 'USD' })).toThrow('operation')
  })

  it('makes the SHA-256 capability document ID match the private fragment token', async () => {
    const invitation = await buildSparkInvitation({ groupId: 'group-a', canonicalOrigin: 'https://split-unwise-aditya.web.app', random: fill, now: new Date('2026-09-01T00:00:00.000Z') })
    expect(invitation.capability).toBe('firebase-client')
    expect(invitation.invitationId).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(invitation.link).toBe('https://split-unwise-aditya.web.app/invite/join#token=CwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCws')
    expect(invitation.expiresAt).toBe('2026-09-08T00:00:00.000Z')
  })
})
