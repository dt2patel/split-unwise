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
})
