import { CommandQueue, type CommandStorage } from './commandQueue'
import { createRepository } from './repositoryFactory'
import type { AppRepository, CommandEnvelope, CommandKind } from './repositories'
import { createDemoReceiptProvider, createIndexedDbReceiptStore, type ReceiptBlobStore, type ReceiptProvider } from './receipts'

export interface AppDataSession {
  readonly repository: AppRepository
  readonly queue: CommandQueue
  readonly receipts: ReceiptBlobStore
  readonly receiptProvider: ReceiptProvider
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
  const execute = (command: CommandEnvelope) => repository.commands.execute(command)
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
  void queue.resume()
  return {
    repository,
    queue,
    receipts: options.receipts ?? createIndexedDbReceiptStore(),
    receiptProvider: options.receiptProvider ?? createDemoReceiptProvider(),
  }
}

export function getAppSession(): AppDataSession {
  return activeSession ??= createAppSession()
}

/** Replaces or resets the singleton without adding test-only methods to production classes. */
export function setAppSessionForTesting(session: AppDataSession | undefined): void {
  activeSession = session
}
