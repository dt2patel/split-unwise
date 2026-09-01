import { describe, expect, it } from 'vitest'
import type { Member } from '../../data/repositories'
import { clearInvalidDefaultSplit, decodeDefaultSplit, seedDefaultSplit, updateGroupSettings, type GroupSettings } from '../groupSettings'

const members: readonly Member[] = [
  { id: 'maya', displayName: 'Maya', initials: 'MP', isCurrentUser: true, canManage: true },
  { id: 'alex', displayName: 'Alex', initials: 'AR', isCurrentUser: false },
]
const initial: GroupSettings = { schemaVersion: 1, groupId: 'lake', revision: 1 }

describe('versioned shared split defaults', () => {
  it('requires active manager authority and the exact settings revision', () => {
    expect(() => updateGroupSettings(initial, { expectedRevision: 1, defaultSplit: { type: 'equal', participantIds: ['maya', 'alex'] } }, members, 'alex')).toThrow('manager')
    expect(() => updateGroupSettings(initial, { expectedRevision: 2, defaultSplit: { type: 'equal', participantIds: ['maya', 'alex'] } }, members, 'maya')).toThrow('changed')
    expect(updateGroupSettings(initial, { expectedRevision: 1, defaultSplit: { type: 'equal', participantIds: ['maya', 'alex'] } }, members, 'maya')).toEqual({ schemaVersion: 1, groupId: 'lake', revision: 2, defaultSplit: { type: 'equal', participantIds: ['maya', 'alex'] } })
  })

  it('accepts only equal, percentage, or shares with exact active-member keys', () => {
    expect(() => updateGroupSettings(initial, { expectedRevision: 1, defaultSplit: { type: 'exact', allocations: [] } }, members, 'maya')).toThrow('equal, percentage, or shares')
    expect(() => updateGroupSettings(initial, { expectedRevision: 1, defaultSplit: { type: 'percentage', participantIds: ['maya', 'alex'], percentages: { maya: 50 } } }, members, 'maya')).toThrow('key')
    expect(() => updateGroupSettings(initial, { expectedRevision: 1, defaultSplit: { type: 'shares', participantIds: ['maya', 'retired'], shares: { maya: 1, retired: 1 } } }, members, 'maya')).toThrow('active')
  })

  it('strictly decodes persisted defaults without extra fields, duplicate people, or invalid ratios', () => {
    expect(decodeDefaultSplit({ type: 'percentage', participantIds: ['maya', 'alex'], percentages: { maya: 60, alex: 40 } })).toEqual({ type: 'percentage', participantIds: ['maya', 'alex'], percentages: { maya: 60, alex: 40 } })
    expect(() => decodeDefaultSplit({ type: 'equal', participantIds: ['maya'], privateDraft: true })).toThrow('fields')
    expect(() => decodeDefaultSplit({ type: 'equal', participantIds: ['maya', 'maya'] })).toThrow('unique')
    expect(() => decodeDefaultSplit({ type: 'percentage', participantIds: ['maya'], percentages: { maya: 90, alex: 10 } })).toThrow('keys')
    expect(() => decodeDefaultSplit({ type: 'percentage', participantIds: ['maya'], percentages: { maya: 99 } })).toThrow('100')
  })

  it('clears the whole default when membership removal invalidates it', () => {
    const configured: GroupSettings = { schemaVersion: 1, groupId: 'lake', revision: 4, defaultSplit: { type: 'shares', participantIds: ['maya', 'alex'], shares: { maya: 1, alex: 2 } } }
    expect(clearInvalidDefaultSplit(configured, members)).toBe(configured)
    expect(clearInvalidDefaultSplit(configured, members.filter(({ id }) => id !== 'alex'))).toEqual({ schemaVersion: 1, groupId: 'lake', revision: 5 })
  })

  it('seeds only future drafts and never overwrites an itemized receipt split', () => {
    const configured: GroupSettings = { schemaVersion: 1, groupId: 'lake', revision: 2, defaultSplit: { type: 'equal', participantIds: ['maya', 'alex'] } }
    expect(seedDefaultSplit(configured)).toEqual(configured.defaultSplit)
    const itemized = { type: 'itemized' as const, items: [{ description: 'Coffee', money: { currency: 'USD' as const, minorAmount: 500 }, participantIds: ['maya'] }] }
    expect(seedDefaultSplit(configured, itemized)).toBe(itemized)
  })

  it('lets any active member toggle debt simplification while preserving the saved default split', () => {
    const configured: GroupSettings = {
      schemaVersion: 1, groupId: 'lake', revision: 4, simplifyDebtsEnabled: true,
      defaultSplit: { type: 'shares' as const, participantIds: ['maya', 'alex'], shares: { maya: 1, alex: 2 } },
    }

    expect(updateGroupSettings(configured, { expectedRevision: 4, simplifyDebtsEnabled: false }, members, 'alex')).toEqual({
      ...configured,
      revision: 5,
      simplifyDebtsEnabled: false,
    })
  })
})
