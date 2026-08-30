import type { ActivityItem, ExpenseComment, ExpenseRow, Group, Member, RecurringExpense } from '../data/repositories'

export const LAKE_HOUSE_GROUP_ID = 'lake-house-weekend'

export const lakeHouseCurrentUser: Member = {
  id: 'maya-p',
  displayName: 'Maya P.',
  initials: 'MP',
  isCurrentUser: true,
}

export const lakeHouseMembers: readonly Member[] = [
  lakeHouseCurrentUser,
  { id: 'jordan-k', displayName: 'Jordan K.', initials: 'JK', isCurrentUser: false },
  { id: 'alex-r', displayName: 'Alex R.', initials: 'AR', isCurrentUser: false },
  { id: 'taylor-s', displayName: 'Taylor S.', initials: 'TS', isCurrentUser: false },
]

export const lakeHouseGroup: Group = {
  id: LAKE_HOUSE_GROUP_ID,
  name: 'Lake House Weekend',
  currency: 'USD',
  coverImageUrl: '/assets/images/lake-house-cover.png',
  memberIds: lakeHouseMembers.map(({ id }) => id),
  syncState: 'fresh',
}

const equalAllocations = (minorAmount: number) => lakeHouseMembers.map((member) => ({
  participantId: member.id,
  money: { currency: 'USD' as const, minorAmount },
}))
const equalSplit = { type: 'equal' as const, participantIds: lakeHouseMembers.map(({ id }) => id) }

export const lakeHouseExpenses: readonly ExpenseRow[] = [
  {
    id: 'gas-for-the-boat', groupId: LAKE_HOUSE_GROUP_ID, description: 'Gas for the boat', date: '2026-08-26',
    total: { currency: 'USD', minorAmount: 5600 }, payments: [{ participantId: 'maya-p', money: { currency: 'USD', minorAmount: 5600 } }], allocations: equalAllocations(1400),
    category: 'Transport', createdAt: '2026-08-26T16:00:00.000Z', updatedAt: '2026-08-26T16:00:00.000Z', revision: 1, syncState: 'fresh', splitMethod: equalSplit, attachmentRefs: [],
  },
  {
    id: 'dinner', groupId: LAKE_HOUSE_GROUP_ID, description: 'Dinner', date: '2026-08-27',
    total: { currency: 'USD', minorAmount: 7300 }, payments: [{ participantId: 'taylor-s', money: { currency: 'USD', minorAmount: 7300 } }], allocations: equalAllocations(1825),
    category: 'Food', createdAt: '2026-08-27T19:00:00.000Z', updatedAt: '2026-08-27T19:00:00.000Z', revision: 1, syncState: 'fresh', splitMethod: equalSplit, attachmentRefs: [],
  },
  {
    id: 'cabin-deposit', groupId: LAKE_HOUSE_GROUP_ID, description: 'Cabin deposit', date: '2026-08-28',
    total: { currency: 'USD', minorAmount: 40000 }, payments: [{ participantId: 'alex-r', money: { currency: 'USD', minorAmount: 40000 } }], allocations: equalAllocations(10000),
    category: 'Lodging', createdAt: '2026-08-28T15:00:00.000Z', updatedAt: '2026-08-28T15:00:00.000Z', revision: 1, syncState: 'fresh', splitMethod: equalSplit, attachmentRefs: [], recurringTemplateId: 'cabin-deposit-monthly',
  },
  {
    id: 'kayak-rental', groupId: LAKE_HOUSE_GROUP_ID, description: 'Kayak rental', date: '2026-08-29',
    total: { currency: 'USD', minorAmount: 6000 }, payments: [{ participantId: 'jordan-k', money: { currency: 'USD', minorAmount: 6000 } }], allocations: equalAllocations(1500),
    category: 'Transport', createdAt: '2026-08-29T11:00:00.000Z', updatedAt: '2026-08-29T11:00:00.000Z', revision: 1, syncState: 'fresh', splitMethod: equalSplit, attachmentRefs: [],
  },
  {
    id: 'groceries', groupId: LAKE_HOUSE_GROUP_ID, description: 'Groceries', date: '2026-08-30',
    total: { currency: 'USD', minorAmount: 17000 }, payments: [{ participantId: 'maya-p', money: { currency: 'USD', minorAmount: 17000 } }], allocations: equalAllocations(4250),
    category: 'Food', createdAt: '2026-08-30T10:00:00.000Z', updatedAt: '2026-08-30T10:00:00.000Z', revision: 1, syncState: 'fresh', splitMethod: equalSplit, attachmentRefs: [],
  },
]

export const lakeHouseComments: readonly ExpenseComment[] = [
  { id: 'comment-cabin-1', expenseId: 'cabin-deposit', authorId: 'alex-r', body: 'Booked the refundable rate for us.', createdAt: '2026-08-28T15:02:00.000Z', syncState: 'fresh' },
  { id: 'comment-cabin-2', expenseId: 'cabin-deposit', authorId: 'maya-p', body: 'Perfect, thank you!', createdAt: '2026-08-28T15:04:00.000Z', syncState: 'fresh' },
]

export const lakeHouseActivity: readonly ActivityItem[] = [
  { id: 'activity-gas', groupId: LAKE_HOUSE_GROUP_ID, expenseId: 'gas-for-the-boat', actorId: 'maya-p', type: 'expense-created', summary: 'Maya P. added Gas for the boat', createdAt: '2026-08-26T16:00:00.000Z', syncState: 'fresh' },
  { id: 'activity-dinner', groupId: LAKE_HOUSE_GROUP_ID, expenseId: 'dinner', actorId: 'taylor-s', type: 'expense-created', summary: 'Taylor S. added Dinner', createdAt: '2026-08-27T19:00:00.000Z', syncState: 'fresh' },
  { id: 'activity-cabin', groupId: LAKE_HOUSE_GROUP_ID, expenseId: 'cabin-deposit', actorId: 'alex-r', type: 'expense-created', summary: 'Alex R. added Cabin deposit', createdAt: '2026-08-28T15:00:00.000Z', syncState: 'fresh' },
  { id: 'activity-cabin-comment', groupId: LAKE_HOUSE_GROUP_ID, expenseId: 'cabin-deposit', actorId: 'maya-p', type: 'comment-added', summary: 'Maya P. commented on Cabin deposit', createdAt: '2026-08-28T15:04:00.000Z', syncState: 'fresh' },
  { id: 'activity-kayak', groupId: LAKE_HOUSE_GROUP_ID, expenseId: 'kayak-rental', actorId: 'jordan-k', type: 'expense-created', summary: 'Jordan K. added Kayak rental', createdAt: '2026-08-29T11:00:00.000Z', syncState: 'fresh' },
  { id: 'activity-groceries', groupId: LAKE_HOUSE_GROUP_ID, expenseId: 'groceries', actorId: 'maya-p', type: 'expense-created', summary: 'Maya P. added Groceries', createdAt: '2026-08-30T10:00:00.000Z', syncState: 'fresh' },
]

export const lakeHouseRecurring: readonly RecurringExpense[] = [
  {
    id: 'cabin-deposit-monthly', groupId: LAKE_HOUSE_GROUP_ID, description: 'Cabin deposit', total: { currency: 'USD', minorAmount: 40000 }, payments: [{ participantId: 'alex-r', money: { currency: 'USD', minorAmount: 40000 } }],
    recurrence: { frequency: 'monthly', anchor: { month: 8, day: 28 }, timeZone: 'America/Chicago' }, nextDate: '2026-09-28', syncState: 'fresh',
  },
]
