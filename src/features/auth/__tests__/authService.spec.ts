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
    expect(() => accountDeletionProvider({ providerIds: ['apple.com'] })).toThrow('account.error.unsupportedDeletionProvider')
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

    await action({ password: 'current-password', onProgress: progress, async beforeAuthDelete() { events.push('local-cleanup') } })

    expect(events).toEqual(['credential:owner@example.com:16', 'reauthenticate', 'prepare', 'local-cleanup', 'delete-user'])
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

    await expect(action({})).rejects.toMatchObject({ messageKey: 'account.error.currentPasswordRequired' })
    await expect(action({ password: 'wrong-password' })).rejects.toMatchObject({ messageKey: 'account.error.wrongPassword' })
    expect(prepared).toBe(false)
  })

  it.each([
    ['auth/popup-closed-by-user', ['google.com'], 'account.error.googleReauthCancelled'],
    ['auth/requires-recent-login', ['password'], 'account.error.recentLoginRequired'],
  ] as const)('maps %s to its semantic application message', async (code, providerIds, messageKey) => {
    const user = { uid: 'owner', email: 'owner@example.com', emailVerified: false, providerData: providerIds.map((providerId) => ({ providerId })) }
    const rejection = Object.assign(new Error('raw Firebase error'), { code })
    const action = createFirebaseAccountDeletionAction({
      currentUser: () => user,
      passwordCredential: () => ({ kind: 'credential' }),
      async reauthenticateWithCredential() { throw rejection },
      googleProvider: () => ({ kind: 'google' }),
      async reauthenticateWithPopup() { throw rejection },
      async prepare() {},
      async deleteUser() {},
    })

    await expect(action({ password: 'current-password' })).rejects.toMatchObject({ messageKey })
  })

  it('carries the signed-out deletion state as a semantic application message', async () => {
    const action = createFirebaseAccountDeletionAction({
      currentUser: () => null,
      passwordCredential: () => ({ kind: 'credential' }),
      async reauthenticateWithCredential() {},
      googleProvider: () => ({ kind: 'google' }),
      async reauthenticateWithPopup() {},
      async prepare() {},
      async deleteUser() {},
    })

    await expect(action({})).rejects.toMatchObject({ messageKey: 'account.error.signInBeforeDelete' })
  })
})
