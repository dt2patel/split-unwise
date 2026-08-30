import type { Allocation, Money, Recurrence, SplitMethod } from '../domain/model'
import { assertCurrencyCode } from '../domain/money'
import { computeAllocations } from '../domain/splits'
import type { CommandEnvelope, CommandKind, CommandResult, ExpenseDraft, ExpenseRow, SyncState } from './repositories'
import { assertOperationId, canonicalEnvelopeFingerprint, OperationReplayConflictError } from './operationIdentity'

export const COMMAND_QUEUE_STORAGE_VERSION = 2 as const
const COMMAND_QUEUE_STORAGE_PREFIX = `split-unwise:command-queue:v${COMMAND_QUEUE_STORAGE_VERSION}`
const COMMAND_QUEUE_QUARANTINE_PREFIX = `split-unwise:command-queue:quarantine:v${COMMAND_QUEUE_STORAGE_VERSION}`

export type CommandFailureCode = 'conflict' | 'handler-missing' | 'network' | 'not-supported' | 'permission-denied' | 'unknown' | 'validation'
export interface CommandFailure {
  readonly code: CommandFailureCode
  readonly message: string
  readonly retryable: boolean
  readonly conflict?: unknown
}

export class CommandConflictError extends Error {
  readonly conflict: unknown
  constructor(message: string, conflict?: unknown) { super(message); this.name = 'CommandConflictError'; this.conflict = conflict }
}

export class CommandFailedError extends Error {
  readonly retryable: boolean
  constructor(readonly code: CommandFailureCode, message: string) {
    super(message)
    this.name = 'CommandFailedError'
    this.retryable = isRetryableFailureCode(code)
  }
}

interface OwnedOperation { readonly originUid: string; readonly envelope: CommandEnvelope }
export type CommandOperation =
  | (OwnedOperation & { readonly status: 'pending' })
  | (OwnedOperation & { readonly status: 'fresh' | 'stale'; readonly result: CommandResult })
  | (OwnedOperation & { readonly status: 'failed'; readonly error: CommandFailure })
  | (OwnedOperation & { readonly status: 'conflicted'; readonly error: CommandFailure; readonly conflict: unknown })

export interface PersistedCommandQueue {
  readonly version: typeof COMMAND_QUEUE_STORAGE_VERSION
  readonly originUid: string
  readonly operations: readonly CommandOperation[]
}

/** Storage is always addressed by UID. There is no account-agnostic load or save path. */
export interface CommandStorage {
  load(originUid: string): unknown
  save(originUid: string, document: PersistedCommandQueue): void
  quarantine?(originUid: string, records: readonly unknown[]): void
}

export interface CommandHandle { readonly operationId: string; result(): Promise<CommandResult> }
export type CommandHandler = (command: CommandEnvelope) => Promise<CommandResult>
export type CommandHandlers = Partial<Record<CommandKind, CommandHandler>>
export interface CommandQueueOptions {
  readonly handlers: CommandHandlers
  readonly storage?: CommandStorage
  /** Useful for deterministic seams. App sessions bind only after hydrating repository identity. */
  readonly originUid?: string
}

/** Serializable, timer-free queue. Commands are persisted before registered handlers run. */
export class CommandQueue {
  private readonly operations = new Map<string, CommandOperation>()
  private readonly listeners = new Set<(operation: CommandOperation) => void>()
  private readonly running = new Map<string, Promise<void>>()
  private readonly storage: CommandStorage
  private originUid: string | undefined

  constructor(private readonly options: CommandQueueOptions) {
    this.storage = options.storage ?? createBrowserCommandStorage()
    if (options.originUid !== undefined) this.bind(options.originUid)
  }

  /** A queue is permanently scoped to one authenticated identity for its lifetime. */
  bind(originUid: string): void {
    const owner = assertOriginUid(originUid)
    if (this.originUid !== undefined) {
      if (this.originUid !== owner) throw new Error('Command queue is already bound to a different authenticated owner')
      return
    }
    this.originUid = owner
    const decoded = decodePersistedQueue(this.storage.load(owner), owner)
    for (const operation of decoded.operations) {
      if (this.operations.has(operation.envelope.operationId)) decoded.rejected.push(operation)
      else this.operations.set(operation.envelope.operationId, operation)
    }
    if (decoded.rejected.length > 0) {
      this.storage.quarantine?.(owner, clone(decoded.rejected))
      this.persist()
    }
  }

  submit(command: CommandEnvelope): CommandHandle {
    const originUid = this.requireOwner()
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
    this.replace({ originUid, status: 'pending', envelope: clone(command) })
    this.start(command.operationId)
    return this.handle(command.operationId)
  }

  retry(operationId: string): CommandHandle {
    this.requireOwner()
    const operation = this.operations.get(operationId)
    if (!operation || operation.status !== 'failed') return rejectedHandle(operationId, new Error('Only failed operations can be retried'))
    if (!operation.error.retryable) return rejectedHandle(operationId, new Error(`The ${operation.error.code} failure is not retryable`))
    this.replace({ originUid: operation.originUid, status: 'pending', envelope: operation.envelope })
    this.start(operationId)
    return this.handle(operationId)
  }

  get(operationId: string): CommandOperation | undefined { return cloneOptional(this.operations.get(operationId)) }
  snapshot(): readonly CommandOperation[] { return clone([...this.operations.values()]) }

  discard(operationId: string): boolean {
    this.requireOwner()
    const operation = this.operations.get(operationId)
    if (!operation) return false
    if (operation.status !== 'failed') throw new Error('Only failed operations can be discarded')
    this.operations.delete(operationId)
    this.persist()
    this.notify(operation)
    return true
  }

  /** Removes a reconciled terminal journal record after its server state is reflected in reads. */
  acknowledge(operationId: string): boolean {
    this.requireOwner()
    const operation = this.operations.get(operationId)
    if (!operation) return false
    if (operation.status !== 'fresh' && operation.status !== 'stale' && operation.status !== 'conflicted') {
      throw new Error('Only fresh, stale, or conflicted operations can be acknowledged')
    }
    this.operations.delete(operationId)
    this.persist()
    this.notify(operation)
    return true
  }

  subscribe(listener: (operation: CommandOperation) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  markStale(operationId: string): CommandOperation { return this.setReadState(operationId, 'stale') }
  markFresh(operationId: string): CommandOperation { return this.setReadState(operationId, 'fresh') }

  async resume(): Promise<void> {
    this.requireOwner()
    const pending = [...this.operations.values()].filter((operation): operation is Extract<CommandOperation, { status: 'pending' }> => operation.status === 'pending')
    await Promise.all(pending.map((operation) => this.start(operation.envelope.operationId)))
  }

  private requireOwner(): string {
    if (this.originUid === undefined) throw new Error('Command queue requires an authenticated owner before use')
    return this.originUid
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
    if (operation.status === 'failed') throw new CommandFailedError(operation.error.code, operation.error.message)
    throw new Error(`Operation ${operationId} is unavailable`)
  }

  private start(operationId: string): Promise<void> {
    const active = this.running.get(operationId)
    if (active) return active
    const operation = this.operations.get(operationId)
    if (!operation || operation.status !== 'pending') return Promise.resolve()
    const handler = this.options.handlers[operation.envelope.kind]
    if (!handler) {
      this.replace({
        originUid: operation.originUid,
        status: 'failed',
        envelope: operation.envelope,
        error: failure('handler-missing', `No handler is registered for ${operation.envelope.kind}`),
      })
      return Promise.resolve()
    }
    const running = Promise.resolve()
      .then(() => handler(operation.envelope))
      .then((result) => {
        if (result.status === 'not-supported') throw new CommandFailedError('not-supported', result.reason)
        if (!isCommandResultFor(result, operation.envelope)) throw new CommandFailedError('validation', 'Command handler returned an invalid or mismatched result')
        const current = this.operations.get(operationId)
        if (current?.status === 'pending' && canonicalEnvelopeFingerprint(current.envelope) === canonicalEnvelopeFingerprint(operation.envelope)) {
          this.replace({ originUid: operation.originUid, status: 'fresh', envelope: operation.envelope, result: clone(result) })
        }
      })
      .catch((error: unknown) => {
        const current = this.operations.get(operationId)
        if (current?.status !== 'pending' || canonicalEnvelopeFingerprint(current.envelope) !== canonicalEnvelopeFingerprint(operation.envelope)) return
        const mapped = toFailure(error)
        if (mapped.code === 'conflict') {
          this.replace({ originUid: operation.originUid, status: 'conflicted', envelope: operation.envelope, error: mapped, conflict: conflictDetails(error, operation.envelope) })
        } else {
          this.replace({ originUid: operation.originUid, status: 'failed', envelope: operation.envelope, error: mapped })
        }
      })
      .finally(() => { this.running.delete(operationId) })
    this.running.set(operationId, running)
    return running
  }

  private setReadState(operationId: string, status: Extract<SyncState, 'fresh' | 'stale'>): CommandOperation {
    this.requireOwner()
    const operation = this.operations.get(operationId)
    if (!operation || (operation.status !== 'fresh' && operation.status !== 'stale')) throw new Error('Only fresh or stale operations can be marked stale or fresh')
    const updated: CommandOperation = { ...operation, status }
    this.replace(updated)
    return clone(updated)
  }

  private replace(operation: CommandOperation): void {
    const owner = this.requireOwner()
    if (operation.originUid !== owner) throw new Error('Command operation owner does not match the authenticated queue owner')
    this.operations.set(operation.envelope.operationId, clone(operation))
    this.persist()
    this.notify(operation)
  }

  private persist(): void {
    const originUid = this.requireOwner()
    this.storage.save(originUid, { version: COMMAND_QUEUE_STORAGE_VERSION, originUid, operations: clone([...this.operations.values()]) })
  }

  private notify(operation: CommandOperation): void {
    const copy = clone(operation)
    this.listeners.forEach((listener) => { try { listener(copy) } catch { /* subscribers cannot affect durable command state */ } })
  }
}

/** Deterministic UID-indexed storage seam for tests and non-browser hosts. */
export function createMemoryCommandStorage(initial: Readonly<Record<string, unknown>> = {}): CommandStorage {
  const documents = new Map(Object.entries(clone(initial)))
  const quarantined = new Map<string, unknown[]>()
  return {
    load: (originUid) => cloneOptional(documents.get(originUid)),
    save: (originUid, document) => { documents.set(originUid, clone(document)) },
    quarantine: (originUid, records) => { quarantined.set(originUid, [...(quarantined.get(originUid) ?? []), ...clone(records)]) },
  }
}

export interface BrowserCommandStorageOptions { readonly storage?: Storage; readonly keyPrefix?: string }

/** Browser persistence uses a distinct key for each authenticated UID. */
export function createBrowserCommandStorage(options: BrowserCommandStorageOptions = {}): CommandStorage {
  const storage = options.storage ?? readBrowserStorage()
  const prefix = options.keyPrefix ?? COMMAND_QUEUE_STORAGE_PREFIX
  const keyFor = (originUid: string) => `${prefix}:${encodeURIComponent(originUid)}`
  const quarantineKeyFor = (originUid: string) => `${COMMAND_QUEUE_QUARANTINE_PREFIX}:${encodeURIComponent(originUid)}`
  const quarantine = (originUid: string, records: readonly unknown[]) => {
    if (!storage || records.length === 0) return
    try {
      const key = quarantineKeyFor(originUid)
      const current = parseQuarantine(storage.getItem(key))
      storage.setItem(key, JSON.stringify({ version: COMMAND_QUEUE_STORAGE_VERSION, originUid, records: [...current, ...toSerializableRecords(records)] }))
    } catch { /* persistence failures leave the in-memory queue usable */ }
  }
  return {
    load: (originUid) => {
      if (!storage) return undefined
      const key = keyFor(originUid)
      try {
        const value = storage.getItem(key)
        if (value === null) return undefined
        try { return JSON.parse(value) as unknown } catch {
          quarantine(originUid, [{ reason: 'invalid-json', raw: value }])
          storage.removeItem(key)
          return undefined
        }
      } catch { return undefined }
    },
    save: (originUid, document) => { try { storage?.setItem(keyFor(originUid), JSON.stringify(document)) } catch { /* unavailable storage leaves the in-memory queue usable */ } },
    quarantine,
  }
}

function decodePersistedQueue(value: unknown, originUid: string): { operations: CommandOperation[]; rejected: unknown[] } {
  if (value === undefined || value === null) return { operations: [], rejected: [] }
  if (!isRecord(value) || value.version !== COMMAND_QUEUE_STORAGE_VERSION || value.originUid !== originUid || !Array.isArray(value.operations)) {
    return { operations: [], rejected: [value] }
  }
  const operations: CommandOperation[] = []
  const rejected: unknown[] = []
  for (const candidate of value.operations) {
    if (isCommandOperation(candidate, originUid)) operations.push(clone(candidate))
    else rejected.push(candidate)
  }
  return { operations, rejected }
}

function isCommandOperation(value: unknown, originUid: string): value is CommandOperation {
  if (!isRecord(value) || value.originUid !== originUid || !isCommandEnvelope(value.envelope)) return false
  if (value.status === 'pending') return onlyOperationFields(value, ['originUid', 'status', 'envelope'])
  if (value.status === 'fresh' || value.status === 'stale') return onlyOperationFields(value, ['originUid', 'status', 'envelope', 'result']) && isCommandResultFor(value.result, value.envelope)
  if (value.status === 'failed') return onlyOperationFields(value, ['originUid', 'status', 'envelope', 'error']) && isCommandFailure(value.error) && value.error.code !== 'conflict'
  if (value.status === 'conflicted') return onlyOperationFields(value, ['originUid', 'status', 'envelope', 'error', 'conflict']) && isCommandFailure(value.error) && value.error.code === 'conflict' && isConflictForEnvelope(value.conflict, value.envelope)
  return false
}

function isCommandFailure(value: unknown): value is CommandFailure {
  if (!isRecord(value) || !isFailureCode(value.code) || typeof value.message !== 'string' || typeof value.retryable !== 'boolean') return false
  return value.retryable === isRetryableFailureCode(value.code) && (value.conflict === undefined || isJsonValue(value.conflict))
}

function isCommandEnvelope(value: unknown): value is CommandEnvelope {
  if (!isRecord(value) || !isOperationId(value.operationId) || typeof value.kind !== 'string') return false
  switch (value.kind) {
    case 'expense.add': return isExpenseDraft(value)
    case 'expense.edit': return isNonEmptyString(value.groupId) && isNonEmptyString(value.expenseId) && isPositiveInteger(value.expectedRevision) && isExpenseDraft(value.draft)
    case 'expense.delete': return isNonEmptyString(value.groupId) && isNonEmptyString(value.expenseId) && isPositiveInteger(value.expectedRevision)
    case 'comment.add': return isNonEmptyString(value.groupId) && isNonEmptyString(value.expenseId) && isNonEmptyString(value.body)
    case 'settlement.record': return isNonEmptyString(value.groupId) && isNonEmptyString(value.fromParticipantId) && isNonEmptyString(value.toParticipantId) && isMoney(value.money) && isRecord(value.confirmation) && value.confirmation.kind === 'manual' && isIsoTimestamp(value.confirmation.confirmedAt)
    case 'group.default-split': return isNonEmptyString(value.groupId) && isSplitMethod(value.defaultSplit)
    case 'profile.update': return isNonEmptyString(value.displayName) && (value.initials === undefined || isNonEmptyString(value.initials))
    default: return false
  }
}

function isCommandResultFor(value: unknown, envelope: CommandEnvelope): value is CommandResult {
  if (!isRecord(value) || value.kind !== envelope.kind || value.operationId !== envelope.operationId || value.status !== 'saved') return false
  switch (envelope.kind) {
    case 'expense.add': return isExpenseRow(value.expense) && value.expense.groupId === envelope.groupId
    case 'expense.edit': return isExpenseRow(value.expense) && value.expense.groupId === envelope.groupId && value.expense.id === envelope.expenseId
    case 'expense.delete': return isTombstone(value.tombstone, envelope)
    case 'comment.add':
    case 'group.default-split':
    case 'profile.update':
    case 'settlement.record': return isNonEmptyString(value.resourceId)
  }
}

function isExpenseDraft(value: unknown): value is ExpenseDraft {
  if (!isRecord(value) || !isNonEmptyString(value.groupId) || !isNonEmptyString(value.description) || !isIsoDate(value.date) || !isMoney(value.total)
    || !isAllocations(value.payments, value.total.currency) || !isAllocations(value.allocations, value.total.currency) || !isNonEmptyString(value.category)
    || !isSplitMethod(value.splitMethod, value.total.currency) || !isStringArray(value.attachmentRefs) || (value.notes !== undefined && typeof value.notes !== 'string')
    || (value.recurrence !== undefined && !isRecurrence(value.recurrence)) || (value.occurrenceEditScope !== undefined && value.occurrenceEditScope !== 'occurrence' && value.occurrenceEditScope !== 'future')) return false
  if (value.payments.length === 0 || hasDuplicateParticipants(value.payments) || hasDuplicateParticipants(value.allocations)) return false
  if (sumAllocations(value.payments) !== BigInt(value.total.minorAmount) || sumAllocations(value.allocations) !== BigInt(value.total.minorAmount)) return false
  try { return sameAllocations(computeAllocations(value.total, value.splitMethod), value.allocations) } catch { return false }
}

function isExpenseRow(value: unknown): value is ExpenseRow {
  return isExpenseDraft(value) && isRecord(value) && isNonEmptyString(value.id) && isIsoTimestamp(value.createdAt) && isIsoTimestamp(value.updatedAt) && isPositiveInteger(value.revision) && isSyncState(value.syncState)
    && (value.recurringTemplateId === undefined || isNonEmptyString(value.recurringTemplateId)) && (value.deletedAt === undefined || isIsoTimestamp(value.deletedAt))
}

function isTombstone(value: unknown, envelope: Extract<CommandEnvelope, { kind: 'expense.delete' }>): boolean {
  return isRecord(value) && value.id === envelope.expenseId && value.groupId === envelope.groupId && isPositiveInteger(value.revision) && isIsoTimestamp(value.deletedAt)
}

function isMoney(value: unknown): value is Money {
  if (!isRecord(value) || !Number.isSafeInteger(value.minorAmount) || (value.minorAmount as number) < 0 || typeof value.currency !== 'string') return false
  try { assertCurrencyCode(value.currency); return true } catch { return false }
}

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

function isRecurrence(value: unknown): value is Recurrence {
  if (!isRecord(value) || !['weekly', 'fortnightly', 'monthly', 'yearly'].includes(String(value.frequency)) || !isRecord(value.anchor) || !Number.isInteger(value.anchor.month) || !Number.isInteger(value.anchor.day) || !isNonEmptyString(value.timeZone)) return false
  const month = value.anchor.month as number
  const day = value.anchor.day as number
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(2024, month, 0)).getUTCDate()) return false
  try { new Intl.DateTimeFormat('en-US', { timeZone: value.timeZone }).format(new Date(0)); return true } catch { return false }
}

function toFailure(error: unknown): CommandFailure {
  if (error instanceof CommandFailedError) return failure(error.code, error.message)
  if (error instanceof CommandConflictError || error instanceof OperationReplayConflictError) return failure('conflict', error.message)
  const externalCode = normalizedExternalCode(error)
  if (NETWORK_CODES.has(externalCode) || isFetchFailure(error)) return failure('network', errorMessage(error))
  if (PERMISSION_CODES.has(externalCode)) return failure('permission-denied', errorMessage(error))
  if (VALIDATION_CODES.has(externalCode)) return failure('validation', errorMessage(error))
  if (CONFLICT_CODES.has(externalCode)) return failure('conflict', errorMessage(error))
  if (NOT_SUPPORTED_CODES.has(externalCode)) return failure('not-supported', errorMessage(error))
  return failure('unknown', errorMessage(error))
}

function failure(code: CommandFailureCode, message: string): CommandFailure { return { code, message, retryable: isRetryableFailureCode(code) } }
function isRetryableFailureCode(code: CommandFailureCode): boolean { return code === 'network' }
function isFailureCode(value: unknown): value is CommandFailureCode { return typeof value === 'string' && ['conflict', 'handler-missing', 'network', 'not-supported', 'permission-denied', 'unknown', 'validation'].includes(value) }

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
  if (isRecord(details) && Object.prototype.hasOwnProperty.call(details, 'remote')) {
    const { remote: _remote, ...withoutRemote } = details
    return Object.keys(withoutRemote).length > 0 ? withoutRemote : { reason: 'invalid-remote-conflict' }
  }
  return { reason: 'invalid-conflict' }
}

function isConflictForEnvelope(value: unknown, envelope: CommandEnvelope): boolean {
  if (!isJsonValue(value)) return false
  if ((envelope.kind !== 'expense.edit' && envelope.kind !== 'expense.delete') || !isRecord(value) || !Object.prototype.hasOwnProperty.call(value, 'remote')) return true
  return isExpenseRow(value.remote) && value.remote.groupId === envelope.groupId && value.remote.id === envelope.expenseId
}

function assertOriginUid(originUid: string): string {
  if (typeof originUid !== 'string' || !originUid.trim() || originUid.length > 256 || /[\u0000-\u001F\u007F]/.test(originUid)) throw new Error('Authenticated owner UID is required')
  return originUid
}

function isOperationId(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value) }
function isNonEmptyString(value: unknown): value is string { return typeof value === 'string' && Boolean(value.trim()) }
function isPositiveInteger(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) > 0 }
function isStringArray(value: unknown): value is readonly string[] { return Array.isArray(value) && value.every(isNonEmptyString) }
function isNumberRecord(value: unknown): value is Readonly<Record<string, number>> { return isRecord(value) && Object.values(value).every((item) => typeof item === 'number' && Number.isFinite(item)) }
function isSyncState(value: unknown): value is SyncState { return typeof value === 'string' && ['fresh', 'stale', 'pending', 'failed', 'conflicted'].includes(value) }
function isIsoDate(value: unknown): value is string { if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false; const parsed = new Date(`${value}T00:00:00.000Z`); return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value }
function isIsoTimestamp(value: unknown): value is string { if (typeof value !== 'string') return false; const parsed = new Date(value); return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value }
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
