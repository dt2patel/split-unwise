import type { Allocation, Money, Recurrence, SplitMethod } from '../domain/model'
import { assertCurrencyCode } from '../domain/money'
import { computeAllocations } from '../domain/splits'
import { decodeDefaultSplit } from '../domain/groupSettings'
import type { CommandEnvelope, CommandKind, CommandResult, ExpenseDraft, ExpenseRow, SyncState } from './repositories'
import { isStrictId } from './identifiers'
import { assertOperationId, canonicalEnvelopeFingerprint, OperationReplayConflictError } from './operationIdentity'
import { recurringOccurrenceId } from '../domain/recurrence'

export const COMMAND_QUEUE_STORAGE_VERSION = 6 as const
const COMMAND_QUEUE_STORAGE_PREFIX = `split-unwise:command-queue:v${COMMAND_QUEUE_STORAGE_VERSION}`
const COMMAND_QUEUE_QUARANTINE_PREFIX = `split-unwise:command-queue:quarantine:v${COMMAND_QUEUE_STORAGE_VERSION}`
const LEGACY_COMMAND_QUEUE_STORAGE_PREFIX = 'split-unwise:command-queue:v5'

export type CommandFailureCode = 'conflict' | 'handler-missing' | 'network' | 'not-supported' | 'permission-denied' | 'persistence' | 'unknown' | 'validation'
export interface CommandFailure {
  readonly code: CommandFailureCode
  readonly message: string
  readonly retryable: boolean
  readonly executed?: boolean
  readonly conflict?: unknown
}

export class CommandConflictError extends Error {
  readonly conflict: unknown
  constructor(message: string, conflict?: unknown) { super(message); this.name = 'CommandConflictError'; this.conflict = conflict }
}

export class CommandFailedError extends Error {
  readonly retryable: boolean
  constructor(readonly code: CommandFailureCode, message: string, readonly executed?: boolean) {
    super(message)
    this.name = 'CommandFailedError'
    this.retryable = isRetryableFailureCode(code)
  }
}

interface OwnedOperation {
  readonly originPrincipalKey: string
  /** User-intent time, independent from an expense occurrence date or eventual commit time. */
  readonly submittedAt: string
  /** The original, user-authored command remains the replay identity. */
  readonly envelope: CommandEnvelope
  /** A persisted, operation-specific execution copy for one-way local preparation such as receipt promotion. */
  readonly executionEnvelope?: CommandEnvelope
}
export type CommandOperation =
  | (OwnedOperation & { readonly status: 'pending' })
  | (OwnedOperation & { readonly status: 'fresh' | 'stale'; readonly result: CommandResult })
  | (OwnedOperation & { readonly status: 'failed'; readonly error: CommandFailure })
  | (OwnedOperation & { readonly status: 'conflicted'; readonly error: CommandFailure; readonly conflict: unknown })

export interface PersistedCommandQueue {
  readonly version: typeof COMMAND_QUEUE_STORAGE_VERSION
  readonly principalKey: string
  readonly operations: readonly CommandOperation[]
}

/** Storage is always addressed by an opaque principal key. There is no account-agnostic path. */
export interface CommandStorage {
  load(scopeKey: string): unknown
  save(scopeKey: string, document: PersistedCommandQueue): Promise<void>
  quarantine?(scopeKey: string, records: readonly unknown[]): Promise<void>
}

export interface CommandHandle { readonly operationId: string; result(): Promise<CommandResult> }
export type CommandHandler = (command: CommandEnvelope) => Promise<CommandResult>
export type CommandHandlers = Partial<Record<CommandKind, CommandHandler>>
export interface CommandQueueOptions {
  readonly handlers: CommandHandlers
  /** Runs once per durable operation. Its returned execution copy is persisted before a handler receives it. */
  readonly prepare?: (command: CommandEnvelope) => Promise<CommandEnvelope>
  /** Retains an unchanged prepared envelope when a one-way local decision must survive replay. */
  readonly shouldPersistExecution?: (original: CommandEnvelope, prepared: CommandEnvelope) => boolean
  readonly storage?: CommandStorage
  /** Useful for deterministic seams. App sessions bind only after hydrating repository identity. */
  readonly originPrincipalKey?: string
  readonly now?: () => string
}

/** Serializable, timer-free queue. Commands are persisted before registered handlers run. */
export class CommandQueue {
  private readonly operations = new Map<string, CommandOperation>()
  private readonly listeners = new Set<(operation: CommandOperation) => void>()
  private readonly running = new Map<string, Promise<void>>()
  private readonly storage: CommandStorage
  private principalKey: string | undefined
  private binding: Promise<void> = Promise.resolve()
  private persistenceTail: Promise<void> = Promise.resolve()

  constructor(private readonly options: CommandQueueOptions) {
    this.storage = options.storage ?? createBrowserCommandStorage()
    if (options.originPrincipalKey !== undefined) this.binding = this.bind(options.originPrincipalKey)
  }

  /** A queue is permanently scoped to one authenticated identity for its lifetime. */
  bind(principalKey: string): Promise<void> {
    const owner = assertPrincipalKey(principalKey)
    if (this.principalKey !== undefined) {
      if (this.principalKey !== owner) throw new Error('Command queue is already bound to a different authenticated principal')
      return this.binding
    }
    this.principalKey = owner
    const decoded = decodePersistedQueue(this.storage.load(owner), owner)
    for (const operation of decoded.operations) {
      if (this.operations.has(operation.envelope.operationId)) decoded.rejected.push(operation)
      else this.operations.set(operation.envelope.operationId, operation)
    }
    if (decoded.rejected.length > 0) {
      this.binding = (async () => {
        await this.storage.quarantine?.(owner, clone(decoded.rejected))
        await this.persist()
      })()
    }
    return this.binding
  }

  submit(command: CommandEnvelope): CommandHandle {
    const principalKey = this.requireOwner()
    if (!isCommandEnvelope(command)) {
      const candidate: unknown = command
      const operationId = isRecord(candidate) && typeof candidate.operationId === 'string' ? candidate.operationId : 'invalid-operation'
      return rejectedHandle(operationId, new CommandFailedError('validation', 'Command envelope is invalid', false))
    }
    assertOperationId(command.operationId)
    const existing = this.operations.get(command.operationId)
    if (existing) {
      if (canonicalEnvelopeFingerprint(existing.envelope) !== canonicalEnvelopeFingerprint(command)) {
        const error = new OperationReplayConflictError()
        return rejectedHandle(command.operationId, new CommandConflictError(error.message, {
            existingFingerprint: canonicalEnvelopeFingerprint(existing.envelope),
            requestedFingerprint: canonicalEnvelopeFingerprint(command),
        }))
      }
      return this.handle(command.operationId)
    }
    this.replaceInMemory({ originPrincipalKey: principalKey, submittedAt: checkedNow(this.options.now), status: 'pending', envelope: clone(command) })
    const pendingWrite = this.binding.then(() => this.persist())
      .catch((error: unknown) => { throw new CommandFailedError('persistence', errorMessage(error), false) })
    this.start(command.operationId, pendingWrite)
    return this.handle(command.operationId)
  }

  retry(operationId: string): CommandHandle {
    this.requireOwner()
    const operation = this.operations.get(operationId)
    if (!operation || operation.status !== 'failed') return rejectedHandle(operationId, new Error('Only failed operations can be retried'))
    if (!operation.error.retryable) return rejectedHandle(operationId, new Error(`The ${operation.error.code} failure is not retryable`))
    this.replaceInMemory({ originPrincipalKey: operation.originPrincipalKey, submittedAt: operation.submittedAt, status: 'pending', envelope: operation.envelope, executionEnvelope: operation.executionEnvelope })
    const pendingWrite = this.binding.then(() => this.persist())
      .catch((error: unknown) => { throw new CommandFailedError('persistence', errorMessage(error), false) })
    this.start(operationId, pendingWrite)
    return this.handle(operationId)
  }

  get(operationId: string): CommandOperation | undefined { return cloneOptional(this.operations.get(operationId)) }
  snapshot(): readonly CommandOperation[] { return clone([...this.operations.values()]) }

  /** Clears this principal's terminal local journal only when no result is indeterminate. */
  async clearLocalRecords(): Promise<void> {
    this.requireOwner()
    if ([...this.operations.values()].some(({ status }) => status === 'pending')) throw new Error('Pending operations cannot be cleared while their result is unknown')
    const removed = [...this.operations.values()]
    await this.persistProjection(() => [])
    this.operations.clear()
    removed.forEach((operation) => this.notify(operation))
  }

  async discard(operationId: string): Promise<boolean> {
    this.requireOwner()
    const operation = this.operations.get(operationId)
    if (!operation) return false
    if (operation.status !== 'failed') throw new Error('Only failed operations can be discarded')
    await this.persistProjection((next) => {
      next.delete(operationId)
      return next.values()
    })
    this.operations.delete(operationId)
    this.notify(operation)
    return true
  }

  /** Removes a reconciled terminal journal record after its server state is reflected in reads. */
  async acknowledge(operationId: string): Promise<boolean> {
    this.requireOwner()
    const operation = this.operations.get(operationId)
    if (!operation) return false
    if (operation.status !== 'fresh' && operation.status !== 'stale' && operation.status !== 'conflicted') {
      throw new Error('Only fresh, stale, or conflicted operations can be acknowledged')
    }
    await this.persistProjection((next) => {
      next.delete(operationId)
      return next.values()
    })
    this.operations.delete(operationId)
    this.notify(operation)
    return true
  }

  subscribe(listener: (operation: CommandOperation) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  markStale(operationId: string): Promise<CommandOperation> { return this.setReadState(operationId, 'stale') }
  markFresh(operationId: string): Promise<CommandOperation> { return this.setReadState(operationId, 'fresh') }

  async resume(): Promise<void> {
    this.requireOwner()
    await this.binding
    const pending = [...this.operations.values()].filter((operation): operation is Extract<CommandOperation, { status: 'pending' }> => operation.status === 'pending')
    for (const operation of pending) void this.start(operation.envelope.operationId).catch(() => undefined)
  }

  private requireOwner(): string {
    if (this.principalKey === undefined) throw new Error('Command queue requires an authenticated principal before use')
    return this.principalKey
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
    if (operation.status === 'fresh' || operation.status === 'stale') return clone(operation.result)
    if (operation.status === 'conflicted') throw new CommandConflictError(operation.error.message, clone(operation.conflict))
    if (operation.status === 'failed') throw new CommandFailedError(operation.error.code, operation.error.message, operation.error.executed)
    throw new Error(`Operation ${operationId} is unavailable`)
  }

  private start(operationId: string, pendingWrite: Promise<void> = Promise.resolve()): Promise<void> {
    const active = this.running.get(operationId)
    if (active) return active
    const operation = this.operations.get(operationId)
    if (!operation || operation.status !== 'pending') return Promise.resolve()
    const running = pendingWrite
      .then(async () => {
        const current = this.operations.get(operationId)
        if (!current || current.status !== 'pending' || canonicalEnvelopeFingerprint(current.envelope) !== canonicalEnvelopeFingerprint(operation.envelope)) return undefined
        let execution = current.executionEnvelope ?? current.envelope
        if (!current.executionEnvelope && this.options.prepare) {
          const original = clone(current.envelope)
          const prepared = await this.options.prepare(clone(original))
          if (!isExecutionEnvelopeFor(prepared, original)) throw new CommandFailedError('validation', 'Command preparation returned an invalid or mismatched execution envelope')
          if (canonicalEnvelopeFingerprint(prepared) !== canonicalEnvelopeFingerprint(original)
            || this.options.shouldPersistExecution?.(original, prepared)) {
            const mapped: CommandOperation = { ...current, executionEnvelope: clone(prepared) }
            await this.replace(mapped)
          }
          execution = prepared
        }
        const handler = this.options.handlers[execution.kind]
        if (!handler) throw new CommandFailedError('handler-missing', `No handler is registered for ${operation.envelope.kind}`, false)
        return handler(execution)
      })
      .then(async (result) => {
        if (!result) return
        if (result.status === 'not-supported') throw new CommandFailedError('not-supported', result.reason)
        if (!isCommandResultFor(result, operation.envelope)) throw new CommandFailedError('validation', 'Command handler returned an invalid or mismatched result')
        const current = this.operations.get(operationId)
        if (current?.status === 'pending' && canonicalEnvelopeFingerprint(current.envelope) === canonicalEnvelopeFingerprint(operation.envelope)) {
          await this.replace({ originPrincipalKey: operation.originPrincipalKey, submittedAt: operation.submittedAt, status: 'fresh', envelope: operation.envelope, executionEnvelope: current.executionEnvelope, result: clone(result) })
            .catch((error: unknown) => { throw new CommandFailedError('persistence', errorMessage(error), true) })
        }
      })
      .catch(async (error: unknown) => {
        const current = this.operations.get(operationId)
        if (!current || canonicalEnvelopeFingerprint(current.envelope) !== canonicalEnvelopeFingerprint(operation.envelope)) return
        if (isIndeterminateExecutionError(error)) {
          // The pending intent was persisted before execution. Never write an old
          // in-memory snapshot here: another same-principal queue may have reconciled it.
          throw error
        }
        const mapped = toFailure(error)
        if (mapped.code === 'persistence') {
          this.replaceInMemory({ originPrincipalKey: operation.originPrincipalKey, submittedAt: operation.submittedAt, status: 'failed', envelope: operation.envelope, executionEnvelope: current.executionEnvelope, error: mapped })
        } else if (current.status !== 'pending') {
          return
        } else {
          const terminal: CommandOperation = mapped.code === 'conflict'
            ? { originPrincipalKey: operation.originPrincipalKey, submittedAt: operation.submittedAt, status: 'conflicted', envelope: operation.envelope, executionEnvelope: current.executionEnvelope, error: mapped, conflict: conflictDetails(error, operation.envelope) }
            : { originPrincipalKey: operation.originPrincipalKey, submittedAt: operation.submittedAt, status: 'failed', envelope: operation.envelope, executionEnvelope: current.executionEnvelope, error: mapped }
          try {
            await this.replace(terminal)
          } catch (storageError: unknown) {
            this.replaceInMemory({
              originPrincipalKey: operation.originPrincipalKey,
              submittedAt: operation.submittedAt,
              status: 'failed',
              envelope: operation.envelope,
              executionEnvelope: current.executionEnvelope,
              error: failure('persistence', errorMessage(storageError), true),
            })
          }
        }
      })
      .finally(() => { this.running.delete(operationId) })
    this.running.set(operationId, running)
    return running
  }

  private async setReadState(operationId: string, status: Extract<SyncState, 'fresh' | 'stale'>): Promise<CommandOperation> {
    this.requireOwner()
    const operation = this.operations.get(operationId)
    if (!operation || (operation.status !== 'fresh' && operation.status !== 'stale')) throw new Error('Only fresh or stale operations can be marked stale or fresh')
    const updated: CommandOperation = { ...operation, status }
    await this.persistProjection((next) => {
      next.set(operationId, updated)
      return next.values()
    })
    this.operations.set(operationId, clone(updated))
    this.notify(updated)
    return clone(updated)
  }

  private async replace(operation: CommandOperation): Promise<void> {
    const owner = this.requireOwner()
    if (operation.originPrincipalKey !== owner) throw new Error('Command operation principal does not match the authenticated queue principal')
    await this.persistProjection((next) => {
      next.set(operation.envelope.operationId, operation)
      return next.values()
    })
    this.replaceInMemory(operation)
  }

  private replaceInMemory(operation: CommandOperation): void {
    const owner = this.requireOwner()
    if (operation.originPrincipalKey !== owner) throw new Error('Command operation principal does not match the authenticated queue principal')
    this.operations.set(operation.envelope.operationId, clone(operation))
    this.notify(operation)
  }

  private persist(): Promise<void> {
    return this.enqueuePersistence(() => this.operations.values())
  }

  private persistProjection(project: (current: Map<string, CommandOperation>) => Iterable<CommandOperation>): Promise<void> {
    return this.enqueuePersistence(() => project(new Map(this.operations)))
  }

  private enqueuePersistence(operationsAtExecution: () => Iterable<CommandOperation>): Promise<void> {
    const principalKey = this.requireOwner()
    const write = this.persistenceTail.then(() => {
      const document: PersistedCommandQueue = {
        version: COMMAND_QUEUE_STORAGE_VERSION,
        principalKey,
        operations: clone([...operationsAtExecution()]),
      }
      return this.storage.save(principalKey, document)
    })
    this.persistenceTail = write.catch(() => undefined)
    return write
  }

  private notify(operation: CommandOperation): void {
    const copy = clone(operation)
    this.listeners.forEach((listener) => { try { listener(copy) } catch { /* subscribers cannot affect durable command state */ } })
  }
}

/** Deterministic principal-key-indexed storage seam for tests and non-browser hosts. */
export function createMemoryCommandStorage(initial: Readonly<Record<string, unknown>> = {}): CommandStorage {
  const documents = new Map(Object.entries(clone(initial)))
  const quarantined = new Map<string, unknown[]>()
  return {
    load: (scopeKey) => cloneOptional(documents.get(scopeKey)),
    save: async (scopeKey, document) => { documents.set(scopeKey, clone(document)) },
    quarantine: async (scopeKey, records) => { quarantined.set(scopeKey, [...(quarantined.get(scopeKey) ?? []), ...clone(records)]) },
  }
}

export interface BrowserCommandStorageOptions { readonly storage?: Storage; readonly keyPrefix?: string }

/** Browser persistence uses a distinct key for each authenticated principal. */
export function createBrowserCommandStorage(options: BrowserCommandStorageOptions = {}): CommandStorage {
  const storage = options.storage ?? readBrowserStorage()
  const prefix = options.keyPrefix ?? COMMAND_QUEUE_STORAGE_PREFIX
  const keyFor = (scopeKey: string) => `${prefix}:${encodeURIComponent(scopeKey)}`
  const legacyKeyFor = (scopeKey: string) => `${LEGACY_COMMAND_QUEUE_STORAGE_PREFIX}:${encodeURIComponent(scopeKey)}`
  const quarantineKeyFor = (scopeKey: string) => `${COMMAND_QUEUE_QUARANTINE_PREFIX}:${encodeURIComponent(scopeKey)}`
  const loadedLegacyScopes = new Set<string>()
  const quarantine = async (scopeKey: string, records: readonly unknown[]) => {
    if (!storage || records.length === 0) return
    try {
      const key = quarantineKeyFor(scopeKey)
      const current = parseQuarantine(storage.getItem(key))
      storage.setItem(key, JSON.stringify({ version: COMMAND_QUEUE_STORAGE_VERSION, principalKey: scopeKey, records: [...current, ...toSerializableRecords(records)] }))
      if (loadedLegacyScopes.delete(scopeKey)) storage.removeItem(legacyKeyFor(scopeKey))
    } catch { /* persistence failures leave the in-memory queue usable */ }
  }
  return {
    load: (scopeKey) => {
      if (!storage) return undefined
      let key = keyFor(scopeKey)
      try {
        let value = storage.getItem(key)
        if (value === null && prefix === COMMAND_QUEUE_STORAGE_PREFIX) {
          key = legacyKeyFor(scopeKey)
          value = storage.getItem(key)
          if (value !== null) loadedLegacyScopes.add(scopeKey)
        }
        if (value === null) return undefined
        try { return JSON.parse(value) as unknown } catch {
          quarantine(scopeKey, [{ reason: 'invalid-json', raw: value }])
          storage.removeItem(key)
          return undefined
        }
      } catch { return undefined }
    },
    save: async (scopeKey, document) => {
      if (!storage) throw new Error('Browser command storage is unavailable')
      storage.setItem(keyFor(scopeKey), JSON.stringify(document))
    },
    quarantine,
  }
}

function decodePersistedQueue(value: unknown, principalKey: string): { operations: CommandOperation[]; rejected: unknown[] } {
  if (value === undefined || value === null) return { operations: [], rejected: [] }
  if (!isRecord(value) || value.version !== COMMAND_QUEUE_STORAGE_VERSION || value.principalKey !== principalKey || !Array.isArray(value.operations)) {
    return { operations: [], rejected: [value] }
  }
  const operations: CommandOperation[] = []
  const rejected: unknown[] = []
  for (const candidate of value.operations) {
    if (isCommandOperation(candidate, principalKey)) operations.push(clone(candidate))
    else rejected.push(candidate)
  }
  return { operations, rejected }
}

function isCommandOperation(value: unknown, principalKey: string): value is CommandOperation {
  if (!isRecord(value) || value.originPrincipalKey !== principalKey || !isIsoTimestamp(value.submittedAt) || !isCommandEnvelope(value.envelope)) return false
  if (value.executionEnvelope !== undefined && (!isCommandEnvelope(value.executionEnvelope) || !isExecutionEnvelopeFor(value.executionEnvelope, value.envelope))) return false
  if (value.status === 'pending') return onlyOperationFields(value, operationFields(['originPrincipalKey', 'submittedAt', 'status', 'envelope'], value))
  if (value.status === 'fresh' || value.status === 'stale') return onlyOperationFields(value, operationFields(['originPrincipalKey', 'submittedAt', 'status', 'envelope', 'result'], value)) && isCommandResultFor(value.result, value.envelope)
  if (value.status === 'failed') return onlyOperationFields(value, operationFields(['originPrincipalKey', 'submittedAt', 'status', 'envelope', 'error'], value)) && isCommandFailure(value.error) && value.error.code !== 'conflict'
  if (value.status === 'conflicted') return onlyOperationFields(value, operationFields(['originPrincipalKey', 'submittedAt', 'status', 'envelope', 'error', 'conflict'], value)) && isCommandFailure(value.error) && value.error.code === 'conflict' && isConflictForEnvelope(value.conflict, value.envelope)
  return false
}

function operationFields(base: readonly string[], value: Record<string, unknown>): readonly string[] {
  return value.executionEnvelope === undefined ? base : [...base, 'executionEnvelope']
}

function isExecutionEnvelopeFor(execution: CommandEnvelope, original: CommandEnvelope): boolean {
  if (execution.kind !== original.kind || execution.operationId !== original.operationId) return false
  if (execution.kind === 'expense.add' && original.kind === 'expense.add') return equivalentWithPromotedAttachments(execution, original, 'attachmentRefs')
  if (execution.kind === 'expense.edit' && original.kind === 'expense.edit') {
    if (execution.groupId !== original.groupId || execution.expenseId !== original.expenseId || execution.expectedRevision !== original.expectedRevision) return false
    if (execution.draft.groupId !== execution.groupId || original.draft.groupId !== original.groupId) return false
    return equivalentWithPromotedAttachments(execution.draft, original.draft, 'attachmentRefs')
  }
  if (execution.kind === 'comment.add' && original.kind === 'comment.add') return equivalentWithPromotedAttachments(execution, original, 'attachmentRefs')
  return canonicalEnvelopeFingerprint(execution) === canonicalEnvelopeFingerprint(original)
}

function equivalentWithPromotedAttachments<T extends object & { readonly attachmentRefs: readonly string[] }>(
  execution: T,
  original: T,
  attachmentField: 'attachmentRefs',
): boolean {
  if (!isAllowedAttachmentPromotion(original[attachmentField], execution[attachmentField])) return false
  const { [attachmentField]: _executionAttachments, ...executionSemantics } = execution
  const { [attachmentField]: _originalAttachments, ...originalSemantics } = original
  return canonicalJson(executionSemantics) === canonicalJson(originalSemantics)
}

function isAllowedAttachmentPromotion(original: readonly string[], execution: readonly string[]): boolean {
  return original.length === execution.length && original.every((reference, index) => {
    const prepared = execution[index]
    return prepared === reference || (/^local-receipt:[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(reference) && /^remote-receipt:[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(prepared))
  })
}

function isIndeterminateExecutionError(error: unknown): boolean {
  return error instanceof Error && error.name === 'StaleAppSessionError'
}

function isCommandFailure(value: unknown): value is CommandFailure {
  if (!isRecord(value) || !isFailureCode(value.code) || typeof value.message !== 'string' || typeof value.retryable !== 'boolean') return false
  if (value.executed !== undefined && typeof value.executed !== 'boolean') return false
  if (value.code === 'persistence' && typeof value.executed !== 'boolean') return false
  return value.retryable === isRetryableFailureCode(value.code) && (value.conflict === undefined || isJsonValue(value.conflict))
}

function isCommandEnvelope(value: unknown): value is CommandEnvelope {
  if (!isRecord(value) || !isOperationId(value.operationId) || typeof value.kind !== 'string') return false
  switch (value.kind) {
    case 'expense.add': return isExpenseDraft(value)
    case 'expense.edit': return isNonEmptyString(value.groupId) && isNonEmptyString(value.expenseId) && isNonNegativeInteger(value.expectedRevision) && isExpenseDraft(value.draft) && value.draft.groupId === value.groupId
    case 'expense.delete': return isNonEmptyString(value.groupId) && isNonEmptyString(value.expenseId) && isNonNegativeInteger(value.expectedRevision)
    case 'comment.add': return isNonEmptyString(value.groupId) && isNonEmptyString(value.expenseId) && isNonEmptyString(value.body) && isStringArray(value.attachmentRefs)
    case 'comment.delete': return isNonEmptyString(value.groupId) && isNonEmptyString(value.expenseId) && isNonEmptyString(value.commentId)
    case 'notification.read': return isNonEmptyString(value.notificationId)
    case 'notification.read-all': return isTimelineCursor(value.cutoff)
    case 'notification.preferences': return isNotificationPreferences(value.preferences)
    case 'settlement.record': {
      const fields = ['kind', 'operationId', 'groupId', 'expectedBalanceRevision', 'basis', 'money', 'method', 'occurredOn', 'outsidePaymentConfirmed', ...(value.note === undefined ? [] : ['note'])]
      return onlyOperationFields(value, fields) && isNonEmptyString(value.groupId) && isNonNegativeInteger(value.expectedBalanceRevision)
        && isSettlementBasis(value.basis) && isPositiveMoney(value.money) && value.money.currency === value.basis.currency
        && isSettlementMethod(value.method) && isIsoDate(value.occurredOn) && (value.note === undefined || isSettlementText(value.note, false))
        && value.outsidePaymentConfirmed === true && value.money.minorAmount <= value.basis.debtMinor
    }
    case 'settlement.void': return onlyOperationFields(value, ['kind', 'operationId', 'groupId', 'settlementId', 'expectedRevision', 'expectedBalanceRevision', 'reason'])
      && isNonEmptyString(value.groupId) && isNonEmptyString(value.settlementId) && isPositiveInteger(value.expectedRevision)
      && isNonNegativeInteger(value.expectedBalanceRevision) && isSettlementText(value.reason, true)
    case 'group.default-split': return onlyOperationFields(value, ['kind', 'operationId', 'groupId', 'expectedRevision', 'defaultSplit'])
      && isNonEmptyString(value.groupId) && isPositiveInteger(value.expectedRevision)
      && (value.defaultSplit === null || isDefaultSplit(value.defaultSplit))
    case 'group.currency-conversion': return onlyOperationFields(value, ['kind', 'operationId', 'groupId', 'expectedRevision', 'targetCurrency', 'rates'])
      && isNonEmptyString(value.groupId) && isPositiveInteger(value.expectedRevision) && isCurrencyCode(value.targetCurrency)
      && isFxRates(value.rates, value.targetCurrency)
    case 'group.delete': return onlyOperationFields(value, ['kind', 'operationId', 'groupId']) && isNonEmptyString(value.groupId)
    case 'group.simplify-debts': return onlyOperationFields(value, ['kind', 'operationId', 'groupId', 'expectedRevision', 'simplifyDebtsEnabled'])
      && isNonEmptyString(value.groupId) && isPositiveInteger(value.expectedRevision) && typeof value.simplifyDebtsEnabled === 'boolean'
    case 'group.member-remove': return onlyOperationFields(value, ['kind', 'operationId', 'groupId', 'targetMemberId'])
      && isNonEmptyString(value.groupId) && isNonEmptyString(value.targetMemberId)
    case 'group.restore': return onlyOperationFields(value, ['kind', 'operationId', 'groupId']) && isNonEmptyString(value.groupId)
    case 'recurrence.materialize': return onlyOperationFields(value, ['kind', 'operationId', 'groupId', 'templateId', 'occurrenceDate'])
      && isNonEmptyString(value.groupId) && isStrictId(value.templateId) && isIsoDate(value.occurrenceDate)
    case 'recurrence.cancel': return onlyOperationFields(value, ['kind', 'operationId', 'groupId', 'templateId', 'expectedRevision'])
      && isNonEmptyString(value.groupId) && isStrictId(value.templateId) && isPositiveInteger(value.expectedRevision)
    case 'profile.update': return isNonEmptyString(value.displayName) && (value.initials === undefined || isNonEmptyString(value.initials))
    default: return false
  }
}

function isCommandResultFor(value: unknown, envelope: CommandEnvelope): value is CommandResult {
  if (!isRecord(value) || value.kind !== envelope.kind || value.operationId !== envelope.operationId || value.status !== 'saved') return false
  switch (envelope.kind) {
    case 'expense.add': return isExpenseRow(value.expense) && value.expense.groupId === envelope.groupId && value.expense.revision === 1 && value.expense.deletedAt === undefined
      && Boolean(value.expense.reimbursement) === Boolean(envelope.reimbursement)
    case 'expense.edit': return isExpenseRow(value.expense) && value.expense.groupId === envelope.groupId && value.expense.id === envelope.expenseId
      && value.expense.revision === envelope.expectedRevision + 1 && value.expense.deletedAt === undefined
      && Boolean(value.expense.reimbursement) === Boolean(envelope.draft.reimbursement)
    case 'expense.delete': return isTombstone(value.tombstone, envelope)
    case 'comment.add': return isSavedComment(value, envelope, false)
    case 'comment.delete': return isSavedComment(value, envelope, true)
    case 'notification.read': return isSavedNotificationRead(value, envelope)
    case 'notification.read-all': return isTimelineCursor(value.cutoff) && sameTimelineCursor(value.cutoff, envelope.cutoff) && isStringArray(value.readNotificationIds)
    case 'notification.preferences': return isNotificationPreferences(value.preferences) && samePreferences(value.preferences, envelope.preferences)
    case 'settlement.record': return isSavedSettlementRecord(value, envelope)
    case 'settlement.void': return isSavedSettlementVoid(value, envelope)
    case 'profile.update': return isNonEmptyString(value.resourceId)
    case 'group.default-split': return value.resourceId === envelope.groupId
    case 'group.currency-conversion': return value.resourceId === envelope.groupId
    case 'group.delete': return value.resourceId === envelope.groupId
    case 'group.simplify-debts': return value.resourceId === envelope.groupId
    case 'group.member-remove': return value.resourceId === envelope.targetMemberId
    case 'group.restore': return value.resourceId === envelope.groupId
    case 'recurrence.materialize': return isSavedRecurrenceMaterialization(value, envelope)
    case 'recurrence.cancel': return isSavedRecurrenceCancellation(value, envelope)
  }
}

function isExpenseDraft(value: unknown): value is ExpenseDraft {
  if (!isRecord(value) || !isNonEmptyString(value.groupId) || !isNonEmptyString(value.description) || !isIsoDate(value.date) || !isMoney(value.total)
    || !isAllocations(value.payments, value.total.currency) || !isAllocations(value.allocations, value.total.currency) || !isNonEmptyString(value.category)
    || !isSplitMethod(value.splitMethod, value.total.currency) || !isStringArray(value.attachmentRefs) || (value.notes !== undefined && typeof value.notes !== 'string')
    || (value.reimbursement !== undefined && value.reimbursement !== true)
    || (value.recurrence !== undefined && !isRecurrence(value.recurrence)) || (value.occurrenceEditScope !== undefined && value.occurrenceEditScope !== 'occurrence' && value.occurrenceEditScope !== 'future')) return false
  if (value.payments.length === 0 || hasDuplicateParticipants(value.payments) || hasDuplicateParticipants(value.allocations)) return false
  if (sumAllocations(value.payments) !== BigInt(value.total.minorAmount) || sumAllocations(value.allocations) !== BigInt(value.total.minorAmount)) return false
  try { return sameAllocations(computeAllocations(value.total, value.splitMethod), value.allocations) } catch { return false }
}

function isExpenseRow(value: unknown): value is ExpenseRow {
  return isExpenseDraft(value) && isRecord(value) && isNonEmptyString(value.id) && isIsoTimestamp(value.createdAt) && isIsoTimestamp(value.updatedAt) && isPositiveInteger(value.revision) && isSyncState(value.syncState)
    && (value.recurringTemplateId === undefined || isNonEmptyString(value.recurringTemplateId)) && (value.deletedAt === undefined || isIsoTimestamp(value.deletedAt))
    && (value.createdBy === undefined || isActorSnapshot(value.createdBy)) && (value.updatedBy === undefined || isActorSnapshot(value.updatedBy))
}

function isSavedRecurrenceMaterialization(value: Record<string, unknown>, envelope: Extract<CommandEnvelope, { kind: 'recurrence.materialize' }>): boolean {
  if (!onlyOperationFields(value, ['kind', 'operationId', 'status', 'template', 'occurrence'])
    || !isRecurringExpense(value.template) || !isExpenseRow(value.occurrence)) return false
  const template = value.template
  const occurrence = value.occurrence
  return template.id === envelope.templateId && template.groupId === envelope.groupId
    && template.nextDate > envelope.occurrenceDate
    && occurrence.id === recurringOccurrenceId(envelope.templateId, envelope.occurrenceDate)
    && occurrence.groupId === envelope.groupId
    && occurrence.recurringTemplateId === envelope.templateId
    && Boolean(occurrence.reimbursement) === Boolean(template.reimbursement)
}

function isSavedRecurrenceCancellation(value: Record<string, unknown>, envelope: Extract<CommandEnvelope, { kind: 'recurrence.cancel' }>): boolean {
  return onlyOperationFields(value, ['kind', 'operationId', 'status', 'template']) && isRecurringExpense(value.template)
    && value.template.id === envelope.templateId && value.template.groupId === envelope.groupId
    && value.template.status === 'cancelled' && value.template.revision === envelope.expectedRevision + 1
}

function isRecurringExpense(value: unknown): value is import('./repositories').RecurringExpense {
  if (!isRecord(value) || !isStrictId(value.id) || !isNonEmptyString(value.groupId) || (value.status !== 'active' && value.status !== 'cancelled')
    || !isNonEmptyString(value.description) || !isPositiveMoney(value.total) || !isAllocations(value.payments, value.total.currency)
    || !isAllocations(value.allocations, value.total.currency) || value.payments.length === 0
    || sumAllocations(value.payments) !== BigInt(value.total.minorAmount) || sumAllocations(value.allocations) !== BigInt(value.total.minorAmount)
    || !isNonEmptyString(value.category) || !isSplitMethod(value.splitMethod, value.total.currency) || !isRecurrence(value.recurrence)
    || (value.reimbursement !== undefined && value.reimbursement !== true)
    || !isIsoDate(value.anchorDate) || !isIsoDate(value.nextDate) || !isPositiveInteger(value.revision)
    || !isActorSnapshot(value.createdBy) || value.syncState !== 'fresh') return false
  try {
    if (!sameAllocations(computeAllocations(value.total, value.splitMethod), value.allocations)) return false
  } catch { return false }
  const anchor = `${String(value.recurrence.anchor.month).padStart(2, '0')}-${String(value.recurrence.anchor.day).padStart(2, '0')}`
  if (value.anchorDate.slice(5) !== anchor) return false
  if ((value.lastOccurrenceId === undefined) !== (value.lastOccurrenceDate === undefined)) return false
  return value.lastOccurrenceId === undefined
    || (isIsoDate(value.lastOccurrenceDate) && value.lastOccurrenceId === recurringOccurrenceId(value.id, value.lastOccurrenceDate))
}

function isSavedComment(value: Record<string, unknown>, envelope: Extract<CommandEnvelope, { kind: 'comment.add' | 'comment.delete' }>, deleted: boolean): boolean {
  if (!isExpenseComment(value.comment) || !isActivityItem(value.activity)) return false
  const comment = value.comment
  const activity = value.activity
  const commentId = envelope.kind === 'comment.delete' ? envelope.commentId : comment.commentId
  return comment.groupId === envelope.groupId && comment.expenseId === envelope.expenseId
    && (envelope.kind === 'comment.delete' || comment.operationId === envelope.operationId)
    && comment.commentId === commentId && (deleted ? comment.deletedAt !== undefined : comment.deletedAt === undefined)
    && activity.groupId === envelope.groupId && activity.expenseId === envelope.expenseId && activity.operationId === envelope.operationId
    && activity.commentId === commentId && activity.subject.kind === 'comment' && activity.subject.id === commentId
    && activity.kind === (deleted ? 'comment.deleted' : 'comment.added')
}

function isExpenseComment(value: unknown): value is import('./repositories').ExpenseComment {
  return isRecord(value) && isNonEmptyString(value.commentId) && isNonEmptyString(value.groupId) && isNonEmptyString(value.expenseId)
    && isOperationId(value.operationId) && isActorSnapshot(value.author) && isNonEmptyString(value.body) && isStringArray(value.attachmentRefs)
    && isIsoTimestamp(value.createdAt) && (value.deletedAt === undefined || isIsoTimestamp(value.deletedAt)) && isSyncState(value.syncState)
}

function isActivityItem(value: unknown): value is import('./repositories').ActivityItem {
  if (!isRecord(value) || !isNonEmptyString(value.id) || !isNonEmptyString(value.groupId) || !isOperationId(value.operationId)
    || !isActivityKind(value.kind) || !isActivitySubject(value.subject) || !isActorSnapshot(value.actor) || !isIsoTimestamp(value.createdAt) || !isSyncState(value.syncState)) return false
  return (value.expenseId === undefined || isNonEmptyString(value.expenseId)) && (value.revision === undefined || isPositiveInteger(value.revision))
    && (value.commentId === undefined || isNonEmptyString(value.commentId)) && (value.settlementId === undefined || isNonEmptyString(value.settlementId))
}

function isSavedNotificationRead(value: Record<string, unknown>, envelope: Extract<CommandEnvelope, { kind: 'notification.read' }>): boolean {
  return isNotificationItem(value.notification) && value.notification.notificationId === envelope.notificationId && value.notification.readAt !== undefined
}

function isSavedSettlementRecord(value: Record<string, unknown>, envelope: Extract<CommandEnvelope, { kind: 'settlement.record' }>): boolean {
  if (!onlyOperationFields(value, ['kind', 'operationId', 'status', 'settlement', 'balanceSnapshot', 'activity'])
    || !isSettlementRecord(value.settlement) || !isGroupBalanceSnapshot(value.balanceSnapshot) || !isActivityItem(value.activity)) return false
  const settlement = value.settlement
  const snapshot = value.balanceSnapshot
  const activity = value.activity
  const normalizedNote = envelope.note?.normalize('NFC').replace(/\r\n?/g, '\n').trim()
  return settlement.groupId === envelope.groupId && settlement.operationId === envelope.operationId
    && settlement.senderId === envelope.basis.senderId && settlement.recipientId === envelope.basis.recipientId
    && sameSettlementBasis(settlement.basis, envelope.basis) && sameMoney(settlement.money, envelope.money)
    && settlement.method === envelope.method && settlement.occurredOn === envelope.occurredOn
    && settlement.note === (normalizedNote || undefined) && settlement.revision === 1 && settlement.void === undefined && settlement.syncState === 'fresh'
    && snapshot.groupId === envelope.groupId && snapshot.balanceRevision === envelope.expectedBalanceRevision + 1
    && activity.groupId === envelope.groupId && activity.operationId === envelope.operationId && activity.kind === 'settlement.created'
    && activity.settlementId === settlement.settlementId && activity.subject.kind === 'settlement' && activity.subject.id === settlement.settlementId
    && sameActorSnapshot(activity.actor, settlement.createdBy) && activity.createdAt === settlement.createdAt
}

function isSavedSettlementVoid(value: Record<string, unknown>, envelope: Extract<CommandEnvelope, { kind: 'settlement.void' }>): boolean {
  if (!onlyOperationFields(value, ['kind', 'operationId', 'status', 'settlement', 'balanceSnapshot', 'activity'])
    || !isSettlementRecord(value.settlement) || !isGroupBalanceSnapshot(value.balanceSnapshot) || !isActivityItem(value.activity)) return false
  const settlement = value.settlement
  const snapshot = value.balanceSnapshot
  const activity = value.activity
  return settlement.groupId === envelope.groupId && settlement.settlementId === envelope.settlementId
    && settlement.revision === envelope.expectedRevision + 1 && settlement.void?.operationId === envelope.operationId
    && settlement.void.revision === settlement.revision && settlement.void.reason === envelope.reason.normalize('NFC').replace(/\r\n?/g, '\n').trim()
    && snapshot.groupId === envelope.groupId && snapshot.balanceRevision === envelope.expectedBalanceRevision + 1
    && activity.groupId === envelope.groupId && activity.operationId === envelope.operationId && activity.kind === 'settlement.voided'
    && activity.settlementId === envelope.settlementId && activity.subject.kind === 'settlement' && activity.subject.id === envelope.settlementId
    && sameActorSnapshot(activity.actor, settlement.void.actor) && activity.createdAt === settlement.void.createdAt
}

function isSettlementRecord(value: unknown): value is import('./repositories').SettlementRecord {
  if (!isRecord(value)) return false
  const fields = ['settlementId', 'groupId', 'operationId', 'senderId', 'recipientId', 'money', 'basis', 'method', 'occurredOn', 'createdBy', 'createdAt', 'revision', 'syncState', ...(value.note === undefined ? [] : ['note']), ...(value.void === undefined ? [] : ['void'])]
  if (!onlyOperationFields(value, fields) || !isNonEmptyString(value.settlementId) || !isNonEmptyString(value.groupId) || !isOperationId(value.operationId)
    || !isNonEmptyString(value.senderId) || !isNonEmptyString(value.recipientId) || value.senderId === value.recipientId
    || !isPositiveMoney(value.money) || !isSettlementBasis(value.basis) || !isSettlementMethod(value.method) || !isIsoDate(value.occurredOn)
    || !isActorSnapshot(value.createdBy) || !isIsoTimestamp(value.createdAt) || !isPositiveInteger(value.revision) || value.syncState !== 'fresh'
    || (value.note !== undefined && (!isSettlementText(value.note, false) || value.note !== value.note.normalize('NFC').replace(/\r\n?/g, '\n').trim()))) return false
  if (value.senderId !== value.basis.senderId || value.recipientId !== value.basis.recipientId || value.money.currency !== value.basis.currency
    || value.money.minorAmount > value.basis.debtMinor || (value.createdBy.id !== value.senderId && value.createdBy.id !== value.recipientId)) return false
  if (value.void === undefined) return value.revision === 1
  return value.revision === 2 && isSettlementVoid(value.void) && value.void.revision === value.revision
}

function isSettlementVoid(value: unknown): value is import('./repositories').SettlementVoid {
  return isRecord(value) && onlyOperationFields(value, ['operationId', 'reason', 'actor', 'createdAt', 'revision'])
    && isOperationId(value.operationId) && isSettlementText(value.reason, true)
    && value.reason === value.reason.normalize('NFC').replace(/\r\n?/g, '\n').trim()
    && isActorSnapshot(value.actor) && isIsoTimestamp(value.createdAt) && isPositiveInteger(value.revision)
}

function isGroupBalanceSnapshot(value: unknown): value is import('./repositories').GroupBalanceSnapshot {
  return isRecord(value) && onlyOperationFields(value, ['groupId', 'balanceRevision', 'simplifyDebtsEnabled', 'pairwise', 'simplified'])
    && isNonEmptyString(value.groupId) && isNonNegativeInteger(value.balanceRevision) && typeof value.simplifyDebtsEnabled === 'boolean'
    && isDebtList(value.pairwise) && isDebtList(value.simplified)
}

function isDebtList(value: unknown): value is readonly import('../domain/model').Debt[] {
  return Array.isArray(value) && value.every((debt) => isRecord(debt) && onlyOperationFields(debt, ['fromParticipantId', 'toParticipantId', 'money'])
    && isNonEmptyString(debt.fromParticipantId) && isNonEmptyString(debt.toParticipantId) && debt.fromParticipantId !== debt.toParticipantId && isPositiveMoney(debt.money))
}

function isSettlementBasis(value: unknown): value is import('./repositories').SettlementBasis {
  return isRecord(value) && onlyOperationFields(value, ['kind', 'senderId', 'recipientId', 'currency', 'debtMinor'])
    && (value.kind === 'pairwise' || value.kind === 'simplified') && isNonEmptyString(value.senderId) && isNonEmptyString(value.recipientId)
    && value.senderId !== value.recipientId && typeof value.currency === 'string' && isPositiveInteger(value.debtMinor)
    && (() => { try { assertCurrencyCode(value.currency as string); return true } catch { return false } })()
}

function sameSettlementBasis(left: import('./repositories').SettlementBasis, right: import('./repositories').SettlementBasis): boolean {
  return left.kind === right.kind && left.senderId === right.senderId && left.recipientId === right.recipientId
    && left.currency === right.currency && left.debtMinor === right.debtMinor
}

function sameMoney(left: Money, right: Money): boolean { return left.currency === right.currency && left.minorAmount === right.minorAmount }
function sameActorSnapshot(left: import('./repositories').ActorSnapshot, right: import('./repositories').ActorSnapshot): boolean { return left.id === right.id && left.displayName === right.displayName }
function isSettlementMethod(value: unknown): value is import('./repositories').SettlementMethod { return value === 'cash' || value === 'bank-transfer' || value === 'payment-app' || value === 'other' }
function isSettlementText(value: unknown, required: boolean): value is string {
  if (typeof value !== 'string' || (required && !value.trim()) || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value)) return false
  return [...value.normalize('NFC').replace(/\r\n?/g, '\n').trim()].length <= 500
}

function isNotificationItem(value: unknown): value is import('./repositories').NotificationItem {
  return isRecord(value) && isNonEmptyString(value.notificationId) && isNonEmptyString(value.principalId) && isNonEmptyString(value.groupId)
    && isNonEmptyString(value.activityId) && isActivityKind(value.kind) && isActivitySubject(value.subject) && isActorSnapshot(value.actor)
    && isIsoTimestamp(value.createdAt) && (value.readAt === undefined || isIsoTimestamp(value.readAt)) && isSyncState(value.syncState)
}

function isActorSnapshot(value: unknown): value is import('./repositories').ActorSnapshot { return isRecord(value) && isNonEmptyString(value.id) && isNonEmptyString(value.displayName) }
function isActivityKind(value: unknown): boolean { return typeof value === 'string' && ['comment.added', 'comment.deleted', 'expense.created', 'expense.updated', 'expense.deleted', 'group.event', 'group.deleted', 'group.restored', 'membership.changed', 'settlement.created', 'settlement.voided'].includes(value) }
function isActivitySubject(value: unknown): boolean { return isRecord(value) && ['comment', 'expense', 'group', 'membership', 'settlement'].includes(String(value.kind)) && isNonEmptyString(value.id) && (value.label === undefined || isNonEmptyString(value.label)) }
function isTimelineCursor(value: unknown): value is import('./repositories').TimelineCursor { return isRecord(value) && isIsoTimestamp(value.createdAt) && isNonEmptyString(value.id) }
function sameTimelineCursor(left: import('./repositories').TimelineCursor, right: import('./repositories').TimelineCursor): boolean { return left.createdAt === right.createdAt && left.id === right.id }
function isNotificationPreferences(value: unknown): value is import('./repositories').NotificationPreferences { return isRecord(value) && typeof value.emailEnabled === 'boolean' && typeof value.pushEnabled === 'boolean' && Object.keys(value).length === 2 }
function samePreferences(left: import('./repositories').NotificationPreferences, right: import('./repositories').NotificationPreferences): boolean { return left.emailEnabled === right.emailEnabled && left.pushEnabled === right.pushEnabled }

function isTombstone(value: unknown, envelope: Extract<CommandEnvelope, { kind: 'expense.delete' }>): boolean {
  return isRecord(value) && value.id === envelope.expenseId && value.groupId === envelope.groupId && value.revision === envelope.expectedRevision + 1 && isIsoTimestamp(value.deletedAt)
}

function isMoney(value: unknown): value is Money {
  if (!isRecord(value) || !Number.isSafeInteger(value.minorAmount) || (value.minorAmount as number) < 0 || typeof value.currency !== 'string') return false
  try { assertCurrencyCode(value.currency); return true } catch { return false }
}

function isPositiveMoney(value: unknown): value is Money { return isMoney(value) && value.minorAmount > 0 }

function isAllocations(value: unknown, currency: Money['currency']): value is readonly Allocation[] {
  return Array.isArray(value) && value.every((allocation) => isRecord(allocation) && isNonEmptyString(allocation.participantId) && isMoney(allocation.money) && allocation.money.currency === currency)
}

function isSplitMethod(value: unknown, currency?: Money['currency']): value is SplitMethod {
  if (!isRecord(value)) return false
  switch (value.type) {
    case 'equal': return isStringArray(value.participantIds)
    case 'exact': return Array.isArray(value.allocations) && (currency === undefined ? value.allocations.every((item) => isRecord(item) && isNonEmptyString(item.participantId) && isMoney(item.money)) : isAllocations(value.allocations, currency))
    case 'percentage': return isStringArray(value.participantIds) && isNumberRecord(value.percentages)
    case 'shares': return isStringArray(value.participantIds) && isNumberRecord(value.shares)
    case 'adjustment': return isStringArray(value.participantIds) && isNumberRecord(value.adjustments)
    case 'itemized': return Array.isArray(value.items) && value.items.every((item) => isRecord(item) && isNonEmptyString(item.description) && isMoney(item.money) && (currency === undefined || item.money.currency === currency) && isStringArray(item.participantIds))
    default: return false
  }
}

function isDefaultSplit(value: unknown): value is import('../domain/groupSettings').DefaultSplit {
  try { decodeDefaultSplit(value); return true } catch { return false }
}

function isRecurrence(value: unknown): value is Recurrence {
  if (!isRecord(value) || !['weekly', 'fortnightly', 'monthly', 'yearly'].includes(String(value.frequency)) || !isRecord(value.anchor) || !Number.isInteger(value.anchor.month) || !Number.isInteger(value.anchor.day) || !isNonEmptyString(value.timeZone)) return false
  const month = value.anchor.month as number
  const day = value.anchor.day as number
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(2024, month, 0)).getUTCDate()) return false
  try { new Intl.DateTimeFormat('en-US', { timeZone: value.timeZone }).format(new Date(0)); return true } catch { return false }
}

function toFailure(error: unknown): CommandFailure {
  if (error instanceof CommandFailedError) return failure(error.code, error.message, error.executed)
  if (error instanceof CommandConflictError || error instanceof OperationReplayConflictError) return failure('conflict', error.message)
  const externalCode = normalizedExternalCode(error)
  if (NETWORK_CODES.has(externalCode) || isFetchFailure(error)) return failure('network', errorMessage(error))
  if (PERMISSION_CODES.has(externalCode)) return failure('permission-denied', errorMessage(error))
  if (VALIDATION_CODES.has(externalCode)) return failure('validation', errorMessage(error))
  if (CONFLICT_CODES.has(externalCode)) return failure('conflict', errorMessage(error))
  if (NOT_SUPPORTED_CODES.has(externalCode)) return failure('not-supported', errorMessage(error))
  return failure('unknown', errorMessage(error))
}

function failure(code: CommandFailureCode, message: string, executed?: boolean): CommandFailure {
  return { code, message, retryable: isRetryableFailureCode(code), ...(executed === undefined ? {} : { executed }) }
}
function isRetryableFailureCode(code: CommandFailureCode): boolean { return code === 'network' || code === 'persistence' }
function isFailureCode(value: unknown): value is CommandFailureCode { return typeof value === 'string' && ['conflict', 'handler-missing', 'network', 'not-supported', 'permission-denied', 'persistence', 'unknown', 'validation'].includes(value) }

const NETWORK_CODES = new Set(['deadline-exceeded', 'network-error', 'network-request-failed', 'unavailable'])
const PERMISSION_CODES = new Set(['operation-not-allowed', 'permission-denied', 'unauthenticated', 'unauthorized'])
const VALIDATION_CODES = new Set(['failed-precondition', 'invalid-argument', 'out-of-range'])
const CONFLICT_CODES = new Set(['aborted', 'already-exists', 'conflict'])
const NOT_SUPPORTED_CODES = new Set(['not-supported', 'unimplemented'])

function normalizedExternalCode(error: unknown): string {
  if (!isRecord(error) || typeof error.code !== 'string') return ''
  return error.code.toLowerCase().split('/').at(-1) ?? ''
}

function isFetchFailure(error: unknown): boolean { return error instanceof TypeError && /failed to fetch|network request failed|load failed/i.test(error.message) }
function errorMessage(error: unknown): string { if (error instanceof Error) return error.message; if (isRecord(error) && typeof error.message === 'string') return error.message; return String(error) }
function conflictDetails(error: unknown, envelope: CommandEnvelope): unknown {
  let details: unknown
  if (error instanceof CommandConflictError) details = cloneJsonValue(error.conflict) ?? { reason: 'conflict' }
  else if (error instanceof OperationReplayConflictError) details = { reason: 'replay-identity' }
  else details = { reason: 'remote-conflict', code: normalizedExternalCode(error) || 'conflict' }
  if (isConflictForEnvelope(details, envelope)) return details
  if (envelope.kind === 'settlement.record' || envelope.kind === 'settlement.void') return { reason: 'invalid-conflict' }
  if (isRecord(details) && Object.prototype.hasOwnProperty.call(details, 'remote')) {
    const { remote: _remote, ...withoutRemote } = details
    return Object.keys(withoutRemote).length > 0 ? withoutRemote : { reason: 'invalid-remote-conflict' }
  }
  return { reason: 'invalid-conflict' }
}

function isConflictForEnvelope(value: unknown, envelope: CommandEnvelope): boolean {
  if (!isJsonValue(value)) return false
  if (!isRecord(value)) return envelope.kind !== 'expense.edit' && envelope.kind !== 'expense.delete'
  if (envelope.kind === 'expense.edit' || envelope.kind === 'expense.delete') {
    if (!Object.prototype.hasOwnProperty.call(value, 'remote')) return true
    return isExpenseRow(value.remote) && value.remote.groupId === envelope.groupId && value.remote.id === envelope.expenseId
  }
  if (envelope.kind !== 'settlement.record' && envelope.kind !== 'settlement.void') return true
  if (typeof value.reason === 'string') return Object.keys(value).every((key) => key === 'reason' || key === 'code') && (value.code === undefined || typeof value.code === 'string')
  if (!isGroupBalanceSnapshot(value.balanceSnapshot) || value.balanceSnapshot.groupId !== envelope.groupId) return false
  if (envelope.kind === 'settlement.record') return onlyOperationFields(value, ['balanceSnapshot'])
  return onlyOperationFields(value, ['remote', 'balanceSnapshot']) && isSettlementRecord(value.remote)
    && value.remote.groupId === envelope.groupId && value.remote.settlementId === envelope.settlementId
}

function assertPrincipalKey(principalKey: string): string {
  if (typeof principalKey !== 'string' || !principalKey.trim() || principalKey.length > 512 || /[\u0000-\u001F\u007F]/.test(principalKey)) throw new Error('Authenticated principal key is required')
  return principalKey
}

function isOperationId(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value) }
function isNonEmptyString(value: unknown): value is string { return typeof value === 'string' && Boolean(value.trim()) }
function isPositiveInteger(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) > 0 }
function isNonNegativeInteger(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0 }
function isStringArray(value: unknown): value is readonly string[] { return Array.isArray(value) && value.every(isNonEmptyString) }
function isNumberRecord(value: unknown): value is Readonly<Record<string, number>> { return isRecord(value) && Object.values(value).every((item) => typeof item === 'number' && Number.isFinite(item)) }
function isSyncState(value: unknown): value is SyncState { return typeof value === 'string' && ['fresh', 'stale', 'pending', 'failed', 'conflicted'].includes(value) }
function isIsoDate(value: unknown): value is string { if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false; const parsed = new Date(`${value}T00:00:00.000Z`); return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value }
function isIsoTimestamp(value: unknown): value is string { if (typeof value !== 'string') return false; const parsed = new Date(value); return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value }
function isCurrencyCode(value: unknown): value is Money['currency'] {
  if (typeof value !== 'string') return false
  try { assertCurrencyCode(value); return true } catch { return false }
}
function isFxRates(value: unknown, targetCurrency: Money['currency']): boolean {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) return false
  const sources = new Set<string>()
  return value.every((rate) => {
    if (!isRecord(rate) || !onlyOperationFields(rate, ['baseCurrency', 'quoteCurrency', 'numerator', 'denominator', 'authority', 'effectiveDate', 'observedAt'])) return false
    if (!isCurrencyCode(rate.baseCurrency) || rate.baseCurrency === targetCurrency || rate.quoteCurrency !== targetCurrency || sources.has(rate.baseCurrency)) return false
    if (!isPositiveInteger(rate.numerator) || !isPositiveInteger(rate.denominator) || !isNonEmptyString(rate.authority) || !isIsoDate(rate.effectiveDate) || !isIsoTimestamp(rate.observedAt)) return false
    sources.add(rate.baseCurrency)
    return true
  })
}
function checkedNow(now: (() => string) | undefined): string {
  const value = (now ?? (() => new Date().toISOString()))()
  if (!isIsoTimestamp(value)) throw new CommandFailedError('validation', 'Queue submission time must be a strict ISO timestamp', false)
  return value
}
function hasDuplicateParticipants(values: readonly Allocation[]): boolean { return new Set(values.map(({ participantId }) => participantId)).size !== values.length }
function sumAllocations(values: readonly Allocation[]): bigint { return values.reduce((sum, { money }) => sum + BigInt(money.minorAmount), 0n) }
function sameAllocations(left: readonly Allocation[], right: readonly Allocation[]): boolean { const key = (value: Allocation) => `${value.participantId}\u0000${value.money.currency}\u0000${value.money.minorAmount}`; const first = [...left].map(key).sort(); const second = [...right].map(key).sort(); return first.length === second.length && first.every((value, index) => value === second[index]) }
function onlyOperationFields(value: Record<string, unknown>, fields: readonly string[]): boolean { const allowed = new Set(fields); return Object.keys(value).every((field) => allowed.has(field)) && fields.every((field) => field in value) }
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function isJsonValue(value: unknown): boolean { if (value === null || typeof value === 'string' || typeof value === 'boolean') return true; if (typeof value === 'number') return Number.isFinite(value); if (Array.isArray(value)) return value.every(isJsonValue); return isRecord(value) && Object.values(value).every(isJsonValue) }

function readBrowserStorage(): Storage | undefined { if (typeof window === 'undefined') return undefined; try { return window.localStorage } catch { return undefined } }
function parseQuarantine(value: string | null): readonly unknown[] { if (value === null) return []; try { const parsed = JSON.parse(value) as unknown; return isRecord(parsed) && Array.isArray(parsed.records) ? parsed.records : [] } catch { return [] } }
function toSerializableRecords(records: readonly unknown[]): readonly unknown[] { return records.map((record) => cloneJsonValue(record) ?? { reason: 'non-serializable-record' }) }
function cloneJsonValue(value: unknown): unknown | undefined { try { return JSON.parse(JSON.stringify(value)) as unknown } catch { return undefined } }
function rejectedHandle(operationId: string, error: Error): CommandHandle { return { operationId, result: () => Promise.reject(error) } }
function cloneOptional<T>(value: T | undefined): T | undefined { return value === undefined ? undefined : clone(value) }
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T }
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}
