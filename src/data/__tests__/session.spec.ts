import { describe, expect, it } from 'vitest'
import { createDemoRepository } from '../demoRepository'
import { createMemoryCommandStorage } from '../commandQueue'
import { createAppSession, getAppSession, setAppSessionForTesting } from '../session'

describe('app data session', () => {
  it('shares one repository and queue across feature consumers', () => {
    setAppSessionForTesting(createAppSession({ commandStorage: createMemoryCommandStorage() }))
    const first = getAppSession()
    const second = getAppSession()
    expect(second.repository).toBe(first.repository)
    expect(second.queue).toBe(first.queue)
    setAppSessionForTesting(undefined)
  })

  it('provides deterministic repository and storage seams for tests', async () => {
    const repository = createDemoRepository()
    const session = createAppSession({ repository, commandStorage: createMemoryCommandStorage() })
    setAppSessionForTesting(session)

    const operation = getAppSession().queue.submit({
      kind: 'expense.add', operationId: 'session-add', groupId: 'lake-house-weekend', description: 'Ice', date: '2026-08-30',
      total: { currency: 'USD', minorAmount: 400 }, payments: [{ participantId: 'maya-p', money: { currency: 'USD', minorAmount: 400 } }],
      allocations: [
        { participantId: 'maya-p', money: { currency: 'USD', minorAmount: 100 } },
        { participantId: 'jordan-k', money: { currency: 'USD', minorAmount: 100 } },
        { participantId: 'alex-r', money: { currency: 'USD', minorAmount: 100 } },
        { participantId: 'taylor-s', money: { currency: 'USD', minorAmount: 100 } },
      ],
      category: 'Supplies', splitMethod: { type: 'equal', participantIds: ['maya-p', 'jordan-k', 'alex-r', 'taylor-s'] }, attachmentRefs: [],
    })

    await expect(operation.result()).resolves.toMatchObject({ status: 'saved', expense: { description: 'Ice' } })
    await expect(repository.expenses.listForGroup('lake-house-weekend')).resolves.toHaveLength(6)
    setAppSessionForTesting(undefined)
  })
})
