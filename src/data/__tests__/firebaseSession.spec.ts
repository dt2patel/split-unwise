import { describe, expect, it } from 'vitest'
import { resolveFirebaseSession } from '../firebaseSession'

describe('Firebase session boundary', () => {
  it('does not expose an authenticated user until hydration resolves', async () => {
    let release: () => void = () => undefined
    const hydrated = new Promise<void>((resolve) => { release = resolve })
    const session = resolveFirebaseSession({ authStateReady: () => hydrated, currentUser: { uid: 'maya-p' } })
    let resolved = false
    void session.then(() => { resolved = true })

    await Promise.resolve()
    expect(resolved).toBe(false)
    release()
    await expect(session).resolves.toEqual({ userId: 'maya-p' })
  })
})
