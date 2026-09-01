import { describe, expect, it } from 'vitest'
import type { Group } from '../../data/repositories'
import { friendshipContexts, groupContexts } from '../expenseContexts'

const contexts: readonly Group[] = [
  { id: 'trip', kind: 'group', name: 'Chicago weekend', currency: 'USD', memberIds: ['maya', 'alex'], syncState: 'fresh' },
  { id: 'friend', kind: 'friendship', name: 'Jordan', currency: 'USD', memberIds: ['maya'], syncState: 'pending' },
  { id: 'home', kind: 'group', name: 'Apartment', currency: 'USD', memberIds: ['maya', 'sam'], syncState: 'fresh' },
]

describe('expense context selectors', () => {
  it('separates groups from friendships without changing source order', () => {
    expect(groupContexts(contexts).map(({ id }) => id)).toEqual(['trip', 'home'])
    expect(friendshipContexts(contexts).map(({ id }) => id)).toEqual(['friend'])
    expect(contexts.map(({ id }) => id)).toEqual(['trip', 'friend', 'home'])
  })
})
