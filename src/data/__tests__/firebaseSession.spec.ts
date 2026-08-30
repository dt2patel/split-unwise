import { describe, expect, it } from 'vitest'
import * as firebaseSessionModule from '../firebaseSession'

describe('Firebase session boundary', () => {
  const { resolveFirebaseSession } = firebaseSessionModule

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

  it('emits the hydrated Firebase principal and every later auth principal change', async () => {
    const createPrincipalSource = (firebaseSessionModule as unknown as {
      createFirebasePrincipalSource?: (options: {
        auth: { authStateReady(): Promise<void>; currentUser: { readonly uid: string } | null }
        projectId: string
        subscribe: (listener: (user: { readonly uid: string } | null) => void) => () => void
      }) => { listen(listener: (principal: FirebasePrincipalFixture | undefined) => void | Promise<void>): Promise<() => void> }
    }).createFirebasePrincipalSource

    expect(createPrincipalSource).toBeTypeOf('function')
    if (!createPrincipalSource) return

    let releaseHydration!: () => void
    const hydrated = new Promise<void>((resolve) => { releaseHydration = resolve })
    const auth = { authStateReady: () => hydrated, currentUser: { uid: 'maya-p' } as { uid: string } | null }
    let emitAuth!: (user: { readonly uid: string } | null) => void
    let unsubscribed = false
    const source = createPrincipalSource({
      auth,
      projectId: 'trip-project',
      subscribe(listener) {
        emitAuth = listener
        return () => { unsubscribed = true }
      },
    })
    const principals: Array<FirebasePrincipalFixture | undefined> = []
    const listening = source.listen((principal) => { principals.push(principal) })

    await Promise.resolve()
    expect(principals).toEqual([])
    releaseHydration()
    await Promise.resolve()
    emitAuth(auth.currentUser)
    const unsubscribe = await listening
    expect(principals).toEqual([{ mode: 'firebase', projectId: 'trip-project', uid: 'maya-p' }])

    emitAuth({ uid: 'jordan-k' })
    emitAuth(null)
    await Promise.resolve()
    expect(principals).toEqual([
      { mode: 'firebase', projectId: 'trip-project', uid: 'maya-p' },
      { mode: 'firebase', projectId: 'trip-project', uid: 'jordan-k' },
      undefined,
    ])
    unsubscribe()
    expect(unsubscribed).toBe(true)
  })
})

type FirebasePrincipalFixture = { readonly mode: 'firebase'; readonly projectId: string; readonly uid: string }
