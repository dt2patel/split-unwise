import type { Member } from '../data/repositories'

export interface GroupMemberRemovalAssessmentInput {
  readonly actor: Member
  readonly target: Member
  readonly activeExpenseCount?: number
  readonly activeRecurringCount?: number
  readonly activeSettlementCount?: number
  readonly balanceCount?: number
}

export type GroupMemberRemovalAssessment =
  | { readonly canRemove: true }
  | { readonly canRemove: false; readonly reason: string }

/** Returns the first user-actionable blocker for a destructive membership change. */
export function assessGroupMemberRemoval(input: GroupMemberRemovalAssessmentInput): GroupMemberRemovalAssessment {
  if (input.actor.canManage !== true) return blocked('Only an active group manager can remove people.')
  if (input.actor.id === input.target.id) return blocked('You cannot remove yourself from group settings.')
  if (input.target.role === 'owner') return blocked('The group owner cannot be removed.')
  if ((input.activeExpenseCount ?? 0) > 0) return blocked(counted(input.activeExpenseCount!, 'expense', 'expenses', 'Remove this person from'))
  if ((input.activeRecurringCount ?? 0) > 0) return blocked(counted(input.activeRecurringCount!, 'recurring expense', 'recurring expenses', 'Remove this person from'))
  if ((input.activeSettlementCount ?? 0) > 0) return blocked(counted(input.activeSettlementCount!, 'payment', 'payments', 'Void or remove'))
  if ((input.balanceCount ?? 0) > 0) return blocked('Settle this person’s balance before removing them.')
  return { canRemove: true }
}

function blocked(reason: string): GroupMemberRemovalAssessment { return { canRemove: false, reason } }
function counted(count: number, singular: string, plural: string, prefix: string): string {
  return `${prefix} ${count} ${count === 1 ? singular : plural} first.`
}
