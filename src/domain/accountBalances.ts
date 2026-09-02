import type { Group, GroupBalanceSnapshot, Member } from '../data/repositories'
import { compareFirestoreStrings } from '../data/timeline'
import type { CurrencyCode } from './money'
import type { ParticipantId } from './model'

export interface AccountBalanceContext {
  readonly group: Group
  readonly members: readonly Member[]
  readonly snapshot: GroupBalanceSnapshot
}

export interface SignedCurrencyPosition {
  readonly currency: CurrencyCode
  /** Positive means the signed-in user is owed; negative means the user owes. */
  readonly minorAmount: number
}

export interface AccountCurrencyBalance {
  readonly currency: CurrencyCode
  readonly netMinor: number
  readonly owedToUserMinor: number
  readonly userOwesMinor: number
}

export interface AccountGroupBalance {
  readonly groupId: string
  readonly groupName: string
  readonly kind: Group['kind']
  readonly positions: readonly SignedCurrencyPosition[]
}

export interface FriendBalanceBreakdown {
  readonly contextId: string
  readonly contextName: string
  readonly contextKind: Group['kind']
  readonly currency: CurrencyCode
  readonly minorAmount: number
}

export interface AccountFriendBalance {
  readonly id: ParticipantId | `pending:${string}`
  readonly displayName: string
  readonly initials: string
  readonly avatarUrl?: string
  readonly pending: boolean
  readonly directContextId?: string
  readonly positions: readonly SignedCurrencyPosition[]
  readonly breakdowns: readonly FriendBalanceBreakdown[]
}

export interface AccountBalanceProjection {
  readonly currencies: readonly AccountCurrencyBalance[]
  readonly groups: readonly AccountGroupBalance[]
  readonly friends: readonly AccountFriendBalance[]
}

interface MutableCurrencyBalance {
  net: bigint
  owedToUser: bigint
  userOwes: bigint
}

interface MutableFriend {
  id: AccountFriendBalance['id']
  displayName: string
  initials: string
  avatarUrl?: string
  pending: boolean
  directContextId?: string
  positions: Map<CurrencyCode, bigint>
  breakdowns: Map<string, FriendBalanceBreakdown & { minorAmount: number }>
}

/**
 * Projects the saved per-group debt plans into the account dashboard. A saved
 * simplified plan is authoritative for who currently owes whom; currencies are
 * deliberately kept independent.
 */
export function projectAccountBalances(currentUserId: ParticipantId, source: readonly AccountBalanceContext[]): AccountBalanceProjection {
  if (!currentUserId) throw new Error('Current account member is required')
  const account = new Map<CurrencyCode, MutableCurrencyBalance>()
  const friends = new Map<AccountFriendBalance['id'], MutableFriend>()
  const groups: AccountGroupBalance[] = []
  const contexts = [...source].sort((left, right) => compareFirestoreStrings(left.group.name, right.group.name) || compareFirestoreStrings(left.group.id, right.group.id))

  for (const context of contexts) {
    const { group, members, snapshot } = context
    if (snapshot.groupId !== group.id) throw new Error(`Balance snapshot ${snapshot.groupId} does not match context ${group.id}`)
    const memberById = uniqueMembers(members, group.id)
    if (!memberById.has(currentUserId)) throw new Error(`Current account member is missing from context ${group.id}`)
    const plan = snapshot.simplifyDebtsEnabled ? snapshot.simplified : snapshot.pairwise
    validatePlan(plan, memberById, group.id)

    const groupPositions = new Map<CurrencyCode, bigint>([[group.currency, 0n]])
    ensureAccountCurrency(account, group.currency)
    const counterparts = members
      .filter(({ id }) => id !== currentUserId)
      .sort((left, right) => compareFirestoreStrings(left.displayName, right.displayName) || compareFirestoreStrings(left.id, right.id))

    for (const member of counterparts) {
      const friend = ensureFriend(friends, member.id, member, group)
      ensureFriendBreakdown(friend, group, group.currency)
    }

    if (group.kind === 'friendship' && counterparts.length === 0) {
      const pendingId = `pending:${group.id}` as const
      const pending = ensurePendingFriend(friends, pendingId, group)
      ensureFriendBreakdown(pending, group, group.currency)
    }

    for (const debt of plan) {
      const { currency, minorAmount } = debt.money
      if (debt.fromParticipantId !== currentUserId && debt.toParticipantId !== currentUserId) continue
      const signed = debt.toParticipantId === currentUserId ? BigInt(minorAmount) : -BigInt(minorAmount)
      const counterpartId = debt.toParticipantId === currentUserId ? debt.fromParticipantId : debt.toParticipantId
      const counterpart = memberById.get(counterpartId)
      if (!counterpart) throw new Error(`Balance context ${group.id} references an unavailable member`)

      groupPositions.set(currency, (groupPositions.get(currency) ?? 0n) + signed)
      const totals = ensureAccountCurrency(account, currency)
      totals.net += signed
      if (signed > 0n) totals.owedToUser += signed
      else totals.userOwes -= signed

      const friend = ensureFriend(friends, counterpartId, counterpart, group)
      friend.positions.set(currency, (friend.positions.get(currency) ?? 0n) + signed)
      const breakdown = ensureFriendBreakdown(friend, group, currency)
      friend.breakdowns.set(breakdownKey(group.id, currency), { ...breakdown, minorAmount: safeNumber(BigInt(breakdown.minorAmount) + signed) })
    }

    groups.push({
      groupId: group.id,
      groupName: group.name,
      kind: group.kind,
      positions: currencyPositions(groupPositions),
    })
  }

  return {
    currencies: [...account.entries()]
      .sort(([left], [right]) => compareFirestoreStrings(left, right))
      .map(([currency, totals]) => ({
        currency,
        netMinor: safeNumber(totals.net),
        owedToUserMinor: safeNumber(totals.owedToUser),
        userOwesMinor: safeNumber(totals.userOwes),
      })),
    groups,
    friends: [...friends.values()]
      .sort((left, right) => compareFirestoreStrings(left.displayName, right.displayName) || compareFirestoreStrings(left.id, right.id))
      .map((friend) => ({
        id: friend.id,
        displayName: friend.displayName,
        initials: friend.initials,
        ...(friend.avatarUrl ? { avatarUrl: friend.avatarUrl } : {}),
        pending: friend.pending,
        ...(friend.directContextId ? { directContextId: friend.directContextId } : {}),
        positions: currencyPositions(friend.positions),
        breakdowns: [...friend.breakdowns.values()].sort(compareBreakdowns),
      })),
  }
}

function uniqueMembers(members: readonly Member[], groupId: string): Map<ParticipantId, Member> {
  const result = new Map<ParticipantId, Member>()
  for (const member of members) {
    if (result.has(member.id)) throw new Error(`Balance context ${groupId} contains a duplicate member`)
    result.set(member.id, member)
  }
  return result
}

function validatePlan(plan: GroupBalanceSnapshot['pairwise'], members: ReadonlyMap<ParticipantId, Member>, groupId: string): void {
  for (const debt of plan) {
    if (debt.fromParticipantId === debt.toParticipantId) throw new Error(`Balance context ${groupId} contains a self debt`)
    if (!members.has(debt.fromParticipantId) || !members.has(debt.toParticipantId)) throw new Error(`Balance context ${groupId} references an unavailable member`)
    if (!Number.isSafeInteger(debt.money.minorAmount) || debt.money.minorAmount <= 0) throw new Error(`Balance context ${groupId} contains an invalid amount`)
  }
}

function ensureAccountCurrency(target: Map<CurrencyCode, MutableCurrencyBalance>, currency: CurrencyCode): MutableCurrencyBalance {
  const current = target.get(currency)
  if (current) return current
  const created = { net: 0n, owedToUser: 0n, userOwes: 0n }
  target.set(currency, created)
  return created
}

function ensureFriend(target: Map<AccountFriendBalance['id'], MutableFriend>, id: ParticipantId, member: Member, group: Group): MutableFriend {
  const current = target.get(id)
  if (current) {
    if (group.kind === 'friendship') {
      current.displayName = group.name
      current.initials = member.initials || initialsFor(group.name)
      current.avatarUrl = member.avatarUrl
      current.directContextId = earliestId(current.directContextId, group.id)
    }
    return current
  }
  const created: MutableFriend = {
    id,
    displayName: group.kind === 'friendship' ? group.name : member.displayName,
    initials: member.initials || initialsFor(member.displayName),
    ...(member.avatarUrl ? { avatarUrl: member.avatarUrl } : {}),
    pending: false,
    ...(group.kind === 'friendship' ? { directContextId: group.id } : {}),
    positions: new Map(),
    breakdowns: new Map(),
  }
  target.set(id, created)
  return created
}

function ensurePendingFriend(target: Map<AccountFriendBalance['id'], MutableFriend>, id: `pending:${string}`, group: Group): MutableFriend {
  const current = target.get(id)
  if (current) return current
  const created: MutableFriend = {
    id,
    displayName: group.name,
    initials: initialsFor(group.name),
    pending: true,
    directContextId: group.id,
    positions: new Map(),
    breakdowns: new Map(),
  }
  target.set(id, created)
  return created
}

function ensureFriendBreakdown(friend: MutableFriend, group: Group, currency: CurrencyCode): FriendBalanceBreakdown {
  if (!friend.positions.has(currency)) friend.positions.set(currency, 0n)
  const key = breakdownKey(group.id, currency)
  const current = friend.breakdowns.get(key)
  if (current) return current
  const created: FriendBalanceBreakdown = {
    contextId: group.id,
    contextName: group.name,
    contextKind: group.kind,
    currency,
    minorAmount: 0,
  }
  friend.breakdowns.set(key, created)
  return created
}

function currencyPositions(source: ReadonlyMap<CurrencyCode, bigint>): SignedCurrencyPosition[] {
  return [...source.entries()]
    .sort(([left], [right]) => compareFirestoreStrings(left, right))
    .map(([currency, minorAmount]) => ({ currency, minorAmount: safeNumber(minorAmount) }))
}

function compareBreakdowns(left: FriendBalanceBreakdown, right: FriendBalanceBreakdown): number {
  return compareFirestoreStrings(left.contextName, right.contextName)
    || compareFirestoreStrings(left.contextId, right.contextId)
    || compareFirestoreStrings(left.currency, right.currency)
}

function breakdownKey(groupId: string, currency: CurrencyCode): string { return `${groupId}\u0000${currency}` }

function earliestId(left: string | undefined, right: string): string {
  return left === undefined || compareFirestoreStrings(right, left) < 0 ? right : left
}

function initialsFor(displayName: string): string {
  return displayName.trim().split(/\s+/u).filter(Boolean).slice(0, 2).map((part) => part.slice(0, 1).toUpperCase()).join('') || '?'
}

function safeNumber(value: bigint): number {
  const maximum = BigInt(Number.MAX_SAFE_INTEGER)
  if (value < -maximum || value > maximum) throw new Error('Account balance aggregate exceeds safe integer range')
  return Number(value)
}
