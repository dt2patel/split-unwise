import { describe, expect, it } from 'vitest'
import { sanitizeAuthIdentity } from '../authService'
import { accountDeletionProvider, createFirebaseAccountDeletionAction, identityFromUser } from '../firebaseAuthService'

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

describe('Firebase account deletion authentication', () => {
  it('chooses the attached recent-sign-in provider without guessing', () => {
    expect(accountDeletionProvider({ providerIds: ['password'] })).toBe('password')
    expect(accountDeletionProvider({ providerIds: ['google.com'] })).toBe('google')
    expect(accountDeletionProvider({ providerIds: ['google.com', 'password'] })).toBe('password')
    expect(() => accountDeletionProvider({ providerIds: ['apple.com'] })).toThrow('not supported')
  })

  it('reauthenticates before preparing Firestore and deleting the Auth user', async () => {
    const events: string[] = []
    const user = {
      uid: 'owner', email: 'owner@example.com', emailVerified: true,
      providerData: [{ providerId: 'password' }],
    }
    const credential = { kind: 'password-credential' }
    const progress = () => undefined
    const action = createFirebaseAccountDeletionAction({
      currentUser: () => user,
      passwordCredential(email, password) {
        events.push(`credential:${email}:${password.length}`)
        return credential
      },
      async reauthenticateWithCredential(receivedUser, receivedCredential) {
        expect(receivedUser).toBe(user)
        expect(receivedCredential).toBe(credential)
        events.push('reauthenticate')
      },
      googleProvider: () => { throw new Error('Google should not be selected') },
      async reauthenticateWithPopup() { throw new Error('Google should not be selected') },
      async prepare(input) {
        expect(input).toEqual({ uid: 'owner', email: 'owner@example.com', onProgress: progress })
        events.push('prepare')
      },
      async deleteUser(receivedUser) {
        expect(receivedUser).toBe(user)
        events.push('delete-user')
      },
    })

    await action({ password: 'current-password', onProgress: progress })

    expect(events).toEqual(['credential:owner@example.com:16', 'reauthenticate', 'prepare', 'delete-user'])
  })

  it('requires a password without starting deletion and maps invalid credentials', async () => {
    const user = {
      uid: 'owner', email: 'owner@example.com', emailVerified: false,
      providerData: [{ providerId: 'password' }],
    }
    let prepared = false
    const action = createFirebaseAccountDeletionAction({
      currentUser: () => user,
      passwordCredential: () => ({ kind: 'credential' }),
      async reauthenticateWithCredential() { throw Object.assign(new Error('raw Firebase error'), { code: 'auth/invalid-credential' }) },
      googleProvider: () => ({ kind: 'google' }),
      async reauthenticateWithPopup() {},
      async prepare() { prepared = true },
      async deleteUser() {},
    })

    await expect(action({})).rejects.toThrow('Enter your current password')
    await expect(action({ password: 'wrong-password' })).rejects.toThrow('The password is incorrect')
    expect(prepared).toBe(false)
  })
})
