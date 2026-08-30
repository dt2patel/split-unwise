import type { SyncState } from './repositories'

export interface ClientCommand<T> {
  /** Stable client-generated operation ID. Reusing it never repeats side effects. */
  readonly id: string
  readonly execute: () => Promise<T>
}

export interface CommandOperation<T = unknown> {
  readonly id: string
  readonly status: SyncState
  readonly result?: T
  readonly error?: Error
  readonly conflict?: unknown
}

export class CommandConflictError extends Error {
  readonly conflict: unknown

  constructor(message: string, conflict?: unknown) {
    super(message)
    this.name = 'CommandConflictError'
    this.conflict = conflict
  }
}

type StoredOperation = CommandOperation & { readonly execute: () => Promise<unknown>; readonly promise?: Promise<unknown> }

/** Deterministic client-side command coordinator; callers decide when to retry. */
export class CommandQueue {
  private readonly operations = new Map<string, StoredOperation>()
  private readonly listeners = new Set<(operation: CommandOperation) => void>()

  submit<T>(command: ClientCommand<T>): Promise<T> {
    const existing = this.operations.get(command.id)
    if (existing) return this.resultFor(existing) as Promise<T>

    const operation: StoredOperation = { id: command.id, status: 'pending', execute: command.execute }
    this.operations.set(command.id, operation)
    return this.execute<T>(operation)
  }

  retry<T>(operationId: string): Promise<T> {
    const operation = this.requireOperation(operationId)
    if (operation.status !== 'failed') return Promise.reject(new Error('Only failed operations can be retried'))
    const pending = { ...operation, status: 'pending' as const, error: undefined, conflict: undefined, result: undefined }
    this.operations.set(operationId, pending)
    return this.execute<T>(pending)
  }

  get<T = unknown>(operationId: string): CommandOperation<T> | undefined {
    return this.operations.get(operationId) as CommandOperation<T> | undefined
  }

  subscribe(listener: (operation: CommandOperation) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  markStale(operationId: string): CommandOperation {
    return this.setStatus(operationId, 'stale')
  }

  markFresh(operationId: string): CommandOperation {
    return this.setStatus(operationId, 'fresh')
  }

  private execute<T>(operation: StoredOperation): Promise<T> {
    const promise = Promise.resolve()
      .then(operation.execute)
      .then((result) => {
        const fresh = { ...operation, status: 'fresh' as const, result, error: undefined, conflict: undefined, promise: undefined }
        this.operations.set(operation.id, fresh)
        this.publish(fresh)
        return result as T
      })
      .catch((error: unknown) => {
        const failure = error instanceof CommandConflictError
          ? { ...operation, status: 'conflicted' as const, error, conflict: error.conflict, promise: undefined }
          : { ...operation, status: 'failed' as const, error: toError(error), conflict: undefined, promise: undefined }
        this.operations.set(operation.id, failure)
        this.publish(failure)
        throw error
      })
    const pending = { ...operation, promise }
    this.operations.set(operation.id, pending)
    this.publish(pending)
    return promise
  }

  private resultFor(operation: StoredOperation): Promise<unknown> {
    if (operation.status === 'pending') return operation.promise as Promise<unknown>
    if (operation.status === 'fresh' || operation.status === 'stale') return Promise.resolve(operation.result)
    return Promise.reject(operation.error ?? new Error('Command did not complete'))
  }

  private setStatus(operationId: string, status: 'fresh' | 'stale'): CommandOperation {
    const operation = this.requireOperation(operationId)
    if (operation.status !== 'fresh' && operation.status !== 'stale') {
      throw new Error('Only fresh or stale operations can be marked stale or fresh')
    }
    const updated = { ...operation, status }
    this.operations.set(operationId, updated)
    this.publish(updated)
    return updated
  }

  private requireOperation(operationId: string): StoredOperation {
    const operation = this.operations.get(operationId)
    if (!operation) throw new Error(`Unknown operation: ${operationId}`)
    return operation
  }

  private publish(operation: CommandOperation): void {
    this.listeners.forEach((listener) => listener(operation))
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
