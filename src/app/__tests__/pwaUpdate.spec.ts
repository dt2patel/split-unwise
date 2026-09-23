import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppDataSession } from '../../data/session'
import { setAppSessionForTesting } from '../../data/session'
import { confirmAction } from '../confirmDialog'
import { activatePwaUpdate, setPwaUpdaterForTesting, usePwaStatus } from '../pwa'
import { describeUnsyncedChanges, reduceUpdatePrompt, retryableBeforeUpdate, shouldRegisterServiceWorker, unsyncedChangesAfterRetry, type UpdateOperation } from '../releasePolicy'

vi.mock('../confirmDialog', () => ({ confirmAction: vi.fn() }))
const confirmMock = vi.mocked(confirmAction)

const op = (kind: string, status: UpdateOperation['status'], retryable = false, operationId = `${kind}-${status}`): UpdateOperation =>
  ({ envelope: { kind, operationId }, status, ...(status === 'failed' || status === 'conflicted' ? { error: { retryable } } : {}) })

describe('PWA update policy', () => {
  it('registers only for production web, never development or native Capacitor', () => {
    expect(shouldRegisterServiceWorker({ production: true, native: false })).toBe(true)
    expect(shouldRegisterServiceWorker({ production: false, native: false })).toBe(false)
    expect(shouldRegisterServiceWorker({ production: true, native: true })).toBe(false)
  })

  it('pushes retryable failures first, never holds the update for pending work, and only asks about real changes', () => {
    const operations = [
      op('expense.add', 'failed', true), op('expense.edit', 'failed'), op('settlement.record', 'conflicted'),
      op('notification.read', 'failed'), op('comment.add', 'pending'), op('expense.add', 'fresh'),
    ]
    expect(retryableBeforeUpdate(operations).map(({ envelope }) => envelope.operationId)).toEqual(['expense.add-failed'])
    const { dropQuietly, needsDecision } = unsyncedChangesAfterRetry(operations)
    expect(dropQuietly.map(({ envelope }) => envelope.kind)).toEqual(['notification.read'])
    expect(needsDecision.map(({ envelope }) => envelope.kind)).toEqual(['expense.add', 'expense.edit', 'settlement.record'])
  })

  it('names what would be discarded in plain words', () => {
    expect(describeUnsyncedChanges([op('expense.add', 'failed')])).toBe('1 expense change')
    expect(describeUnsyncedChanges([op('expense.add', 'failed'), op('comment.add', 'failed'), op('comment.delete', 'failed'), op('settlement.void', 'conflicted')]))
      .toBe('1 expense change, 2 comments and 1 payment')
  })

  it('keeps the waiting worker when Later dismisses the prompt', () => {
    const waiting = reduceUpdatePrompt({ waiting: false, dismissed: false }, 'need-refresh')
    expect(waiting).toEqual({ waiting: true, dismissed: false })
    expect(reduceUpdatePrompt(waiting, 'later')).toEqual({ waiting: true, dismissed: true })
    expect(reduceUpdatePrompt(waiting, 'activated')).toEqual({ waiting: false, dismissed: false })
  })
})

describe('Update now', () => {
  const updater = vi.fn(async () => undefined)
  beforeEach(() => { confirmMock.mockReset(); updater.mockClear(); setPwaUpdaterForTesting(updater) })
  afterEach(() => { setAppSessionForTesting(undefined); setPwaUpdaterForTesting(undefined) })

  it('quietly clears a notification change the server rejected and installs the update', async () => {
    const { queue } = useSession([op('notification.read', 'failed')])
    await activatePwaUpdate()
    expect(queue.discard).toHaveBeenCalledWith('notification.read-failed')
    expect(confirmMock).not.toHaveBeenCalled()
    expect(updater).toHaveBeenCalledWith(true)
  })

  it('saves a change that succeeds on retry, then installs without asking', async () => {
    const { queue } = useSession([op('expense.add', 'failed', true)], { retrySucceeds: true })
    await activatePwaUpdate()
    expect(queue.retry).toHaveBeenCalledWith('expense.add-failed')
    expect(confirmMock).not.toHaveBeenCalled()
    expect(updater).toHaveBeenCalledWith(true)
  })

  it('keeps pending changes across the update instead of blocking it', async () => {
    const { queue, session } = useSession([op('comment.add', 'pending')])
    await activatePwaUpdate()
    expect(queue.discard).not.toHaveBeenCalled()
    expect(session.quiesce).toHaveBeenCalled()
    expect(updater).toHaveBeenCalledWith(true)
  })

  it('asks before discarding a real change, then discards it and installs', async () => {
    const { queue } = useSession([op('expense.edit', 'failed'), op('settlement.record', 'conflicted')])
    confirmMock.mockResolvedValue(true)
    await activatePwaUpdate()
    expect(confirmMock).toHaveBeenCalledWith(expect.objectContaining({ header: 'Discard unsynced changes?', confirmText: 'Discard and update', destructive: true, message: expect.stringContaining('1 expense change and 1 payment couldn’t be saved') }))
    expect(queue.discard).toHaveBeenCalledWith('expense.edit-failed')
    expect(queue.acknowledge).toHaveBeenCalledWith('settlement.record-conflicted')
    expect(updater).toHaveBeenCalledWith(true)
  })

  it('leaves everything in place and explains when the user keeps the change', async () => {
    const { queue } = useSession([op('expense.edit', 'failed')])
    confirmMock.mockResolvedValue(false)
    await activatePwaUpdate()
    expect(queue.discard).not.toHaveBeenCalled()
    expect(updater).not.toHaveBeenCalled()
    expect(usePwaStatus().message).toBe('1 expense change still needs to sync. Retry it where you made it, or tap Update now to discard it.')
    expect(usePwaStatus().applying).toBe(false)
  })
})

function useSession(initial: UpdateOperation[], options: { readonly retrySucceeds?: boolean } = {}) {
  let operations = [...initial]
  const settle = (operationId: string) => { operations = operations.filter(({ envelope }) => envelope.operationId !== operationId) }
  const queue = {
    snapshot: vi.fn(() => operations),
    retry: vi.fn((operationId: string) => ({
      result: async () => {
        if (!options.retrySucceeds) throw new Error('still failing')
        operations = operations.map((operation) => operation.envelope.operationId === operationId ? { ...operation, status: 'fresh' as const, error: undefined } : operation)
      },
    })),
    discard: vi.fn(async (operationId: string) => { settle(operationId); return true }),
    acknowledge: vi.fn(async (operationId: string) => { settle(operationId); return true }),
  }
  const session = { ready: Promise.resolve(), queue, quiesce: vi.fn(() => ({ pending: 0, failed: 0, conflicted: 0, total: 0 })), resumeWork: vi.fn() }
  setAppSessionForTesting(session as unknown as AppDataSession)
  return { queue, session }
}
