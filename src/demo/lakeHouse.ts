import type { ActivityItem, ActorSnapshot, ExpenseComment, ExpenseRow, Group, Member, NotificationItem, RecurringExpense } from '../data/repositories'
import lakeHouseCoverUrl from '../assets/lake-house-cover.jpg'

export const LAKE_HOUSE_GROUP_ID = 'lake-house-weekend'

export const lakeHouseCurrentUser: Member = {
  id: 'maya-p',
  displayName: 'Maya P.',
  initials: 'MP',
  isCurrentUser: true,
  canManage: true,
}

export const lakeHouseMembers: readonly Member[] = [
  lakeHouseCurrentUser,
  { id: 'jordan-k', displayName: 'Jordan K.', initials: 'JK', isCurrentUser: false, canManage: false },
  { id: 'alex-r', displayName: 'Alex R.', initials: 'AR', isCurrentUser: false, canManage: false },
  { id: 'taylor-s', displayName: 'Taylor S.', initials: 'TS', isCurrentUser: false, canManage: false },
]

const actor = (id: string, displayName: string): ActorSnapshot => ({ id, displayName })
const maya = actor('maya-p', 'Maya P.')
const jordan = actor('jordan-k', 'Jordan K.')
const alex = actor('alex-r', 'Alex R.')
const taylor = actor('taylor-s', 'Taylor S.')

export const lakeHouseGroup: Group = {
  id: LAKE_HOUSE_GROUP_ID,
  name: 'Lake House Weekend',
  currency: 'USD',
  coverImageUrl: lakeHouseCoverUrl,
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
    category: 'Transport', createdAt: '2026-08-26T16:00:00.000Z', updatedAt: '2026-08-26T16:00:00.000Z', revision: 1, syncState: 'fresh', splitMethod: equalSplit, attachmentRefs: [], createdBy: maya, updatedBy: maya,
  },
  {
    id: 'dinner', groupId: LAKE_HOUSE_GROUP_ID, description: 'Dinner', date: '2026-08-27',
    total: { currency: 'USD', minorAmount: 7300 }, payments: [{ participantId: 'taylor-s', money: { currency: 'USD', minorAmount: 7300 } }], allocations: equalAllocations(1825),
    category: 'Food', createdAt: '2026-08-27T19:00:00.000Z', updatedAt: '2026-08-27T19:00:00.000Z', revision: 1, syncState: 'fresh', splitMethod: equalSplit, attachmentRefs: [], createdBy: taylor, updatedBy: taylor,
  },
  {
    id: 'cabin-deposit', groupId: LAKE_HOUSE_GROUP_ID, description: 'Cabin deposit', date: '2026-08-28',
    total: { currency: 'USD', minorAmount: 40000 }, payments: [{ participantId: 'alex-r', money: { currency: 'USD', minorAmount: 40000 } }], allocations: equalAllocations(10000),
    category: 'Lodging', createdAt: '2026-08-28T15:00:00.000Z', updatedAt: '2026-08-28T15:00:00.000Z', revision: 1, syncState: 'fresh', splitMethod: equalSplit, attachmentRefs: [], recurringTemplateId: 'cabin-deposit-monthly', createdBy: alex, updatedBy: alex,
  },
  {
    id: 'kayak-rental', groupId: LAKE_HOUSE_GROUP_ID, description: 'Kayak rental', date: '2026-08-29',
    total: { currency: 'USD', minorAmount: 6000 }, payments: [{ participantId: 'jordan-k', money: { currency: 'USD', minorAmount: 6000 } }], allocations: equalAllocations(1500),
    category: 'Transport', createdAt: '2026-08-29T11:00:00.000Z', updatedAt: '2026-08-29T11:00:00.000Z', revision: 1, syncState: 'fresh', splitMethod: equalSplit, attachmentRefs: [], createdBy: jordan, updatedBy: jordan,
  },
  {
    id: 'groceries', groupId: LAKE_HOUSE_GROUP_ID, description: 'Groceries', date: '2026-08-30',
    total: { currency: 'USD', minorAmount: 17000 }, payments: [{ participantId: 'maya-p', money: { currency: 'USD', minorAmount: 17000 } }], allocations: equalAllocations(4250),
    category: 'Food', createdAt: '2026-08-30T10:00:00.000Z', updatedAt: '2026-08-30T10:00:00.000Z', revision: 1, syncState: 'fresh', splitMethod: equalSplit, attachmentRefs: [], createdBy: maya, updatedBy: maya,
  },
]

export const lakeHouseComments: readonly ExpenseComment[] = [
  { commentId: 'comment-cabin-1', groupId: LAKE_HOUSE_GROUP_ID, expenseId: 'cabin-deposit', operationId: 'seed-comment-cabin-1', author: alex, body: 'Booked the refundable rate for us.', attachmentRefs: [], createdAt: '2026-08-28T15:02:00.000Z', syncState: 'fresh' },
  { commentId: 'comment-cabin-2', groupId: LAKE_HOUSE_GROUP_ID, expenseId: 'cabin-deposit', operationId: 'seed-comment-cabin-2', author: maya, body: 'Perfect, thank you!', attachmentRefs: [], createdAt: '2026-08-28T15:04:00.000Z', syncState: 'fresh' },
]

export const lakeHouseActivity: readonly ActivityItem[] = [
  expenseActivity('activity-gas', 'seed-expense-gas', 'gas-for-the-boat', 'Gas for the boat', maya, '2026-08-26T16:00:00.000Z'),
  expenseActivity('activity-dinner', 'seed-expense-dinner', 'dinner', 'Dinner', taylor, '2026-08-27T19:00:00.000Z'),
  expenseActivity('activity-cabin', 'seed-expense-cabin', 'cabin-deposit', 'Cabin deposit', alex, '2026-08-28T15:00:00.000Z'),
  { id: 'activity-cabin-comment', groupId: LAKE_HOUSE_GROUP_ID, operationId: 'seed-comment-cabin-2', kind: 'comment.added', subject: { kind: 'comment', id: 'comment-cabin-2', label: 'Perfect, thank you!' }, actor: maya, expenseId: 'cabin-deposit', commentId: 'comment-cabin-2', createdAt: '2026-08-28T15:04:00.000Z', syncState: 'fresh' },
  expenseActivity('activity-kayak', 'seed-expense-kayak', 'kayak-rental', 'Kayak rental', jordan, '2026-08-29T11:00:00.000Z'),
  expenseActivity('activity-groceries', 'seed-expense-groceries', 'groceries', 'Groceries', maya, '2026-08-30T10:00:00.000Z'),
]

export const lakeHouseNotifications: readonly NotificationItem[] = [
  { notificationId: 'notification-a', principalId: 'maya-p', groupId: LAKE_HOUSE_GROUP_ID, activityId: 'activity-cabin', kind: 'expense.created', subject: { kind: 'expense', id: 'cabin-deposit', label: 'Cabin deposit' }, actor: alex, createdAt: '2026-08-30T10:30:00.000Z', syncState: 'fresh' },
  { notificationId: 'notification-b', principalId: 'maya-p', groupId: LAKE_HOUSE_GROUP_ID, activityId: 'activity-kayak', kind: 'expense.created', subject: { kind: 'expense', id: 'kayak-rental', label: 'Kayak rental' }, actor: jordan, createdAt: '2026-08-30T11:00:00.000Z', syncState: 'fresh' },
  { notificationId: 'notification-c', principalId: 'maya-p', groupId: LAKE_HOUSE_GROUP_ID, activityId: 'activity-dinner', kind: 'expense.created', subject: { kind: 'expense', id: 'dinner', label: 'Dinner' }, actor: taylor, createdAt: '2026-08-30T11:00:00.000Z', syncState: 'fresh' },
]

function expenseActivity(id: string, operationId: string, expenseId: string, label: string, eventActor: ActorSnapshot, createdAt: string): ActivityItem {
  return { id, groupId: LAKE_HOUSE_GROUP_ID, operationId, kind: 'expense.created', subject: { kind: 'expense', id: expenseId, label }, actor: eventActor, expenseId, revision: 1, createdAt, syncState: 'fresh' }
}

export const lakeHouseRecurring: readonly RecurringExpense[] = [
  {
    id: 'cabin-deposit-monthly', groupId: LAKE_HOUSE_GROUP_ID, description: 'Cabin deposit', total: { currency: 'USD', minorAmount: 40000 }, payments: [{ participantId: 'alex-r', money: { currency: 'USD', minorAmount: 40000 } }],
    recurrence: { frequency: 'monthly', anchor: { month: 8, day: 28 }, timeZone: 'America/Chicago' }, nextDate: '2026-09-28', syncState: 'fresh',
  },
]
