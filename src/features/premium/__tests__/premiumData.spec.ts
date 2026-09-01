import { beforeEach, describe, expect, it } from 'vitest'
import { createMemoryCommandStorage } from '../../../data/commandQueue'
import { createDemoRepository } from '../../../data/demoRepository'
import { createAppSession, setAppSessionForTesting } from '../../../data/session'
import { loadGroupPremiumSnapshot, loadPremiumExportSnapshot } from '../premiumData'

beforeEach(() => setAppSessionForTesting(createAppSession({ repository: createDemoRepository(), commandStorage: createMemoryCommandStorage() })))

describe('premium export data', () => {
  it('loads the authorized audit trail needed for an auditable group backup', async () => {
    const snapshot = await loadPremiumExportSnapshot('lake-house-weekend')

    expect(snapshot.activity.length).toBeGreaterThan(0)
    expect(snapshot.comments.length).toBeGreaterThan(0)
    expect(snapshot.revisions.length).toBe(snapshot.expenses.length)
    expect(snapshot.recurring).toHaveLength(1)
    expect(snapshot.settings).toEqual([expect.objectContaining({ groupId: 'lake-house-weekend', revision: 1 })])
    expect(snapshot.coverage.status).toBe('complete')
  })

  it('uses the active group membership as the current user authority', async () => {
    const base = createDemoRepository()
    const profile = await base.app.getCurrentUser()
    const { canManage: _canManage, role: _role, ...profileWithoutGroupAuthority } = profile
    const repository = { ...base, app: { ...base.app, getCurrentUser: async () => profileWithoutGroupAuthority } }
    setAppSessionForTesting(createAppSession({ repository, commandStorage: createMemoryCommandStorage() }))

    const snapshot = await loadGroupPremiumSnapshot('lake-house-weekend')

    expect(snapshot.currentUser).toMatchObject({ id: profile.id, canManage: true, role: 'owner', isCurrentUser: true })
  })

  it('rejects a direct group export when the current principal is not an active member', async () => {
    const base = createDemoRepository()
    const repository = { ...base, groups: { ...base.groups, listMembers: async () => (await base.groups.listMembers('lake-house-weekend')).filter(({ isCurrentUser }) => !isCurrentUser) } }
    setAppSessionForTesting(createAppSession({ repository, commandStorage: createMemoryCommandStorage() }))

    await expect(loadPremiumExportSnapshot('lake-house-weekend')).rejects.toThrow('active member')
  })
})
