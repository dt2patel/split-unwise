import { CommandQueue, type CommandStorage } from './commandQueue'
import { createRepository } from './repositoryFactory'
import type { AppRepository, CommandEnvelope, CommandKind } from './repositories'
import { createDemoReceiptProvider, createIndexedDbReceiptStore, type LocalReceiptReference, type ReceiptBlobStore, type ReceiptProvider } from './receipts'

export interface AppDataSession {
  readonly repository: AppRepository
  readonly queue: CommandQueue
  readonly receipts: ReceiptBlobStore
  readonly receiptProvider: ReceiptProvider
  /** Resolves only after repository identity has scoped and resumed the durable queue. */
  readonly ready: Promise<void>
}

export interface AppSessionOptions {
  readonly repository?: AppRepository
  readonly commandStorage?: CommandStorage
  readonly receipts?: ReceiptBlobStore
  readonly receiptProvider?: ReceiptProvider
}

let activeSession: AppDataSession | undefined

export function createAppSession(options: AppSessionOptions = {}): AppDataSession {
  const repository = options.repository ?? createRepository()
  // Construct receipt dependencies before command execution so the wrapper can
  // promote local receipt references before repository writes.
  const receipts = options.receipts ?? createIndexedDbReceiptStore()
  const receiptProvider = options.receiptProvider ?? createDemoReceiptProvider()
  const execute = async (command: CommandEnvelope) => {
    const prepared = await prepareCommandReceipts(command, receiptProvider)
    return repository.commands.execute(prepared)
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
  const queue = new CommandQueue({ handlers, ...(options.commandStorage ? { storage: options.commandStorage } : {}) })
  const ready = repository.app.getCurrentUser().then(async (currentUser) => {
    queue.bind(currentUser.id)
    await queue.resume()
  })
  return {
    repository,
    queue,
    receipts,
    receiptProvider,
    ready,
  }
}

export function getAppSession(): AppDataSession {
  return activeSession ??= createAppSession()
}

/** Replaces or resets the singleton without adding test-only methods to production classes. */
export function setAppSessionForTesting(session: AppDataSession | undefined): void {
  activeSession = session
}

/**
 * Promotes only the execution copy. The queue envelope deliberately keeps its
 * durable local references so a failed or resumed command can retry upload.
 */
export async function prepareCommandReceipts(command: CommandEnvelope, provider: ReceiptProvider): Promise<CommandEnvelope> {
  if (command.kind === 'expense.add') {
    return { ...command, attachmentRefs: await promoteAttachmentRefs(command.groupId, command.attachmentRefs, provider) }
  }
  if (command.kind === 'expense.edit') {
    return { ...command, draft: { ...command.draft, attachmentRefs: await promoteAttachmentRefs(command.groupId, command.draft.attachmentRefs, provider) } }
  }
  return command
}

async function promoteAttachmentRefs(groupId: string, references: readonly string[], provider: ReceiptProvider): Promise<readonly string[]> {
  return Promise.all(references.map(async (reference) => {
    if (!isLocalReceiptReference(reference)) return reference
    const upload = await provider.upload(groupId, reference)
    return upload.status === 'uploaded' ? upload.attachmentRef : reference
  }))
}

function isLocalReceiptReference(value: string): value is LocalReceiptReference {
  return /^local-receipt:[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)
}
