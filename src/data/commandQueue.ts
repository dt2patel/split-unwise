import type { CommandEnvelope, CommandKind, CommandResult, SyncState } from './repositories'
import { assertOperationId, canonicalEnvelopeFingerprint, OperationReplayConflictError } from './operationIdentity'

export interface CommandFailure { readonly message: string; readonly conflict?: unknown }
export class CommandConflictError extends Error {
  readonly conflict: unknown
  constructor(message: string, conflict?: unknown) { super(message); this.name = 'CommandConflictError'; this.conflict = conflict }
}

export type CommandOperation =
  | { readonly status: 'pending'; readonly envelope: CommandEnvelope }
  | { readonly status: 'fresh' | 'stale'; readonly envelope: CommandEnvelope; readonly result: CommandResult }
  | { readonly status: 'failed'; readonly envelope: CommandEnvelope; readonly error: CommandFailure }
  | { readonly status: 'conflicted'; readonly envelope: CommandEnvelope; readonly error: CommandFailure; readonly conflict: unknown }

export interface CommandStorage { load(): readonly CommandOperation[]; save(operations: readonly CommandOperation[]): void }
export interface CommandHandle { readonly operationId: string; result(): Promise<CommandResult> }
export type CommandHandler = (command: CommandEnvelope) => Promise<CommandResult>
export type CommandHandlers = Partial<Record<CommandKind, CommandHandler>>
export interface CommandQueueOptions { readonly handlers: CommandHandlers; readonly storage?: CommandStorage }

/** Serializable, timer-free queue. Commands are persisted before registered handlers run. */
export class CommandQueue {
  private readonly operations = new Map<string, CommandOperation>()
  private readonly listeners = new Set<(operation: CommandOperation) => void>()
  private readonly running = new Map<string, Promise<void>>()
  private readonly storage: CommandStorage

  constructor(private readonly options: CommandQueueOptions) {
    this.storage = options.storage ?? createBrowserCommandStorage()
    for (const operation of this.storage.load()) this.operations.set(operation.envelope.operationId, operation)
  }

  submit(command: CommandEnvelope): CommandHandle {
    assertOperationId(command.operationId)
    const existing = this.operations.get(command.operationId)
    if (existing) {
      if (canonicalEnvelopeFingerprint(existing.envelope) !== canonicalEnvelopeFingerprint(command)) {
        const error = new OperationReplayConflictError()
        this.replace({ status: 'conflicted', envelope: existing.envelope, error: toFailure(error), conflict: { existingFingerprint: canonicalEnvelopeFingerprint(existing.envelope), requestedFingerprint: canonicalEnvelopeFingerprint(command) } })
      }
      return this.handle(command.operationId)
    }
    this.replace({ status: 'pending', envelope: clone(command) })
    this.start(command.operationId)
    return this.handle(command.operationId)
  }

  retry(operationId: string): CommandHandle {
    const operation = this.operations.get(operationId)
    if (!operation || operation.status !== 'failed') return rejectedHandle(operationId, new Error('Only failed operations can be retried'))
    this.replace({ status: 'pending', envelope: operation.envelope })
    this.start(operationId)
    return this.handle(operationId)
  }

  get(operationId: string): CommandOperation | undefined { return this.operations.get(operationId) }
  subscribe(listener: (operation: CommandOperation) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  markStale(operationId: string): CommandOperation { return this.setReadState(operationId, 'stale') }
  markFresh(operationId: string): CommandOperation { return this.setReadState(operationId, 'fresh') }

  async resume(): Promise<void> {
    const pending = [...this.operations.values()].filter((operation): operation is Extract<CommandOperation, { status: 'pending' }> => operation.status === 'pending')
    await Promise.all(pending.map((operation) => this.start(operation.envelope.operationId)))
  }

  private handle(operationId: string): CommandHandle { return { operationId, result: async () => this.readResult(operationId) } }
  private async readResult(operationId: string): Promise<CommandResult> {
    const operation = this.operations.get(operationId)
    if (!operation) throw new Error(`Unknown operation: ${operationId}`)
    if (operation.status === 'pending') {
      const running = this.running.get(operationId)
      if (!running) throw new Error(`Operation ${operationId} is pending and has no registered handler`)
      await running
      return this.readResult(operationId)
    }
    if (operation.status === 'fresh' || operation.status === 'stale') return operation.result
    if (operation.status === 'conflicted') throw new CommandConflictError(operation.error.message, operation.conflict)
    if (operation.status === 'failed') throw new Error(operation.error.message)
    throw new Error(`Operation ${operationId} is unavailable`)
  }

  private start(operationId: string): Promise<void> {
    const active = this.running.get(operationId)
    if (active) return active
    const operation = this.operations.get(operationId)
    if (!operation || operation.status !== 'pending') return Promise.resolve()
    const handler = this.options.handlers[operation.envelope.kind]
    if (!handler) return Promise.resolve()
    const running = Promise.resolve()
      .then(() => handler(operation.envelope))
      .then((result) => {
        if (result.operationId !== operationId || result.kind !== operation.envelope.kind) throw new Error('Command handler returned a mismatched result')
        const current = this.operations.get(operationId)
        if (current?.status === 'pending' && canonicalEnvelopeFingerprint(current.envelope) === canonicalEnvelopeFingerprint(operation.envelope)) {
          this.replace({ status: 'fresh', envelope: operation.envelope, result: clone(result) })
        }
      })
      .catch((error: unknown) => {
        const current = this.operations.get(operationId)
        if (current?.status !== 'pending' || canonicalEnvelopeFingerprint(current.envelope) !== canonicalEnvelopeFingerprint(operation.envelope)) return
        const failure = toFailure(error)
        if (error instanceof CommandConflictError) this.replace({ status: 'conflicted', envelope: operation.envelope, error: failure, conflict: error.conflict })
        else if (error instanceof OperationReplayConflictError) this.replace({ status: 'conflicted', envelope: operation.envelope, error: failure, conflict: { reason: 'replay-identity' } })
        else this.replace({ status: 'failed', envelope: operation.envelope, error: failure })
      })
      .finally(() => { this.running.delete(operationId) })
    this.running.set(operationId, running)
    return running
  }

  private setReadState(operationId: string, status: Extract<SyncState, 'fresh' | 'stale'>): CommandOperation {
    const operation = this.operations.get(operationId)
    if (!operation || (operation.status !== 'fresh' && operation.status !== 'stale')) throw new Error('Only fresh or stale operations can be marked stale or fresh')
    const updated = { ...operation, status }
    this.replace(updated)
    return updated
  }

  private replace(operation: CommandOperation): void {
    this.operations.set(operation.envelope.operationId, operation)
    this.storage.save([...this.operations.values()])
    this.listeners.forEach((listener) => { try { listener(operation) } catch { /* subscribers cannot affect durable command state */ } })
  }
}

export function createMemoryCommandStorage(initial: readonly CommandOperation[] = []): CommandStorage {
  let contents = clone(initial)
  return { load: () => clone(contents), save: (operations) => { contents = clone(operations) } }
}
export function createBrowserCommandStorage(key = 'split-unwise:command-queue:v1'): CommandStorage {
  return {
    load: () => { try { const value = globalThis.localStorage?.getItem(key); return value ? JSON.parse(value) as readonly CommandOperation[] : [] } catch { return [] } },
    save: (operations) => { try { globalThis.localStorage?.setItem(key, JSON.stringify(operations)) } catch { /* unavailable storage leaves the in-memory queue usable */ } },
  }
}
function rejectedHandle(operationId: string, error: Error): CommandHandle { return { operationId, result: () => Promise.reject(error) } }
function toFailure(error: unknown): CommandFailure { return { message: error instanceof Error ? error.message : String(error) } }
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T }
