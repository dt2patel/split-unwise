import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { createRepository } from '../../data'
import type { ActivityItem, ExpenseRow, Group, Member } from '../../data'
import type { Money } from '../../domain/model'

const repository = createRepository()

export interface UserExpensePosition {
  readonly money: Money
  readonly direction: 'owed' | 'owing' | 'settled'
  readonly label: 'you lent' | 'you borrowed' | 'settled'
}

export const useGroupStore = defineStore('groups', () => {
  const groups = ref<readonly Group[]>([])
  const currentUser = ref<Member>()
  const activeGroup = ref<Group>()
  const members = ref<readonly Member[]>([])
  const expenses = ref<readonly ExpenseRow[]>([])
  const activity = ref<readonly ActivityItem[]>([])
  const isLoading = ref(false)
  const error = ref<string>()

  const memberNames = computed(() => new Map(members.value.map((member) => [member.id, member.displayName])))
  const journalExpenses = computed(() => [...expenses.value].sort(newestFirst))
  const recentActivity = computed(() => [...activity.value].sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id)))
  const currentUserNet = computed<Money>(() => {
    const currency = activeGroup.value?.currency ?? 'USD'
    const total = expenses.value.reduce((sum, expense) => {
      if (expense.total.currency !== currency || !currentUser.value) return sum
      return sum + signedPosition(expense, currentUser.value.id)
    }, 0)
    return { currency, minorAmount: total }
  })

  async function loadOverview(): Promise<void> {
    isLoading.value = true
    error.value = undefined
    try {
      const [loadedGroups, user] = await Promise.all([repository.groups.list(), repository.app.getCurrentUser()])
      groups.value = loadedGroups
      currentUser.value = user
    } catch (reason) {
      error.value = messageFor(reason)
    } finally {
      isLoading.value = false
    }
  }

  async function loadGroup(groupId: string): Promise<void> {
    isLoading.value = true
    error.value = undefined
    try {
      const [group, user, loadedMembers, loadedExpenses, loadedActivity] = await Promise.all([
        repository.groups.getById(groupId),
        repository.app.getCurrentUser(),
        repository.groups.listMembers(groupId),
        repository.expenses.listForGroup(groupId),
        repository.activity.listForGroup(groupId),
      ])
      if (!group) throw new Error('This group is not available.')
      activeGroup.value = group
      currentUser.value = user
      members.value = loadedMembers
      expenses.value = loadedExpenses
      activity.value = loadedActivity
    } catch (reason) {
      activeGroup.value = undefined
      members.value = []
      expenses.value = []
      activity.value = []
      error.value = messageFor(reason)
    } finally {
      isLoading.value = false
    }
  }

  function positionFor(expense: ExpenseRow): UserExpensePosition {
    const minorAmount = currentUser.value ? signedPosition(expense, currentUser.value.id) : 0
    if (minorAmount > 0) return { money: { currency: expense.total.currency, minorAmount }, direction: 'owed', label: 'you lent' }
    if (minorAmount < 0) return { money: { currency: expense.total.currency, minorAmount: Math.abs(minorAmount) }, direction: 'owing', label: 'you borrowed' }
    return { money: { currency: expense.total.currency, minorAmount: 0 }, direction: 'settled', label: 'settled' }
  }

  function payerName(expense: ExpenseRow): string {
    return memberNames.value.get(expense.payerId) ?? 'Unknown member'
  }

  return {
    groups,
    currentUser,
    activeGroup,
    members,
    journalExpenses,
    recentActivity,
    currentUserNet,
    isLoading,
    error,
    loadOverview,
    loadGroup,
    positionFor,
    payerName,
  }
})

function signedPosition(expense: ExpenseRow, participantId: string): number {
  const share = expense.allocations.find((allocation) => allocation.participantId === participantId)?.money.minorAmount ?? 0
  return (expense.payerId === participantId ? expense.total.minorAmount : 0) - share
}

function newestFirst(left: ExpenseRow, right: ExpenseRow): number {
  return right.date.localeCompare(left.date) || right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id)
}

function messageFor(reason: unknown): string {
  return reason instanceof Error ? reason.message : 'The group could not be loaded.'
}
