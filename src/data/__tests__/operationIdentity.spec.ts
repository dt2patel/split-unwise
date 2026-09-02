import { afterEach, describe, expect, it, vi } from 'vitest'
import { deriveMoveTargetOperationId } from '@split-unwise/shared'
import { OperationReplayConflictError, assertReplayIdentity, createOperationIdentity } from '../operationIdentity'
import type { ExpenseAddCommand } from '../repositories'

const command = (overrides: Partial<ExpenseAddCommand> = {}): ExpenseAddCommand => ({
  kind: 'expense.add', operationId: 'expense-add-01', groupId: 'lake-house-weekend', description: 'Firewood', date: '2026-08-30',
  total: { currency: 'USD', minorAmount: 2400 }, payments: [{ participantId: 'maya-p', money: { currency: 'USD', minorAmount: 2400 } }], category: 'Supplies',
  allocations: [{ participantId: 'maya-p', money: { currency: 'USD', minorAmount: 2400 } }],
  splitMethod: { type: 'exact', allocations: [{ participantId: 'maya-p', money: { currency: 'USD', minorAmount: 2400 } }] }, attachmentRefs: [],
  ...overrides,
})

describe('operation identity', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('derives a distinct bounded target identity for the second half of an expense move', () => {
    expect(deriveMoveTargetOperationId('move-expense')).toBe('move-expense.move-target')
    const bounded = deriveMoveTargetOperationId('a'.repeat(128))
    expect(bounded).toHaveLength(128)
    expect(bounded).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)
    expect(bounded).not.toBe('a'.repeat(128))
    expect(deriveMoveTargetOperationId(`${'a'.repeat(127)}b`)).not.toBe(deriveMoveTargetOperationId(`${'a'.repeat(127)}c`))
  })

  it('replays only an identical authenticated request and rejects changed payload or group', async () => {
    const stored = await createOperationIdentity('maya-p', command())
    await expect(assertReplayIdentity(stored, await createOperationIdentity('maya-p', command()))).resolves.toBeUndefined()
    await expect(assertReplayIdentity(stored, await createOperationIdentity('maya-p', command({ description: 'Changed' })))).rejects.toBeInstanceOf(OperationReplayConflictError)
    await expect(assertReplayIdentity(stored, await createOperationIdentity('maya-p', command({ groupId: 'other-group' })))).rejects.toBeInstanceOf(OperationReplayConflictError)
  })

  it('derives distinct resource IDs for different users and rejects unsafe operation IDs', async () => {
    await expect(createOperationIdentity('maya-p', command())).resolves.toMatchObject({ resourceId: expect.any(String) })
    const maya = await createOperationIdentity('maya-p', command())
    const jordan = await createOperationIdentity('jordan-k', command())
    expect(maya.resourceId).not.toBe(jordan.resourceId)
    await expect(createOperationIdentity('maya-p', command({ operationId: '../unsafe' }))).rejects.toThrow('operationId')
  })

  it('rejects a corrupt replay whose resource ID no longer binds uid and operation ID', async () => {
    const identity = await createOperationIdentity('maya-p', command())
    await expect(assertReplayIdentity({ ...identity, resourceId: 'operation-corrupt' }, identity)).rejects.toBeInstanceOf(OperationReplayConflictError)
  })

  it('preserves the SHA-256 identity when Web Crypto is unavailable on a plain HTTP mobile preview', async () => {
    const secureIdentity = await createOperationIdentity('maya-p', command())
    vi.stubGlobal('crypto', undefined)
    await expect(createOperationIdentity('maya-p', command())).resolves.toEqual(secureIdentity)
  })
})
