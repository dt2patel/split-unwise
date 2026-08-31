import { CommandQueue, createBrowserCommandStorage, type CommandOperation, type CommandStorage } from './commandQueue'
import { appPrincipalKey, type AppPrincipal } from './principal'
import { createRepository } from './repositoryFactory'
import type { AppRepository, CommandEnvelope, CommandKind } from './repositories'
import { createDemoReceiptProvider, createIndexedDbReceiptStore, type LocalReceiptReference, type ReceiptBlobStore, type ReceiptProvider } from './receipts'

export { appPrincipalKey } from './principal'
export type { AppPrincipal } from './principal'

export type AppCommandQueue = Pick<CommandQueue,
  'acknowledge' | 'discard' | 'get' | 'markFresh' | 'markStale' | 'resume' | 'retry' | 'snapshot' | 'submit' | 'subscribe'
>

export class StaleAppSessionError extends Error {
  constructor() {
    super('App session is no longer active')
    this.name = 'StaleAppSessionError'
  }
}

export interface AppDataSession {
  readonly repository: AppRepository
  readonly queue: AppCommandQueue
  readonly receipts: ReceiptBlobStore
  readonly receiptProvider: ReceiptProvider
  readonly principal: Promise<AppPrincipal>
  readonly isActive: boolean
  /** Resolves only after repository identity has scoped and resumed the durable queue. */
  readonly ready: Promise<void>
  /** Permanently prevents repository calls and invalidates unfinished initialization. */
  freeze(): void
}

export interface AppSessionOptions {
  readonly repository?: AppRepository
  readonly principal?: AppPrincipal
  readonly commandStorage?: CommandStorage
  readonly commandStorageFactory?: (principal: AppPrincipal) => CommandStorage
  readonly receipts?: ReceiptBlobStore
  readonly receiptStoreFactory?: (principal: AppPrincipal, namespace: string) => ReceiptBlobStore
  readonly receiptProvider?: ReceiptProvider
}

export interface AppSessionCoordinatorOptions {
  readonly createSession: (principal: AppPrincipal) => AppDataSession
  readonly resetFeatureStores: () => void | Promise<void>
  readonly activateSession: (session: AppDataSession) => void | Promise<void>
}

export interface AppSessionCoordinator {
  transition(principal: AppPrincipal | undefined): Promise<void>
  stop(): Promise<void>
}

export interface MountedFeatureApp {
  unmount(): void
  disposeFeatureStores(): void
}

export interface AppSessionMountHostOptions {
  readonly setSession: (session: AppDataSession | undefined) => void
  readonly mount: (session: AppDataSession) => MountedFeatureApp | Promise<MountedFeatureApp>
}

let activeSession: AppDataSession | undefined

export function createAppSession(options: AppSessionOptions = {}): AppDataSession {
  const sourceRepository = options.repository ?? createRepository()
  let active = true
  let rejectFrozen!: (reason: StaleAppSessionError) => void
  const frozen = new Promise<never>((_resolve, reject) => { rejectFrozen = reject })
  const assertActive = () => { if (!active) throw new StaleAppSessionError() }
  const repository = guardRepository(sourceRepository, assertActive)
  const deferredQueue = new DeferredCommandQueue()
  let receiptStore: ReceiptBlobStore | undefined = options.receipts
  const receiptProvider = options.receiptProvider ?? createDemoReceiptProvider()

  const resolvedPrincipal = sourceRepository.app.getCurrentUser().then((user) => {
    const principal = options.principal ?? {
      mode: sourceRepository.mode,
      projectId: sourceRepository.projectId,
      uid: user.id,
    }
    assertActive()
    assertRepositoryPrincipal(sourceRepository, principal)
    if (user.id !== principal.uid) throw new Error('App principal does not match the authenticated user')
    appPrincipalKey(principal)
    return principal
  })

  const initialization = resolvedPrincipal.then(async (principal) => {
    assertActive()
    const namespace = appPrincipalKey(principal)
    const storage = options.commandStorage ?? (options.commandStorageFactory ?? (() => createBrowserCommandStorage()))(principal)
    assertActive()
    receiptStore ??= (options.receiptStoreFactory ?? ((owner, key) => createIndexedDbReceiptStore({ namespace: key })))(principal, namespace)
    assertActive()

    const execute = async (command: CommandEnvelope) => {
      assertActive()
      const result = await repository.commands.execute(command)
      assertActive()
      return result
    }
    const kinds: readonly CommandKind[] = [
      'comment.add',
      'expense.add',
      'expense.delete',
      'expense.edit',
      'group.default-split',
      'profile.update',
      'settlement.record',
    ]
    const handlers = Object.fromEntries(kinds.map((kind) => [kind, execute]))
    const queue = new CommandQueue({
      handlers,
      storage,
      prepare: async (command) => {
        assertActive()
        const receipts = receiptStore
        if (!receipts) throw new Error('Receipt store is unavailable')
        const prepared = await prepareCommandReceipts(command, receiptProvider, receipts)
        assertActive()
        return prepared
      },
      shouldPersistExecution: (original) => hasLocalReceiptAttachment(original),
    })
    await queue.bind(namespace)
    await queue.resume()
    assertActive()
    deferredQueue.attach(queue)
  })
  const ready = Promise.race([initialization, frozen])
  const receipts = deferredReceiptStore(() => ready, () => receiptStore, assertActive)

  const session: AppDataSession = {
    repository,
    queue: deferredQueue,
    receipts,
    receiptProvider,
    principal: Promise.race([resolvedPrincipal, frozen]),
    get isActive() { return active },
    ready,
    freeze() {
      if (!active) return
      active = false
      deferredQueue.freeze()
      rejectFrozen(new StaleAppSessionError())
    },
  }
  return session
}

export function getAppSession(): AppDataSession {
  return activeSession ??= createAppSession()
}

export function setActiveAppSession(session: AppDataSession | undefined): void {
  activeSession = session
}

/** Replaces or resets the singleton without adding test-only methods to production classes. */
export function setAppSessionForTesting(session: AppDataSession | undefined): void {
  setActiveAppSession(session)
}

/** Serializes identity transitions and enforces reset-before-replacement construction. */
export function createAppSessionCoordinator(options: AppSessionCoordinatorOptions): AppSessionCoordinator {
  let generation = 0
  let announcedKey: string | undefined
  let current: AppDataSession | undefined
  let candidate: AppDataSession | undefined
  let serial = Promise.resolve()

  const transition = (principal: AppPrincipal | undefined): Promise<void> => {
    const nextKey = principal ? appPrincipalKey(principal) : undefined
    if (nextKey === announcedKey) return serial
    announcedKey = nextKey
    const transitionGeneration = ++generation
    current?.freeze()
    candidate?.freeze()

    const run = serial.catch(() => undefined).then(async () => {
      if (transitionGeneration !== generation) return
      if (current) {
        await options.resetFeatureStores()
        current = undefined
      }
      if (transitionGeneration !== generation || !principal) return

      const next = options.createSession(principal)
      candidate = next
      try {
        await next.ready
      } catch (error: unknown) {
        if (error instanceof StaleAppSessionError || transitionGeneration !== generation) return
        throw error
      } finally {
        if (candidate === next) candidate = undefined
      }
      if (transitionGeneration !== generation || !next.isActive) return
      current = next
      await options.activateSession(next)
      if (transitionGeneration !== generation || !next.isActive) current = undefined
    }).catch((error: unknown) => {
      if (transitionGeneration === generation && announcedKey === nextKey) announcedKey = undefined
      throw error
    })
    serial = run
    return run
  }

  return {
    transition,
    async stop() {
      announcedKey = undefined
      ++generation
      candidate?.freeze()
      current?.freeze()
      candidate = undefined
      if (current) await options.resetFeatureStores()
      current = undefined
    },
  }
}

/** Owns the concrete UI/store teardown used by the auth coordinator. */
export function createAppSessionMountHost(options: AppSessionMountHostOptions): Pick<AppSessionCoordinatorOptions, 'activateSession' | 'resetFeatureStores'> {
  let mounted: MountedFeatureApp | undefined

  const resetFeatureStores = async () => {
    options.setSession(undefined)
    const previous = mounted
    mounted = undefined
    if (!previous) return
    try { previous.unmount() } finally { previous.disposeFeatureStores() }
  }

  return {
    resetFeatureStores,
    async activateSession(session) {
      if (mounted) await resetFeatureStores()
      if (!session.isActive) return
      options.setSession(session)
      let next: MountedFeatureApp
      try {
        next = await options.mount(session)
      } catch (error: unknown) {
        options.setSession(undefined)
        throw error
      }
      if (!session.isActive) {
        options.setSession(undefined)
        try { next.unmount() } finally { next.disposeFeatureStores() }
        return
      }
      mounted = next
    },
  }
}

class DeferredCommandQueue implements AppCommandQueue {
  private target: CommandQueue | undefined
  private readonly listeners = new Map<(operation: CommandOperation) => void, () => void>()
  private frozen = false

  attach(queue: CommandQueue): void {
    if (this.frozen) throw new StaleAppSessionError()
    if (this.target) throw new Error('Command queue is already initialized')
    this.target = queue
    for (const listener of this.listeners.keys()) this.listeners.set(listener, queue.subscribe(listener))
  }

  freeze(): void {
    if (this.frozen) return
    this.frozen = true
    for (const unsubscribe of this.listeners.values()) unsubscribe()
    this.listeners.clear()
  }
  submit(command: Parameters<CommandQueue['submit']>[0]): ReturnType<CommandQueue['submit']> { return this.requireQueue().submit(command) }
  retry(operationId: string): ReturnType<CommandQueue['retry']> { return this.requireQueue().retry(operationId) }
  get(operationId: string): ReturnType<CommandQueue['get']> { return this.target?.get(operationId) }
  snapshot(): ReturnType<CommandQueue['snapshot']> { return this.target?.snapshot() ?? [] }
  discard(operationId: string): ReturnType<CommandQueue['discard']> { return this.requireQueue().discard(operationId) }
  acknowledge(operationId: string): ReturnType<CommandQueue['acknowledge']> { return this.requireQueue().acknowledge(operationId) }
  markStale(operationId: string): ReturnType<CommandQueue['markStale']> { return this.requireQueue().markStale(operationId) }
  markFresh(operationId: string): ReturnType<CommandQueue['markFresh']> { return this.requireQueue().markFresh(operationId) }
  resume(): ReturnType<CommandQueue['resume']> { return this.requireQueue().resume() }
  subscribe(listener: (operation: CommandOperation) => void): () => void {
    if (this.frozen) throw new StaleAppSessionError()
    this.listeners.set(listener, this.target?.subscribe(listener) ?? (() => undefined))
    return () => {
      this.listeners.get(listener)?.()
      this.listeners.delete(listener)
    }
  }

  private requireQueue(): CommandQueue {
    if (this.frozen) throw new StaleAppSessionError()
    if (!this.target) throw new Error('Command queue requires an authenticated owner before use')
    return this.target
  }
}

function deferredReceiptStore(
  ready: () => Promise<void>,
  store: () => ReceiptBlobStore | undefined,
  assertActive: () => void,
): ReceiptBlobStore {
  const resolved = async () => {
    await ready()
    assertActive()
    const receiptStore = store()
    if (!receiptStore) throw new Error('Receipt store is unavailable')
    return receiptStore
  }
  return {
    async put(blob, metadata) { return (await resolved()).put(blob, metadata) },
    async get(reference) { return (await resolved()).get(reference) },
    async setDurability(reference, durability) { await (await resolved()).setDurability(reference, durability) },
    async claim(reference, operationId) { return (await resolved()).claim(reference, operationId) },
    async delete(reference) { await (await resolved()).delete(reference) },
  }
}

function guardRepository(source: AppRepository, assertActive: () => void): AppRepository {
  const call = async <T>(operation: () => Promise<T>): Promise<T> => {
    assertActive()
    const result = await operation()
    assertActive()
    return result
  }
  return {
    mode: source.mode,
    projectId: source.projectId,
    app: {
      getCurrentUser: () => call(() => source.app.getCurrentUser()),
      updateProfile: (command) => call(() => source.app.updateProfile(command)),
    },
    groups: {
      list: () => call(() => source.groups.list()),
      getById: (groupId) => call(() => source.groups.getById(groupId)),
      listMembers: (groupId) => call(() => source.groups.listMembers(groupId)),
      getBalances: (groupId) => call(() => source.groups.getBalances(groupId)),
      getTotals: (groupId) => call(() => source.groups.getTotals(groupId)),
      getCharts: (groupId) => call(() => source.groups.getCharts(groupId)),
      listRecurring: (groupId) => call(() => source.groups.listRecurring(groupId)),
      setDefaultSplit: (command) => call(() => source.groups.setDefaultSplit(command)),
    },
    expenses: {
      listForGroup: (groupId) => call(() => source.expenses.listForGroup(groupId)),
      getById: (groupId, expenseId) => call(() => source.expenses.getById(groupId, expenseId)),
      add: (command) => call(() => source.expenses.add(command)),
      edit: (command) => call(() => source.expenses.edit(command)),
      delete: (command) => call(() => source.expenses.delete(command)),
      listComments: (groupId, expenseId) => call(() => source.expenses.listComments(groupId, expenseId)),
    },
    comments: { add: (command) => call(() => source.comments.add(command)) },
    settlements: { record: (command) => call(() => source.settlements.record(command)) },
    activity: { listForGroup: (groupId) => call(() => source.activity.listForGroup(groupId)) },
    commands: { execute: (command) => call(() => source.commands.execute(command)) },
  }
}

function assertRepositoryPrincipal(repository: AppRepository, principal: AppPrincipal): void {
  if (repository.mode !== principal.mode || repository.projectId !== principal.projectId) {
    throw new Error('App principal does not match the repository mode and project')
  }
}

/**
 * Promotes only the execution copy. The queue envelope deliberately keeps its
 * durable local references so a failed or resumed command can retry upload.
 */
export async function prepareCommandReceipts(command: CommandEnvelope, provider: ReceiptProvider, receipts?: ReceiptBlobStore): Promise<CommandEnvelope> {
  if (command.kind === 'expense.add') {
    return { ...command, attachmentRefs: await promoteAttachmentRefs(command.groupId, command.attachmentRefs, provider, receipts) }
  }
  if (command.kind === 'expense.edit') {
    return { ...command, draft: { ...command.draft, attachmentRefs: await promoteAttachmentRefs(command.groupId, command.draft.attachmentRefs, provider, receipts) } }
  }
  return command
}

async function promoteAttachmentRefs(groupId: string, references: readonly string[], provider: ReceiptProvider, receipts?: ReceiptBlobStore): Promise<readonly string[]> {
  return Promise.all(references.map(async (reference) => {
    if (!isLocalReceiptReference(reference)) return reference
    const existing = await receipts?.get(reference)
    if (existing?.durability.status === 'uploaded') return existing.durability.attachmentRef
    let upload
    try {
      upload = await provider.upload(groupId, reference)
    } catch (reason) {
      await receipts?.setDurability(reference, {
        status: 'upload-unavailable',
        reason: receiptUploadFailureReason(reason),
      })
      throw reason
    }
    if (upload.status === 'uploaded') {
      await receipts?.setDurability(reference, { status: 'uploaded', attachmentRef: upload.attachmentRef })
      return upload.attachmentRef
    }
    await receipts?.setDurability(reference, {
      status: 'upload-unavailable',
      reason: upload.reason.trim() || 'Receipt upload is unavailable. The image remains only on this device.',
    })
    return reference
  }))
}

function isLocalReceiptReference(value: string): value is LocalReceiptReference {
  return /^local-receipt:[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)
}

function hasLocalReceiptAttachment(command: CommandEnvelope): boolean {
  const references = command.kind === 'expense.edit' ? command.draft.attachmentRefs : command.kind === 'expense.add' ? command.attachmentRefs : []
  return references.some(isLocalReceiptReference)
}

function receiptUploadFailureReason(reason: unknown): string {
  if (reason instanceof Error && reason.message.trim()) return reason.message.trim()
  if (typeof reason === 'string' && reason.trim()) return reason.trim()
  return 'Receipt upload failed. The image remains only on this device until upload succeeds.'
}
