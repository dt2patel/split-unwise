import { describe, expect, it } from 'vitest'
import { assessGroupMemberRemoval } from '../groupMembership'
import type { Member } from '../../data/repositories'

const owner: Member = { id: 'owner', displayName: 'Owner', initials: 'O', isCurrentUser: true, canManage: true, role: 'owner' }
const member: Member = { id: 'member', displayName: 'Member', initials: 'M', isCurrentUser: false, canManage: false, role: 'member' }

describe('group member removal safeguards', () => {
  it('allows a manager to remove an uninvolved non-owner member', () => {
    expect(assessGroupMemberRemoval({ actor: owner, target: member })).toEqual({ canRemove: true })
  })

  it.each([
    [{ ...owner, canManage: false }, member, {}, /manager/i],
    [owner, { ...member, id: owner.id }, {}, /yourself/i],
    [owner, { ...member, role: 'owner' as const }, {}, /owner/i],
    [owner, member, { activeExpenseCount: 2 }, /2 expenses/i],
    [owner, member, { activeRecurringCount: 1 }, /recurring expense/i],
    [owner, member, { activeSettlementCount: 1 }, /payment/i],
    [owner, member, { balanceCount: 1 }, /balance/i],
  ])('blocks unsafe removal with a user-actionable reason', (actor, target, references, expected) => {
    const result = assessGroupMemberRemoval({ actor, target, ...references })
    expect(result.canRemove).toBe(false)
    if (!result.canRemove) expect(result.reason).toMatch(expected)
  })
})
