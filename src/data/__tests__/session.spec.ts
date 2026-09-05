import { describe, expect, it, vi } from 'vitest'
import { createDemoRepository } from '../demoRepository'
import { createMemoryCommandStorage } from '../commandQueue'
import * as sessionModule from '../session'
import { createMemoryReceiptStore, type LocalReceiptReference, type ReceiptProvider } from '../receipts'
import type { CommandEnvelope, Member } from '../repositories'

describe('app data session', () => {
  const { appPrincipalKey, createAppSession, getAppSession, setAppSessionForTesting } = sessionModule

  it('waits for the repository identity before binding and resuming its queue', async () => {
    const demo = createDemoRepository()
    let releaseIdentity!: (member: Member) => void
    const identity = new Promise<Member>((resolve) => { releaseIdentity = resolve })
    const repository = {
      ...demo,
      app: { ...demo.app, getCurrentUser: () => identity },
    }
    const session = createAppSession({ repository, commandStorage: createMemoryCommandStorage() })

    expect(session.ready).toBeInstanceOf(Promise)
    expect(() => session.queue.submit({
      kind: 'profile.update', operationId: 'too-early', displayName: 'Maya Patel',
    })).toThrow('authenticated owner')

    releaseIdentity(await demo.app.getCurrentUser())
    await session.ready
    await session.queue.submit({ kind: 'profile.update', operationId: 'after-ready', displayName: 'Maya Patel' }).result()
    expect(session.queue.get('after-ready')).toMatchObject({
      originPrincipalKey: appPrincipalKey({ mode: 'demo', projectId: 'split-unwise-demo', uid: 'maya-p' }),
      status: 'fresh',
    })
  })

  it('uses the complete stable demo principal as its only storage namespace', async () => {
    const repository = createDemoRepository()
    const currentUser = await repository.app.getCurrentUser()
    const principalKey = appPrincipalKey({ mode: repository.mode, projectId: repository.projectId, uid: currentUser.id })
    const storage = createMemoryCommandStorage()
    const session = createAppSession({ repository, commandStorage: storage })

    await session.ready
    await session.queue.submit({ kind: 'profile.update', operationId: 'demo-owned', displayName: 'Maya Patel' }).result()

    expect(await storage.load(principalKey)).toMatchObject({
      version: 6,
      principalKey,
      operations: [{ originPrincipalKey: principalKey, envelope: { operationId: 'demo-owned' } }],
    })
    expect(await storage.load('someone-else')).toBeUndefined()
  })

  it('resolves the full principal before constructing local stores and namespaces both stores by it', async () => {
    const demo = createDemoRepository()
    let releaseIdentity!: (member: Member) => void
    const identity = new Promise<Member>((resolve) => { releaseIdentity = resolve })
    const repository = {
      ...demo,
      projectId: 'trip-project',
      app: { ...demo.app, getCurrentUser: () => identity },
    }
    const storage = createMemoryCommandStorage()
    const receipts = createMemoryReceiptStore()
    const constructions: Array<{ type: 'commands' | 'receipts'; principal: unknown; namespace?: string }> = []
    const session = createAppSession({
      repository,
      commandStorageFactory: (principal: unknown) => {
        constructions.push({ type: 'commands', principal })
        return storage
      },
      receiptStoreFactory: (principal: unknown, namespace: string) => {
        constructions.push({ type: 'receipts', principal, namespace })
        return receipts
      },
    } as never)

    await Promise.resolve()
    expect(constructions).toEqual([])

    releaseIdentity(await demo.app.getCurrentUser())
    await session.ready

    const principal = { mode: 'demo', projectId: 'trip-project', uid: 'maya-p' }
    const principalKey = 'split-unwise-principal:v1:demo:trip-project:maya-p'
    expect(constructions).toEqual([
      { type: 'commands', principal },
      { type: 'receipts', principal, namespace: principalKey },
    ])

    await session.queue.submit({ kind: 'profile.update', operationId: 'full-principal', displayName: 'Maya Patel' }).result()
    expect(await storage.load(principalKey)).toMatchObject({
      principalKey,
      operations: [{ originPrincipalKey: principalKey, envelope: { operationId: 'full-principal' } }],
    })
    expect(await storage.load('maya-p')).toBeUndefined()
  })

  it('fails closed before local stores construct when an explicit principal UID differs from the repository user', async () => {
    const repository = createDemoRepository()
    const constructions: string[] = []
    const session = createAppSession({
      repository,
      principal: { mode: 'demo', projectId: repository.projectId, uid: 'jordan-k' },
      commandStorageFactory: () => { constructions.push('commands'); return createMemoryCommandStorage() },
      receiptStoreFactory: () => { constructions.push('receipts'); return createMemoryReceiptStore() },
    })
    void session.principal.catch(() => undefined)

    await expect(session.ready).rejects.toThrow('authenticated user')
    expect(constructions).toEqual([])
  })

  it('keeps the same UID isolated across Firebase projects and repository modes', () => {
    const principalKey = (sessionModule as unknown as {
      appPrincipalKey?: (principal: { mode: 'demo' | 'firebase'; projectId: string; uid: string }) => string
    }).appPrincipalKey

    expect(principalKey).toBeTypeOf('function')
    if (!principalKey) return

    const demo = principalKey({ mode: 'demo', projectId: 'trip-project', uid: 'shared-uid' })
    const firebaseA = principalKey({ mode: 'firebase', projectId: 'trip-project', uid: 'shared-uid' })
    const firebaseB = principalKey({ mode: 'firebase', projectId: 'work-project', uid: 'shared-uid' })

    expect(new Set([demo, firebaseA, firebaseB]).size).toBe(3)
    expect(firebaseA).toBe('split-unwise-principal:v1:firebase:trip-project:shared-uid')
  })

  it('freezes the old session, resets features, and rejects its stale completion before activating another principal', async () => {
    const createCoordinator = (sessionModule as unknown as {
      createAppSessionCoordinator?: (options: {
        createSession: (principal: PrincipalFixture) => ReturnType<typeof createAppSession>
        resetFeatureStores: () => void | Promise<void>
        activateSession: (session: ReturnType<typeof createAppSession>) => void | Promise<void>
      }) => { transition(principal: PrincipalFixture | undefined): Promise<void> }
    }).createAppSessionCoordinator

    expect(createCoordinator).toBeTypeOf('function')
    if (!createCoordinator) return

    const firstPrincipal: PrincipalFixture = { mode: 'demo', projectId: 'trip-project', uid: 'maya-p' }
    const secondPrincipal: PrincipalFixture = { mode: 'demo', projectId: 'trip-project', uid: 'jordan-k' }
    const firstBase = createDemoRepository()
    const secondBase = createDemoRepository()
    let releaseOldRead!: (groups: Awaited<ReturnType<typeof firstBase.groups.list>>) => void
    const oldRead = new Promise<Awaited<ReturnType<typeof firstBase.groups.list>>>((resolve) => { releaseOldRead = resolve })
    const firstRepository = { ...firstBase, projectId: firstPrincipal.projectId, app: { ...firstBase.app, async getCurrentUser() { return { ...await firstBase.app.getCurrentUser(), id: firstPrincipal.uid } } }, groups: { ...firstBase.groups, list: () => oldRead } }
    const secondRepository = { ...secondBase, projectId: secondPrincipal.projectId, app: { ...secondBase.app, async getCurrentUser() { return { ...await secondBase.app.getCurrentUser(), id: secondPrincipal.uid } } } }
    const events: string[] = []
    const sessions = new Map<string, ReturnType<typeof createAppSession>>()
    let featureState = 'empty'

    const coordinator = createCoordinator({
      createSession(principal) {
        events.push(`create:${principal.uid}`)
        const session = createAppSession({
          principal,
          repository: principal.uid === firstPrincipal.uid ? firstRepository : secondRepository,
          commandStorage: createMemoryCommandStorage(),
          receipts: createMemoryReceiptStore(),
        } as never)
        sessions.set(principal.uid, session)
        return session
      },
      resetFeatureStores() {
        events.push('reset')
        featureState = 'reset'
      },
      activateSession(session) {
        const principal = [...sessions].find(([, candidate]) => candidate === session)?.[0]
        events.push(`activate:${principal}`)
        featureState = principal ?? 'missing'
      },
    })

    await coordinator.transition(firstPrincipal)
    const firstSession = sessions.get(firstPrincipal.uid)
    if (!firstSession) throw new Error('First session was not created')
    const staleCompletion = firstSession.repository.groups.list()
      .then(() => { featureState = 'stale-maya' })
      .catch(() => undefined)

    await coordinator.transition(secondPrincipal)
    expect(events).toEqual(['create:maya-p', 'activate:maya-p', 'reset', 'create:jordan-k', 'activate:jordan-k'])

    releaseOldRead(await firstBase.groups.list())
    await staleCompletion
    expect(featureState).toBe('jordan-k')
  })

  it('rebuilds a same-principal session after its prior activation failed', async () => {
    const principal: PrincipalFixture = { mode: 'demo', projectId: 'split-unwise-demo', uid: 'maya-p' }
    const created: ReturnType<typeof createAppSession>[] = []
    let resetCount = 0
    const coordinator = sessionModule.createAppSessionCoordinator({
      createSession() {
        const session = created.length === 0
          ? createAppSession({
              repository: { ...createDemoRepository(), app: { ...createDemoRepository().app, getCurrentUser: async () => { throw new Error('first activation failed') } } },
              commandStorage: createMemoryCommandStorage(), receipts: createMemoryReceiptStore(),
            })
          : createAppSession({ repository: createDemoRepository(), commandStorage: createMemoryCommandStorage(), receipts: createMemoryReceiptStore() })
        void session.principal.catch(() => undefined)
        created.push(session)
        return session
      },
      resetFeatureStores() { resetCount += 1 },
      activateSession() { /* activation is the observable success boundary below */ },
    })

    await expect(coordinator.transition(principal)).rejects.toThrow('first activation failed')
    await expect(coordinator.transition(principal)).resolves.toBeUndefined()

    expect(created).toHaveLength(2)
    expect(created[1].isActive).toBe(true)
    expect(resetCount).toBe(0)
  })

  it('clears the active session and disposes the mounted feature tree during a production host reset', async () => {
    const createMountHost = (sessionModule as unknown as {
      createAppSessionMountHost?: (options: {
        setSession: (session: ReturnType<typeof createAppSession> | undefined) => void
        mount: (session: ReturnType<typeof createAppSession>) => Promise<{
          unmount(): void
          disposeFeatureStores(): void
        }>
      }) => {
        activateSession(session: ReturnType<typeof createAppSession>): Promise<void>
        resetFeatureStores(): Promise<void>
      }
    }).createAppSessionMountHost

    expect(createMountHost).toBeTypeOf('function')
    if (!createMountHost) return

    const events: string[] = []
    const session = createAppSession({
      repository: createDemoRepository(),
      commandStorage: createMemoryCommandStorage(),
      receipts: createMemoryReceiptStore(),
    })
    await session.ready
    const host = createMountHost({
      setSession(value) { events.push(value ? 'session:active' : 'session:cleared') },
      async mount() {
        events.push('mount')
        return {
          unmount() { events.push('unmount') },
          disposeFeatureStores() { events.push('dispose-pinia') },
        }
      },
    })

    await host.activateSession(session)
    await host.resetFeatureStores()

    expect(events).toEqual(['session:active', 'mount', 'session:cleared', 'unmount', 'dispose-pinia'])
  })

  it('detaches feature subscribers before a frozen session command can complete', async () => {
    const demo = createDemoRepository()
    let releaseExecution!: () => void
    let markStarted!: () => void
    const execution = new Promise<void>((resolve) => { releaseExecution = resolve })
    const started = new Promise<void>((resolve) => { markStarted = resolve })
    const repository = {
      ...demo,
      commands: {
        async execute(command: CommandEnvelope) {
          markStarted()
          await execution
          return demo.commands.execute(command)
        },
      },
    }
    const session = createAppSession({
      repository,
      commandStorage: createMemoryCommandStorage(),
      receipts: createMemoryReceiptStore(),
    })
    await session.ready
    let featureNotifications = 0
    session.queue.subscribe(() => { featureNotifications += 1 })
    const handle = session.queue.submit({ kind: 'profile.update', operationId: 'old-session-write', displayName: 'Old user' })
    await started
    expect(featureNotifications).toBe(1)

    session.freeze()
    releaseExecution()
    await handle.result().catch(() => undefined)

    expect(featureNotifications).toBe(1)
  })

  it('keeps a post-commit stale-session outcome pending for same-principal adoption', async () => {
    const repository = createDemoRepository()
    const storage = createMemoryCommandStorage()
    const receipts = createMemoryReceiptStore()
    let firstSession!: ReturnType<typeof createAppSession>
    let backendExecutions = 0
    const committingRepository = {
      ...repository,
      commands: {
        async execute(command: CommandEnvelope) {
          backendExecutions += 1
          const result = await repository.commands.execute(command)
          firstSession.freeze()
          return result
        },
      },
    }
    firstSession = createAppSession({ repository: committingRepository, commandStorage: storage, receipts })
    await firstSession.ready
    const command = expenseAdd('adopt-stale-commit', [])

    await expect(firstSession.queue.submit(command).result()).rejects.toBeInstanceOf(sessionModule.StaleAppSessionError)
    expect(firstSession.queue.get(command.operationId)).toMatchObject({ status: 'pending' })
    expect(await storage.load(appPrincipalKey({ mode: repository.mode, projectId: repository.projectId, uid: 'maya-p' }))).toMatchObject({
      operations: [{ status: 'pending', envelope: { operationId: command.operationId } }],
    })

    const resumed = createAppSession({ repository, commandStorage: storage, receipts })
    await resumed.ready
    await expect(resumed.queue.submit(command).result()).resolves.toMatchObject({ status: 'saved' })
    await expect(repository.expenses.listForGroup(command.groupId)).resolves.toHaveLength(6)
    expect(backendExecutions).toBe(1)
  })

  it('promotes local add-expense receipts before repository execution without rewriting the durable command', async () => {
    const demo = createDemoRepository()
    const storage = createMemoryCommandStorage()
    const events: string[] = []
    const executed: CommandEnvelope[] = []
    const repository = {
      ...demo,
      commands: { execute: async (command: CommandEnvelope) => {
        events.push('execute')
        executed.push(JSON.parse(JSON.stringify(command)) as CommandEnvelope)
        return demo.commands.execute(command)
      } },
    }
    const provider = receiptProvider(async (groupId, reference) => {
      events.push(`upload:${groupId}:${reference}`)
      return { status: 'uploaded', attachmentRef: 'remote-receipt:receipt-001' }
    })
    const receipts = createMemoryReceiptStore({ id: () => 'receipt-001' })
    await receipts.put(new Blob(['receipt'], { type: 'image/jpeg' }), { fileName: 'receipt.jpg' })
    const session = createAppSession({
      repository,
      commandStorage: storage,
      receipts,
      receiptProvider: provider,
    })
    await session.ready

    const handle = session.queue.submit(expenseAdd('promote-add', ['local-receipt:receipt-001', 'remote-receipt:existing']))
    expect(session.queue.get('promote-add')?.envelope).toMatchObject({ attachmentRefs: ['local-receipt:receipt-001', 'remote-receipt:existing'] })
    await expect(handle.result()).resolves.toMatchObject({
      status: 'saved',
      expense: { attachmentRefs: ['remote-receipt:receipt-001', 'remote-receipt:existing'] },
    })

    expect(events).toEqual(['upload:lake-house-weekend:local-receipt:receipt-001', 'execute'])
    expect(executed[0]).toMatchObject({ attachmentRefs: ['remote-receipt:receipt-001', 'remote-receipt:existing'] })
    expect(session.queue.get('promote-add')?.envelope).toMatchObject({ attachmentRefs: ['local-receipt:receipt-001', 'remote-receipt:existing'] })
    expect(await storage.load(appPrincipalKey({ mode: repository.mode, projectId: repository.projectId, uid: 'maya-p' }))).toMatchObject({
      operations: [{ envelope: { attachmentRefs: ['local-receipt:receipt-001', 'remote-receipt:existing'] } }],
    })
    await expect(receipts.get('local-receipt:receipt-001')).resolves.toMatchObject({
      durability: { status: 'uploaded', attachmentRef: 'remote-receipt:receipt-001' },
    })
  })

  it('replays the receipt execution mapping frozen before a terminal persistence crash', async () => {
    const repository = createDemoRepository()
    const receipts = createMemoryReceiptStore({ id: () => 'frozen-receipt' })
    await receipts.put(new Blob(['receipt'], { type: 'image/jpeg' }), { fileName: 'receipt.jpg' })
    let persisted: unknown
    let terminalFailures = 1
    const storage = {
      load: () => persisted,
      async save(_scopeKey: string, document: { readonly operations: readonly { readonly status: string }[] }) {
        if (terminalFailures > 0 && document.operations.some((operation) => operation.status === 'fresh')) { terminalFailures -= 1; throw new Error('terminal write failed') }
        persisted = JSON.parse(JSON.stringify(document))
      },
    }
    const uploads: string[] = []
    const executed: CommandEnvelope[] = []
    let attempt = 0
    const provider: ReceiptProvider = {
      async upload(_groupId, reference) {
        uploads.push(reference)
        attempt += 1
        return attempt === 1
          ? { status: 'unavailable', reason: 'Offline during first execution.' }
          : { status: 'uploaded', attachmentRef: 'remote-receipt:frozen-receipt' }
      },
      async recognize() { return { status: 'unavailable', reason: 'Not used.' } },
      async delete() { /* no remote asset exists */ },
    }
    const recordingRepository = { ...repository, commands: { execute: async (command: CommandEnvelope) => {
      executed.push(JSON.parse(JSON.stringify(command)) as CommandEnvelope)
      return repository.commands.execute(command)
    } } }
    const command = expenseAdd('frozen-execution-map', ['local-receipt:frozen-receipt'])
    const first = createAppSession({ repository: recordingRepository, commandStorage: storage, receipts, receiptProvider: provider })
    await first.ready

    await expect(first.queue.submit(command).result()).rejects.toMatchObject({ code: 'persistence', executed: true })
    expect(persisted).toMatchObject({
      operations: [{ status: 'pending', executionEnvelope: { attachmentRefs: ['local-receipt:frozen-receipt'] } }],
    })

    const second = createAppSession({ repository: recordingRepository, commandStorage: storage, receipts, receiptProvider: provider })
    await second.ready
    await expect(second.queue.submit(command).result()).resolves.toMatchObject({
      status: 'saved', expense: { attachmentRefs: ['local-receipt:frozen-receipt'] },
    })
    expect(uploads).toEqual(['local-receipt:frozen-receipt'])
    expect(executed).toHaveLength(2)
    expect(executed.every((entry) => entry.kind === 'expense.add' && entry.attachmentRefs[0] === 'local-receipt:frozen-receipt')).toBe(true)
  })

  it('keeps an unavailable local receipt fallback honest when editing an expense', async () => {
    const demo = createDemoRepository()
    const existing = await demo.expenses.getById('lake-house-weekend', 'groceries')
    if (!existing) throw new Error('Missing fixture expense')
    const executed: CommandEnvelope[] = []
    const repository = {
      ...demo,
      commands: { execute: async (command: CommandEnvelope) => {
        executed.push(JSON.parse(JSON.stringify(command)) as CommandEnvelope)
        return demo.commands.execute(command)
      } },
    }
    const provider = receiptProvider(async () => ({ status: 'unavailable', reason: 'Offline; receipt remains on this device.' }))
    const receipts = createMemoryReceiptStore({ id: () => 'offline-edit' })
    await receipts.put(new Blob(['receipt'], { type: 'image/jpeg' }), { fileName: 'receipt.jpg' })
    const session = createAppSession({ repository, commandStorage: createMemoryCommandStorage(), receipts, receiptProvider: provider })
    await session.ready

    const command: Extract<CommandEnvelope, { kind: 'expense.edit' }> = {
      kind: 'expense.edit',
      operationId: 'fallback-edit',
      groupId: existing.groupId,
      expenseId: existing.id,
      expectedRevision: existing.revision,
      draft: {
        groupId: existing.groupId,
        description: existing.description,
        date: existing.date,
        total: existing.total,
        payments: existing.payments,
        allocations: existing.allocations,
        category: existing.category,
        splitMethod: existing.splitMethod,
        attachmentRefs: ['local-receipt:offline-edit'],
      },
    }
    await expect(session.queue.submit(command).result()).resolves.toMatchObject({
      status: 'saved',
      expense: { attachmentRefs: ['local-receipt:offline-edit'] },
    })

    expect(executed[0]).toMatchObject({ draft: { attachmentRefs: ['local-receipt:offline-edit'] } })
    expect(session.queue.get('fallback-edit')?.envelope).toMatchObject({ draft: { attachmentRefs: ['local-receipt:offline-edit'] } })
    await expect(receipts.get('local-receipt:offline-edit')).resolves.toMatchObject({
      durability: { status: 'upload-unavailable', reason: 'Offline; receipt remains on this device.' },
    })
  })

  it('omits an explicitly device-only receipt from the execution copy while preserving the durable draft', async () => {
    const demo = createDemoRepository()
    const executed: CommandEnvelope[] = []
    const repository = {
      ...demo,
      commands: { execute: async (command: CommandEnvelope) => {
        executed.push(JSON.parse(JSON.stringify(command)) as CommandEnvelope)
        return demo.commands.execute(command)
      } },
    }
    const receipts = createMemoryReceiptStore({ id: () => 'device-only' })
    await receipts.put(new Blob(['receipt'], { type: 'image/jpeg' }), { fileName: 'receipt.jpg' })
    const provider = receiptProvider(async () => ({ status: 'local-only', reason: 'Cloud receipt upload is not configured.' }))
    const session = createAppSession({ repository, commandStorage: createMemoryCommandStorage(), receipts, receiptProvider: provider })
    await session.ready

    await expect(session.queue.submit(expenseAdd('device-only-add', ['local-receipt:device-only'])).result()).resolves.toMatchObject({
      status: 'saved', expense: { attachmentRefs: [] },
    })

    expect(executed[0]).toMatchObject({ attachmentRefs: [] })
    expect(session.queue.get('device-only-add')?.envelope).toMatchObject({ attachmentRefs: ['local-receipt:device-only'] })
    await expect(receipts.get('local-receipt:device-only')).resolves.toMatchObject({
      durability: { status: 'local-only' },
    })
  })

  it('persists a thrown upload reason while leaving the command normally retryable', async () => {
    const receipts = createMemoryReceiptStore({ id: () => 'throw-then-retry' })
    const reference = await receipts.put(new Blob(['receipt'], { type: 'image/jpeg' }), { fileName: 'receipt.jpg' })
    let attempts = 0
    const provider = receiptProvider(async () => {
      attempts += 1
      if (attempts === 1) throw Object.assign(new Error('Receipt provider timed out.'), { code: 'unavailable' })
      return { status: 'uploaded', attachmentRef: 'remote-receipt:throw-then-retry' }
    })
    const session = createAppSession({
      repository: createDemoRepository(), commandStorage: createMemoryCommandStorage(), receipts, receiptProvider: provider,
    })
    await session.ready

    await expect(session.queue.submit(expenseAdd('throw-then-retry', [reference])).result()).rejects.toThrow('Receipt provider timed out.')
    expect(session.queue.get('throw-then-retry')).toMatchObject({
      status: 'failed',
      error: { code: 'network', retryable: true },
    })
    await expect(receipts.get(reference)).resolves.toMatchObject({
      durability: { status: 'upload-unavailable', reason: 'Receipt provider timed out.' },
    })

    await expect(session.queue.retry('throw-then-retry').result()).resolves.toMatchObject({
      status: 'saved',
      expense: { attachmentRefs: ['remote-receipt:throw-then-retry'] },
    })
    await expect(receipts.get(reference)).resolves.toMatchObject({
      durability: { status: 'uploaded', attachmentRef: 'remote-receipt:throw-then-retry' },
    })
    expect(attempts).toBe(2)
  })

  it('persists an honest fallback when an upload failure has no message', async () => {
    const receipts = createMemoryReceiptStore({ id: () => 'message-less-failure' })
    const reference = await receipts.put(new Blob(['receipt'], { type: 'image/jpeg' }), { fileName: 'receipt.jpg' })
    const provider = receiptProvider(async () => { throw { code: 'unavailable' } })

    await expect(sessionModule.prepareCommandReceipts(
      expenseAdd('message-less-failure', [reference]),
      provider,
      receipts,
    )).rejects.toMatchObject({ code: 'unavailable' })

    await expect(receipts.get(reference)).resolves.toMatchObject({
      durability: {
        status: 'upload-unavailable',
        reason: 'Receipt upload failed. The image remains only on this device until upload succeeds.',
      },
    })
  })

  it('reuses an already-uploaded local asset without regressing its durability', async () => {
    const receipts = createMemoryReceiptStore({ id: () => 'already-uploaded' })
    const reference = await receipts.put(new Blob(['receipt'], { type: 'image/jpeg' }), { fileName: 'receipt.jpg' })
    await receipts.setDurability(reference, { status: 'uploaded', attachmentRef: 'remote-receipt:already-uploaded' })
    let uploadCalls = 0
    const session = createAppSession({
      repository: createDemoRepository(), commandStorage: createMemoryCommandStorage(), receipts,
      receiptProvider: receiptProvider(async () => {
        uploadCalls += 1
        return { status: 'unavailable', reason: 'This must not regress an uploaded asset.' }
      }),
    })
    await session.ready

    await expect(session.queue.submit(expenseAdd('reuse-uploaded', [reference])).result()).resolves.toMatchObject({
      status: 'saved',
      expense: { attachmentRefs: ['remote-receipt:already-uploaded'] },
    })

    expect(uploadCalls).toBe(0)
    await expect(receipts.get(reference)).resolves.toMatchObject({
      durability: { status: 'uploaded', attachmentRef: 'remote-receipt:already-uploaded' },
    })
    expect(session.queue.get('reuse-uploaded')?.envelope).toMatchObject({ attachmentRefs: [reference] })
  })

  it('shares one repository and queue across feature consumers', () => {
    setAppSessionForTesting(createAppSession({ commandStorage: createMemoryCommandStorage() }))
    const first = getAppSession()
    const second = getAppSession()
    expect(second.repository).toBe(first.repository)
    expect(second.queue).toBe(first.queue)
    setAppSessionForTesting(undefined)
  })

  it('refuses to manufacture a demo session before the authenticated owner is activated', () => {
    setAppSessionForTesting(undefined)

    expect(() => getAppSession()).toThrow('App data session is not active')

    expect(sessionModule.peekActiveAppSession()).toBeUndefined()
  })

  it('provides deterministic repository and storage seams for tests', async () => {
    const repository = createDemoRepository()
    const session = createAppSession({ repository, commandStorage: createMemoryCommandStorage() })
    setAppSessionForTesting(session)

    await session.ready

    const operation = getAppSession().queue.submit({
      kind: 'expense.add', operationId: 'session-add', groupId: 'lake-house-weekend', description: 'Ice', date: '2026-08-30',
      total: { currency: 'USD', minorAmount: 400 }, payments: [{ participantId: 'maya-p', money: { currency: 'USD', minorAmount: 400 } }],
      allocations: [
        { participantId: 'maya-p', money: { currency: 'USD', minorAmount: 100 } },
        { participantId: 'jordan-k', money: { currency: 'USD', minorAmount: 100 } },
        { participantId: 'alex-r', money: { currency: 'USD', minorAmount: 100 } },
        { participantId: 'taylor-s', money: { currency: 'USD', minorAmount: 100 } },
      ],
      category: 'Supplies', splitMethod: { type: 'equal', participantIds: ['maya-p', 'jordan-k', 'alex-r', 'taylor-s'] }, attachmentRefs: [],
    })

    await expect(operation.result()).resolves.toMatchObject({ status: 'saved', expense: { description: 'Ice' } })
    await expect(repository.expenses.listForGroup('lake-house-weekend')).resolves.toHaveLength(6)
    setAppSessionForTesting(undefined)
  })

  it('quiesces reversibly and clears only non-pending local queue and receipt state', async () => {
    const receipts = createMemoryReceiptStore({ id: () => 'clear-local' })
    const closeReceipts = vi.fn(async () => undefined)
    receipts.close = closeReceipts
    const receipt = await receipts.put(new Blob(['image'], { type: 'image/jpeg' }), { fileName: 'receipt.jpg' })
    const session = createAppSession({ repository: createDemoRepository(), commandStorage: createMemoryCommandStorage(), receipts })
    await session.ready
    await session.queue.submit({ kind: 'profile.update', operationId: 'saved-local', displayName: 'Maya P.' }).result()

    expect(session.quiesce()).toEqual({ pending: 0, failed: 0, conflicted: 0, total: 0 })
    expect(() => session.queue.submit({ kind: 'profile.update', operationId: 'blocked-local', displayName: 'Blocked' })).toThrow('paused')
    await session.clearLocalData()
    expect(session.queue.snapshot()).toEqual([])
    await expect(receipts.get(receipt)).resolves.toBeUndefined()
    expect(closeReceipts).toHaveBeenCalledOnce()

    session.resumeWork()
    await expect(session.queue.submit({ kind: 'profile.update', operationId: 'after-resume', displayName: 'Maya P.' }).result()).resolves.toMatchObject({ status: 'saved' })
  })
})

type PrincipalFixture = { readonly mode: 'demo' | 'firebase'; readonly projectId: string; readonly uid: string }

function expenseAdd(operationId: string, attachmentRefs: readonly string[]): Extract<CommandEnvelope, { kind: 'expense.add' }> {
  return {
    kind: 'expense.add', operationId, groupId: 'lake-house-weekend', description: 'Ice', date: '2026-08-30',
    total: { currency: 'USD', minorAmount: 400 }, payments: [{ participantId: 'maya-p', money: { currency: 'USD', minorAmount: 400 } }],
    allocations: [
      { participantId: 'maya-p', money: { currency: 'USD', minorAmount: 100 } },
      { participantId: 'jordan-k', money: { currency: 'USD', minorAmount: 100 } },
      { participantId: 'alex-r', money: { currency: 'USD', minorAmount: 100 } },
      { participantId: 'taylor-s', money: { currency: 'USD', minorAmount: 100 } },
    ],
    category: 'Supplies', splitMethod: { type: 'equal', participantIds: ['maya-p', 'jordan-k', 'alex-r', 'taylor-s'] }, attachmentRefs,
  }
}

function receiptProvider(upload: ReceiptProvider['upload']): ReceiptProvider {
  return {
    upload,
    async recognize(_reference: LocalReceiptReference) { return { status: 'unavailable', reason: 'Not used in session promotion.' } },
    async delete() { /* no remote cleanup in this controlled provider */ },
  }
}
