import { describe, expect, it } from 'vitest'
import type { Group, GroupBalanceSnapshot, Member } from '../../data/repositories'
import { projectAccountBalances, type AccountBalanceContext } from '../accountBalances'

const maya: Member = { id: 'maya', displayName: 'Maya', initials: 'MP', isCurrentUser: true }
const alex: Member = { id: 'alex', displayName: 'Alex', initials: 'AR', isCurrentUser: false }
const jordan: Member = { id: 'jordan', displayName: 'Jordan', initials: 'JK', isCurrentUser: false }

function group(id: string, name: string, currency: Group['currency'] = 'USD', kind: Group['kind'] = 'group'): Group {
  return { id, name, currency, kind, memberIds: ['maya', 'alex', 'jordan'], syncState: 'fresh' }
}

function context(
  value: Group,
  pairwise: GroupBalanceSnapshot['pairwise'],
  simplified: GroupBalanceSnapshot['simplified'] = pairwise,
  simplifyDebtsEnabled = false,
  members: readonly Member[] = [maya, alex, jordan],
): AccountBalanceContext {
  return {
    group: value,
    members,
    snapshot: { groupId: value.id, balanceRevision: 1, simplifyDebtsEnabled, pairwise, simplified },
  }
}

describe('account balance projection', () => {
  it('uses the saved debt plan and independently reports gross owed, owing, and net totals', () => {
    const trip = group('trip', 'Trip')
    const projection = projectAccountBalances('maya', [context(
      trip,
      [
        { fromParticipantId: 'alex', toParticipantId: 'maya', money: { currency: 'USD', minorAmount: 5000 } },
        { fromParticipantId: 'maya', toParticipantId: 'jordan', money: { currency: 'USD', minorAmount: 2100 } },
      ],
      [{ fromParticipantId: 'alex', toParticipantId: 'maya', money: { currency: 'USD', minorAmount: 2900 } }],
      true,
    )])

    expect(projection.currencies).toEqual([{
      currency: 'USD',
      netMinor: 2900,
      owedToUserMinor: 2900,
      userOwesMinor: 0,
    }])
    expect(projection.groups).toEqual([{
      groupId: 'trip',
      groupName: 'Trip',
      kind: 'group',
      positions: [{ currency: 'USD', minorAmount: 2900 }],
    }])
    expect(projection.friends.map(({ id, positions }) => ({ id, positions }))).toEqual([
      { id: 'alex', positions: [{ currency: 'USD', minorAmount: 2900 }] },
      { id: 'jordan', positions: [{ currency: 'USD', minorAmount: 0 }] },
    ])
  })

  it('aggregates one friend across direct and shared contexts without netting unlike currencies', () => {
    const household = { ...group('house', 'House'), memberIds: ['maya', 'alex'] }
    const direct = { ...group('direct-alex', 'Alex', 'EUR', 'friendship'), memberIds: ['maya', 'alex'] }
    const projection = projectAccountBalances('maya', [
      context(household, [
        { fromParticipantId: 'alex', toParticipantId: 'maya', money: { currency: 'USD', minorAmount: 4200 } },
      ], undefined, false, [maya, alex]),
      context(direct, [
        { fromParticipantId: 'maya', toParticipantId: 'alex', money: { currency: 'EUR', minorAmount: 900 } },
      ], undefined, false, [maya, alex]),
    ])

    expect(projection.friends).toEqual([
      expect.objectContaining({
        id: 'alex',
        displayName: 'Alex',
        directContextId: 'direct-alex',
        pending: false,
        positions: [
          { currency: 'EUR', minorAmount: -900 },
          { currency: 'USD', minorAmount: 4200 },
        ],
        breakdowns: [
          { contextId: 'direct-alex', contextName: 'Alex', contextKind: 'friendship', currency: 'EUR', minorAmount: -900 },
          { contextId: 'house', contextName: 'House', contextKind: 'group', currency: 'USD', minorAmount: 4200 },
        ],
      }),
    ])
    expect(projection.currencies).toEqual([
      { currency: 'EUR', netMinor: -900, owedToUserMinor: 0, userOwesMinor: 900 },
      { currency: 'USD', netMinor: 4200, owedToUserMinor: 4200, userOwesMinor: 0 },
    ])
  })

  it('keeps pending direct invitations visible and settled until the second member joins', () => {
    const pending = { ...group('pending-alex', 'Alex Rivera', 'USD', 'friendship'), memberIds: ['maya'] }
    const projection = projectAccountBalances('maya', [context(pending, [], [], false, [maya])])

    expect(projection.friends).toEqual([{
      id: 'pending:pending-alex',
      displayName: 'Alex Rivera',
      initials: 'AR',
      pending: true,
      directContextId: 'pending-alex',
      positions: [{ currency: 'USD', minorAmount: 0 }],
      breakdowns: [{ contextId: 'pending-alex', contextName: 'Alex Rivera', contextKind: 'friendship', currency: 'USD', minorAmount: 0 }],
    }])
  })

  it('rejects a mismatched or overflowing snapshot instead of showing plausible balances', () => {
    const trip = group('trip', 'Trip')
    expect(() => projectAccountBalances('maya', [{
      group: trip,
      members: [maya, alex],
      snapshot: { groupId: 'other', balanceRevision: 1, simplifyDebtsEnabled: false, pairwise: [], simplified: [] },
    }])).toThrow('does not match')

    expect(() => projectAccountBalances('maya', [
      context(trip, [{ fromParticipantId: 'alex', toParticipantId: 'maya', money: { currency: 'USD', minorAmount: Number.MAX_SAFE_INTEGER } }]),
      context(group('trip-two', 'Trip two'), [{ fromParticipantId: 'alex', toParticipantId: 'maya', money: { currency: 'USD', minorAmount: 1 } }]),
    ])).toThrow('safe integer')
  })
})
