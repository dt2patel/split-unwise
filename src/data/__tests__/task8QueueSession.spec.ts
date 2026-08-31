import { describe, expect, it, vi } from 'vitest'
import { CommandConflictError, CommandQueue, COMMAND_QUEUE_STORAGE_VERSION, createBrowserCommandStorage, createMemoryCommandStorage } from '../commandQueue'
import { createDemoRepository } from '../demoRepository'
import { createFirebaseRepository } from '../firebaseRepository'
import type { CommandEnvelope, SettlementRecordCommand } from '../repositories'
import { appPrincipalKey, createAppSession } from '../session'

const principal = { mode: 'demo' as const, projectId: 'split-unwise-demo', uid: 'maya-p' }
const principalKey = appPrincipalKey(principal)
const firebaseConfiguration = {
  apiKey: 'key', authDomain: 'auth.example', projectId: 'split-unwise-test', storageBucket: 'bucket', messagingSenderId: 'sender', appId: 'app',
}

describe('Task 8 strict command protocol', () => {
  it('moves to schema v6 and quarantines the complete v5 financial protocol', async () => {
    const legacy = { version: 5, principalKey, operations: [] }
    const quarantined: unknown[] = []
    const queue = new CommandQueue({
      handlers: {},
      storage: {
        load: () => legacy,
        save: async () => undefined,
        quarantine: async (_scope, records) => { quarantined.push(...records) },
      },
    })

    await queue.bind(principalKey)

    expect(COMMAND_QUEUE_STORAGE_VERSION).toBe(6)
    expect(queue.snapshot()).toEqual([])
    expect(quarantined).toEqual([legacy])
  })

  it('discovers the real principal-scoped v5 browser key and quarantines it without execution', async () => {
    const browser = createWebStorage()
    const legacy = {
      version: 5,
      principalKey,
      operations: [{
        originPrincipalKey: principalKey,
        submittedAt: '2026-08-31T20:00:00.000Z',
        status: 'pending',
        envelope: recordCommand('browser-v5-settlement', 5, 500),
      }],
    }
    const legacyKey = `split-unwise:command-queue:v5:${encodeURIComponent(principalKey)}`
    const quarantineKey = `split-unwise:command-queue:quarantine:v6:${encodeURIComponent(principalKey)}`
    browser.setItem(legacyKey, JSON.stringify(legacy))
    let calls = 0
    const queue = new CommandQueue({
      originPrincipalKey: principalKey,
      storage: createBrowserCommandStorage({ storage: browser }),
      handlers: { 'settlement.record': async () => { calls += 1; throw new Error('must not run') } },
    })

    await queue.resume()

    expect(calls).toBe(0)
    expect(queue.snapshot()).toEqual([])
    expect(browser.getItem(legacyKey)).toBeNull()
    expect(JSON.parse(browser.getItem(quarantineKey) ?? 'null')).toMatchObject({ version: 6, principalKey, records: [legacy] })
  })

  it('quarantines an amount-only legacy settlement instead of executing it', async () => {
    let calls = 0
    const legacyOperation = {
      originPrincipalKey: principalKey,
      submittedAt: '2026-08-31T20:00:00.000Z',
      status: 'pending',
      envelope: {
        kind: 'settlement.record', operationId: 'legacy-settlement', groupId: 'lake-house-weekend',
        fromParticipantId: 'taylor-s', toParticipantId: 'maya-p', money: { currency: 'USD', minorAmount: 500 },
        confirmation: { kind: 'manual', confirmedAt: '2026-08-31T20:00:00.000Z' },
      },
    }
    const quarantined: unknown[] = []
    const queue = new CommandQueue({
      originPrincipalKey: principalKey,
      handlers: { 'settlement.record': async () => { calls += 1; throw new Error('must not run') } },
      storage: {
        load: () => ({ version: 6, principalKey, operations: [legacyOperation] }),
        save: async () => undefined,
        quarantine: async (_scope, records) => { quarantined.push(...records) },
      },
    })

    await queue.resume()

    expect(queue.snapshot()).toEqual([])
    expect(quarantined).toEqual([legacyOperation])
    expect(calls).toBe(0)
  })

  it.each([
    ['unconfirmed payment', { outsidePaymentConfirmed: false }],
    ['amount above selected debt', { money: { currency: 'USD', minorAmount: 3626 } }],
  ])('quarantines persisted v6 settlement record with %s before its handler runs', async (_label, override) => {
    const envelope = { ...recordCommand(`invalid-${_label.replaceAll(' ', '-')}`, 5, 500), ...override }
    const operation = {
      originPrincipalKey: principalKey,
      submittedAt: '2026-08-31T20:00:00.000Z',
      status: 'pending',
      envelope,
    }
    const quarantined: unknown[] = []
    let calls = 0
    const queue = new CommandQueue({
      originPrincipalKey: principalKey,
      handlers: { 'settlement.record': async () => { calls += 1; throw new Error('must not run') } },
      storage: {
        load: () => ({ version: 6, principalKey, operations: [operation] }),
        save: async () => undefined,
        quarantine: async (_scope, records) => { quarantined.push(...records) },
      },
    })

    await queue.resume()

    expect(queue.snapshot()).toEqual([])
    expect(quarantined).toEqual([operation])
    expect(calls).toBe(0)
  })

  it('quarantines a complete settlement intent owned by another full principal', async () => {
    const foreignPrincipalKey = appPrincipalKey({ mode: 'demo', projectId: 'split-unwise-demo', uid: 'taylor-s' })
    const operation = {
      originPrincipalKey: foreignPrincipalKey,
      submittedAt: '2026-08-31T20:00:00.000Z',
      status: 'pending' as const,
      envelope: recordCommand('foreign-settlement', 5, 500),
    }
    const quarantined: unknown[] = []
    let calls = 0
    const queue = new CommandQueue({
      originPrincipalKey: principalKey,
      handlers: { 'settlement.record': async () => { calls += 1; throw new Error('must not run') } },
      storage: {
        load: () => ({ version: 6, principalKey, operations: [operation] }),
        save: async () => undefined,
        quarantine: async (_scope, records) => { quarantined.push(...records) },
      },
    })

    await queue.resume()

    expect(queue.snapshot()).toEqual([])
    expect(quarantined).toEqual([operation])
    expect(calls).toBe(0)
  })

  it('persists and resumes a complete settlement envelope with exact result identity', async () => {
    const repository = createDemoRepository()
    const snapshot = await repository.groups.getBalanceSnapshot('lake-house-weekend')
    const envelope = recordCommand('resume-settlement', snapshot.balanceRevision, 500)
    const storage = createMemoryCommandStorage({
      [principalKey]: {
        version: 6,
        principalKey,
        operations: [{ originPrincipalKey: principalKey, submittedAt: '2026-08-31T20:00:00.000Z', status: 'pending', envelope }],
      },
    })
    const queue = new CommandQueue({
      originPrincipalKey: principalKey,
      storage,
      handlers: { 'settlement.record': (command) => repository.settlements.record(command as SettlementRecordCommand) },
    })

    await queue.resume()
    await vi.waitFor(() => expect(queue.get(envelope.operationId)?.status).toBe('fresh'))

    expect(queue.get(envelope.operationId)).toMatchObject({
      status: 'fresh',
      result: { kind: 'settlement.record', operationId: envelope.operationId, settlement: { groupId: envelope.groupId, basis: envelope.basis } },
    })
  })

  it('rejects a settlement result that crosses the command group or selected basis', async () => {
    const repository = createDemoRepository()
    const snapshot = await repository.groups.getBalanceSnapshot('lake-house-weekend')
    const envelope = recordCommand('mismatched-result', snapshot.balanceRevision, 500)
    const real = await repository.settlements.record(envelope)
    if (real.status !== 'saved') throw new Error('Expected demo settlement save')
    const queue = new CommandQueue({
      originPrincipalKey: principalKey,
      storage: createMemoryCommandStorage(),
      handlers: {
        'settlement.record': async () => ({
          ...real,
          settlement: { ...real.settlement, groupId: 'another-group' },
        }),
      },
    })

    await expect(queue.submit(envelope).result()).rejects.toMatchObject({ code: 'validation' })
    expect(queue.get(envelope.operationId)).toMatchObject({ status: 'failed', error: { code: 'validation', retryable: false } })
  })

  it('scrubs a settlement-record conflict whose balance snapshot crosses groups', async () => {
    const repository = createDemoRepository()
    const snapshot = await repository.groups.getBalanceSnapshot('lake-house-weekend')
    const envelope = recordCommand('cross-group-record-conflict', snapshot.balanceRevision, 500)
    const queue = new CommandQueue({
      originPrincipalKey: principalKey,
      storage: createMemoryCommandStorage(),
      handlers: {
        'settlement.record': async () => {
          throw new CommandConflictError('remote changed', { balanceSnapshot: { ...snapshot, groupId: 'another-group' } })
        },
      },
    })

    await expect(queue.submit(envelope).result()).rejects.toMatchObject({ conflict: { reason: 'invalid-conflict' } })
    expect(queue.get(envelope.operationId)).toMatchObject({ status: 'conflicted', conflict: { reason: 'invalid-conflict' } })
  })

  it('scrubs a settlement-void conflict whose remote settlement identity does not match the command', async () => {
    const repository = createDemoRepository()
    const before = await repository.groups.getBalanceSnapshot('lake-house-weekend')
    const recorded = await repository.settlements.record(recordCommand('record-for-invalid-void-conflict', before.balanceRevision, 500))
    if (recorded.status !== 'saved') throw new Error('Expected settlement')
    const envelope = {
      kind: 'settlement.void' as const,
      operationId: 'mismatched-void-conflict',
      groupId: 'lake-house-weekend',
      settlementId: recorded.settlement.settlementId,
      expectedRevision: recorded.settlement.revision,
      expectedBalanceRevision: recorded.balanceSnapshot.balanceRevision,
      reason: 'Duplicate record',
    }
    const queue = new CommandQueue({
      originPrincipalKey: principalKey,
      storage: createMemoryCommandStorage(),
      handlers: {
        'settlement.void': async () => {
          throw new CommandConflictError('remote changed', {
            remote: { ...recorded.settlement, settlementId: 'another-settlement' },
            balanceSnapshot: recorded.balanceSnapshot,
          })
        },
      },
    })

    await expect(queue.submit(envelope).result()).rejects.toMatchObject({ conflict: { reason: 'invalid-conflict' } })
    expect(queue.get(envelope.operationId)).toMatchObject({ status: 'conflicted', conflict: { reason: 'invalid-conflict' } })
  })

  it('quarantines a persisted settlement conflict with mismatched group identity', async () => {
    const repository = createDemoRepository()
    const snapshot = await repository.groups.getBalanceSnapshot('lake-house-weekend')
    const envelope = recordCommand('persisted-cross-group-conflict', snapshot.balanceRevision, 500)
    const operation = {
      originPrincipalKey: principalKey,
      submittedAt: '2026-08-31T20:00:00.000Z',
      status: 'conflicted',
      envelope,
      error: { code: 'conflict', message: 'remote changed', retryable: false },
      conflict: { balanceSnapshot: { ...snapshot, groupId: 'another-group' } },
    }
    const quarantined: unknown[] = []
    const queue = new CommandQueue({
      originPrincipalKey: principalKey,
      handlers: {},
      storage: {
        load: () => ({ version: 6, principalKey, operations: [operation] }),
        save: async () => undefined,
        quarantine: async (_scope, records) => { quarantined.push(...records) },
      },
    })

    await queue.resume()

    expect(queue.snapshot()).toEqual([])
    expect(quarantined).toEqual([operation])
  })

  it('rejects a saved settlement whose immutable creator does not match its atomic activity actor', async () => {
    const repository = createDemoRepository()
    const snapshot = await repository.groups.getBalanceSnapshot('lake-house-weekend')
    const envelope = recordCommand('forged-settlement-actor', snapshot.balanceRevision, 500)
    const real = await repository.settlements.record(envelope)
    if (real.status !== 'saved') throw new Error('Expected demo settlement save')
    const queue = new CommandQueue({
      originPrincipalKey: principalKey,
      storage: createMemoryCommandStorage(),
      handlers: {
        'settlement.record': async () => ({
          ...real,
          settlement: { ...real.settlement, createdBy: { id: 'forged-actor', displayName: 'Forged Actor' } },
        }),
      },
    })

    await expect(queue.submit(envelope).result()).rejects.toMatchObject({ code: 'validation' })
  })

  it('validates and persists a settlement void result against both exact revisions', async () => {
    const repository = createDemoRepository()
    const before = await repository.groups.getBalanceSnapshot('lake-house-weekend')
    const recorded = await repository.settlements.record(recordCommand('record-before-queue-void', before.balanceRevision, 500))
    if (recorded.status !== 'saved') throw new Error('Expected demo settlement save')
    const command = {
      kind: 'settlement.void' as const,
      operationId: 'queue-void',
      groupId: 'lake-house-weekend',
      settlementId: recorded.settlement.settlementId,
      expectedRevision: recorded.settlement.revision,
      expectedBalanceRevision: recorded.balanceSnapshot.balanceRevision,
      reason: 'Duplicate record',
    }
    const queue = new CommandQueue({
      originPrincipalKey: principalKey,
      storage: createMemoryCommandStorage(),
      handlers: { 'settlement.void': (envelope) => repository.settlements.void(envelope as typeof command) },
    })

    await expect(queue.submit(command).result()).resolves.toMatchObject({
      kind: 'settlement.void', operationId: command.operationId, status: 'saved',
      settlement: { settlementId: command.settlementId, revision: command.expectedRevision + 1 },
      balanceSnapshot: { balanceRevision: command.expectedBalanceRevision + 1 },
    })
  })

  it('registers record and void handlers in the principal-owned app session', async () => {
    const repository = createDemoRepository()
    const session = createAppSession({ repository, principal, commandStorage: createMemoryCommandStorage() })
    await session.ready
    const before = await repository.groups.getBalanceSnapshot('lake-house-weekend')
    const recorded = await session.queue.submit(recordCommand('session-record', before.balanceRevision, 500)).result()
    if (recorded.kind !== 'settlement.record' || recorded.status !== 'saved') throw new Error('Expected saved settlement')

    await expect(session.queue.submit({
      kind: 'settlement.void', operationId: 'session-void', groupId: 'lake-house-weekend', settlementId: recorded.settlement.settlementId,
      expectedRevision: recorded.settlement.revision, expectedBalanceRevision: recorded.balanceSnapshot.balanceRevision, reason: 'Wrong entry',
    }).result()).resolves.toMatchObject({ kind: 'settlement.void', status: 'saved' })
  })

  it('keeps Firebase settlement mutations explicitly unavailable until callable authority lands', async () => {
    const repository = createFirebaseRepository(firebaseConfiguration, 'maya-p')
    const record = recordCommand('firebase-record', 5, 500)

    await expect(repository.settlements.record(record)).resolves.toEqual({
      kind: 'settlement.record', operationId: record.operationId, status: 'not-supported',
      reason: 'Secure financial writes require the authenticated callable service configured in Task 11.',
    })
    await expect(repository.settlements.void({
      kind: 'settlement.void', operationId: 'firebase-void', groupId: 'lake-house-weekend', settlementId: 'settlement-a',
      expectedRevision: 1, expectedBalanceRevision: 5, reason: 'Wrong entry',
    })).resolves.toMatchObject({ kind: 'settlement.void', operationId: 'firebase-void', status: 'not-supported' })
  })
})

function recordCommand(operationId: string, expectedBalanceRevision: number, amountMinor: number): SettlementRecordCommand {
  return {
    kind: 'settlement.record', operationId, groupId: 'lake-house-weekend', expectedBalanceRevision,
    basis: { kind: 'simplified', senderId: 'taylor-s', recipientId: 'maya-p', currency: 'USD', debtMinor: 3625 },
    money: { currency: 'USD', minorAmount: amountMinor }, method: 'cash', occurredOn: '2026-08-31', note: 'Paid', outsidePaymentConfirmed: true,
  }
}

function createWebStorage(): Storage {
  const values = new Map<string, string>()
  return {
    get length() { return values.size },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key) },
    setItem: (key, value) => { values.set(key, value) },
  }
}
