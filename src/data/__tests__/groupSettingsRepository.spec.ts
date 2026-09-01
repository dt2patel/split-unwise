import { describe, expect, it } from 'vitest'
import { createDemoRepository } from '../demoRepository'
import { CommandConflictError } from '../commandQueue'

const groupId = 'lake-house-weekend'
const equal = { type: 'equal' as const, participantIds: ['maya-p', 'jordan-k', 'alex-r', 'taylor-s'] }

describe('demo group settings repository', () => {
  it('persists an authorized expected-revision default exactly once', async () => {
    let persisted: unknown
    const storage = { load: () => persisted, save: (_scope: string, document: unknown) => { persisted = structuredClone(document) } }
    const repository = createDemoRepository({ stateStorage: storage })
    await expect(repository.groups.getSettings(groupId)).resolves.toEqual({ schemaVersion: 1, groupId, revision: 1 })
    const command = { kind: 'group.default-split' as const, operationId: 'save-default', groupId, expectedRevision: 1, defaultSplit: equal }

    const first = await repository.groups.setDefaultSplit(command)
    const replay = await repository.groups.setDefaultSplit(command)

    expect(replay).toEqual(first)
    await expect(repository.groups.getSettings(groupId)).resolves.toEqual({ schemaVersion: 1, groupId, revision: 2, defaultSplit: equal })
    await expect(repository.activity.listForGroup(groupId)).resolves.toContainEqual(expect.objectContaining({ kind: 'group.event', operationId: 'save-default' }))
    await expect(createDemoRepository({ stateStorage: storage }).groups.getSettings(groupId)).resolves.toEqual({ schemaVersion: 1, groupId, revision: 2, defaultSplit: equal })
  })

  it('rejects stale settings revisions and non-manager writes', async () => {
    const repository = createDemoRepository()
    await repository.groups.setDefaultSplit({ kind: 'group.default-split', operationId: 'first-default', groupId, expectedRevision: 1, defaultSplit: equal })
    await expect(repository.groups.setDefaultSplit({ kind: 'group.default-split', operationId: 'stale-default', groupId, expectedRevision: 1, defaultSplit: equal })).rejects.toBeInstanceOf(CommandConflictError)
    await expect(createDemoRepository({ currentUserId: 'alex-r' }).groups.setDefaultSplit({ kind: 'group.default-split', operationId: 'unauthorized-default', groupId, expectedRevision: 1, defaultSplit: equal })).rejects.toThrow('manager')
  })

  it('supports an explicit versioned clear without mutating past expenses', async () => {
    const repository = createDemoRepository()
    const before = await repository.expenses.listForGroup(groupId)
    await repository.groups.setDefaultSplit({ kind: 'group.default-split', operationId: 'set-before-clear', groupId, expectedRevision: 1, defaultSplit: equal })
    await repository.groups.setDefaultSplit({ kind: 'group.default-split', operationId: 'clear-default', groupId, expectedRevision: 2, defaultSplit: null })
    await expect(repository.groups.getSettings(groupId)).resolves.toEqual({ schemaVersion: 1, groupId, revision: 3 })
    await expect(repository.expenses.listForGroup(groupId)).resolves.toEqual(before)
  })

  it('persists an active member debt-simplification choice and invalidates stale balance plans', async () => {
    const repository = createDemoRepository({ currentUserId: 'alex-r' })
    const before = await repository.groups.getBalanceSnapshot(groupId)

    await repository.commands.execute({
      kind: 'group.simplify-debts', operationId: 'disable-simplification', groupId,
      expectedRevision: 1, simplifyDebtsEnabled: false,
    })

    await expect(repository.groups.getSettings(groupId)).resolves.toMatchObject({ revision: 2, simplifyDebtsEnabled: false })
    await expect(repository.groups.getBalanceSnapshot(groupId)).resolves.toMatchObject({
      balanceRevision: before.balanceRevision + 1,
      simplifyDebtsEnabled: false,
    })
    await expect(repository.activity.listForGroup(groupId)).resolves.toContainEqual(expect.objectContaining({
      kind: 'group.event', operationId: 'disable-simplification', subject: expect.objectContaining({ label: 'Simplify debts disabled' }),
    }))
  })

  it('quarantines a persisted debt-simplification value that is not a boolean', async () => {
    let persisted: unknown
    const writer = createDemoRepository({
      currentUserId: 'alex-r',
      stateStorage: { load: () => persisted, save: (_scope: string, document: unknown) => { persisted = structuredClone(document) } },
    })
    await writer.groups.setSimplifyDebts({
      kind: 'group.simplify-debts', operationId: 'persist-valid-toggle', groupId, expectedRevision: 1, simplifyDebtsEnabled: false,
    })
    const malformed = structuredClone(persisted) as { groupSettings: { simplifyDebtsEnabled: unknown } }
    malformed.groupSettings.simplifyDebtsEnabled = 'false'
    const quarantined: unknown[] = []
    const restored = createDemoRepository({
      currentUserId: 'alex-r',
      stateStorage: {
        load: () => malformed,
        save: () => undefined,
        quarantine: (_scope: string, records: readonly unknown[]) => { quarantined.push(...records) },
      },
    })

    await expect(restored.groups.getSettings(groupId)).resolves.toEqual({ schemaVersion: 1, groupId, revision: 1 })
    expect(quarantined).toEqual([malformed])
  })

  it('applies one replay-safe manager conversion to every existing expense projection and balance', async () => {
    let persisted: unknown
    const stateStorage = { load: () => persisted, save: (_scope: string, document: unknown) => { persisted = structuredClone(document) } }
    const repository = createDemoRepository({ now: () => '2026-09-01T12:00:00.000Z', stateStorage })
    const before = await repository.expenses.listForGroup(groupId)
    const command = {
      kind: 'group.currency-conversion' as const, operationId: 'convert-demo-usd-eur', groupId, expectedRevision: 1, targetCurrency: 'EUR' as const,
      rates: [{ baseCurrency: 'USD' as const, quoteCurrency: 'EUR' as const, numerator: 1, denominator: 2, authority: 'ECB', effectiveDate: '2026-08-29', observedAt: '2026-09-01T11:59:00.000Z' }],
    }

    const first = await repository.groups.convertCurrencies(command)
    const replay = await repository.groups.convertCurrencies(command)
    const after = await repository.expenses.listForGroup(groupId)

    expect(replay).toEqual(first)
    expect(after).toHaveLength(before.length)
    expect(after.every(({ total }) => total.currency === 'EUR')).toBe(true)
    expect(after[0]?.currencyConversion).toMatchObject({ operationId: command.operationId, sourceMoney: before[0]?.total, targetCurrency: 'EUR' })
    await expect(repository.groups.getBalanceSnapshot(groupId)).resolves.toMatchObject({ pairwise: expect.arrayContaining([expect.objectContaining({ money: expect.objectContaining({ currency: 'EUR' }) })]) })
    await expect(repository.activity.listForGroup(groupId)).resolves.toContainEqual(expect.objectContaining({
      kind: 'group.event', operationId: command.operationId, subject: expect.objectContaining({ label: 'Currencies converted to EUR' }),
    }))
    const restored = createDemoRepository({ now: () => '2026-09-01T12:00:00.000Z', stateStorage })
    await expect(restored.groups.getSettings(groupId)).resolves.toMatchObject({ revision: 2, currencyConversion: { operationId: command.operationId, targetCurrency: 'EUR' } })
    expect((await restored.expenses.listForGroup(groupId)).every(({ total }) => total.currency === 'EUR')).toBe(true)
  })

  it('rejects a group conversion from a non-manager without changing the ledger', async () => {
    const repository = createDemoRepository({ currentUserId: 'alex-r', now: () => '2026-09-01T12:00:00.000Z' })
    const before = await repository.expenses.listForGroup(groupId)
    await expect(repository.groups.convertCurrencies({
      kind: 'group.currency-conversion', operationId: 'convert-without-authority', groupId, expectedRevision: 1, targetCurrency: 'EUR',
      rates: [{ baseCurrency: 'USD', quoteCurrency: 'EUR', numerator: 1, denominator: 2, authority: 'ECB', effectiveDate: '2026-08-29', observedAt: '2026-09-01T11:59:00.000Z' }],
    })).rejects.toThrow('manager')
    await expect(repository.expenses.listForGroup(groupId)).resolves.toEqual(before)
  })
})
