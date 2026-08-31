import { describe, expect, it } from 'vitest'
import { sanitizeAuthIdentity } from '../authService'
import { identityFromUser } from '../firebaseAuthService'

describe('private authentication identity', () => {
  it('maps only safe account fields and deduplicated provider IDs', () => {
    expect(identityFromUser({
      uid: ' uid-1 ', displayName: ' Maya ', email: 'MAYA@EXAMPLE.COM', emailVerified: true, photoURL: 'http://unsafe.example/avatar.png',
      providerData: [{ providerId: 'google.com' }, { providerId: 'google.com' }, { providerId: 'password' }],
    } as never)).toEqual({ uid: 'uid-1', displayName: 'Maya', email: 'maya@example.com', emailVerified: true, providerIds: ['google.com', 'password'] })
  })

  it('rejects identity without a UID and ignores unsafe photo URLs', () => {
    expect(() => sanitizeAuthIdentity({ uid: ' ', displayName: 'Maya', emailVerified: false, providerIds: [] })).toThrow('UID')
  })
})
