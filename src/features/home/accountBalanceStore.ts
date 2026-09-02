import { ref } from 'vue'
import { defineStore } from 'pinia'
import type { Group } from '../../data/repositories'
import { getAppSession } from '../../data/session'
import { compareFirestoreStrings } from '../../data/timeline'
import { projectAccountBalances, type AccountBalanceContext, type AccountBalanceProjection } from '../../domain/accountBalances'
import type { ParticipantId } from '../../domain/model'

const MAX_PARALLEL_CONTEXT_READS = 4

export type AccountBalanceCoverage =
  | { readonly status: 'idle'; readonly loadedContextIds: readonly []; readonly failedContextIds: readonly [] }
  | { readonly status: 'loading' | 'complete' | 'partial' | 'error'; readonly loadedContextIds: readonly string[]; readonly failedContextIds: readonly string[] }

export type AccountBalanceNotice = 'partial' | 'unavailable'

export const useAccountBalanceStore = defineStore('account-balances', () => {
  const session = getAppSession()
  const projection = ref<AccountBalanceProjection>(emptyProjection())
  const coverage = ref<AccountBalanceCoverage>(emptyCoverage())
  const isLoading = ref(false)
  const notice = ref<AccountBalanceNotice>()
  let requestNumber = 0
  let loadedSignature: string | undefined
  let visibleSignature: string | undefined
  let activeLoad: { readonly signature: string; readonly promise: Promise<void> } | undefined

  function load(groups: readonly Group[], currentUserId: ParticipantId, options: { readonly force?: boolean } = {}): Promise<void> {
    const signature = loadSignature(groups, currentUserId)
    if (activeLoad?.signature === signature) return activeLoad.promise
    if (!options.force && loadedSignature === signature) return Promise.resolve()
    if (loadedSignature === signature) loadedSignature = undefined

    const request = ++requestNumber
    if (visibleSignature !== signature) {
      projection.value = emptyProjection()
      coverage.value = emptyCoverage()
      visibleSignature = signature
    }
    isLoading.value = true
    notice.value = undefined
    coverage.value = { status: 'loading', loadedContextIds: [], failedContextIds: [] }

    let pending!: Promise<void>
    pending = (async () => {
      const successful: AccountBalanceContext[] = []
      const failed: string[] = []
      try {
        await (session as typeof session & { readonly ready?: Promise<void> }).ready
        await mapWithConcurrency(groups, MAX_PARALLEL_CONTEXT_READS, async (group) => {
          try {
            const [members, snapshot] = await Promise.all([
              session.repository.groups.listMembers(group.id),
              session.repository.groups.getBalanceSnapshot(group.id),
            ])
            if (request !== requestNumber) return
            const candidate = { group, members, snapshot }
            // Validate both the individual repository result and the aggregate before
            // publishing it. A corrupt context never blanks already verified rows.
            projectAccountBalances(currentUserId, [candidate])
            const next = [...successful, candidate]
            const nextProjection = projectAccountBalances(currentUserId, next)
            successful.push(candidate)
            projection.value = nextProjection
            coverage.value = {
              status: 'loading',
              loadedContextIds: contextIds(successful),
              failedContextIds: sortedIds(failed),
            }
          } catch {
            if (request !== requestNumber) return
            failed.push(group.id)
            coverage.value = {
              status: 'loading',
              loadedContextIds: contextIds(successful),
              failedContextIds: sortedIds(failed),
            }
          }
        })
      } catch {
        if (request === requestNumber) failed.push(...groups.map(({ id }) => id).filter((id) => !failed.includes(id)))
      }

      if (request !== requestNumber) return
      const loadedContextIds = contextIds(successful)
      const failedContextIds = sortedIds(failed)
      if (failedContextIds.length === 0) {
        coverage.value = { status: 'complete', loadedContextIds, failedContextIds }
        loadedSignature = signature
      } else if (loadedContextIds.length > 0) {
        coverage.value = { status: 'partial', loadedContextIds, failedContextIds }
        notice.value = 'partial'
      } else {
        coverage.value = { status: 'error', loadedContextIds, failedContextIds }
        notice.value = 'unavailable'
      }
    })().finally(() => {
      if (request === requestNumber) isLoading.value = false
      if (activeLoad?.promise === pending) activeLoad = undefined
    })
    activeLoad = { signature, promise: pending }
    return pending
  }

  function reset(): void {
    requestNumber += 1
    loadedSignature = undefined
    visibleSignature = undefined
    activeLoad = undefined
    projection.value = emptyProjection()
    coverage.value = emptyCoverage()
    isLoading.value = false
    notice.value = undefined
  }

  return { projection, coverage, isLoading, notice, load, reset }
})

async function mapWithConcurrency<T>(items: readonly T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let nextIndex = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex
      nextIndex += 1
      await worker(items[index]!)
    }
  })
  await Promise.all(workers)
}

function loadSignature(groups: readonly Group[], currentUserId: ParticipantId): string {
  const contexts = [...groups]
    .sort((left, right) => compareFirestoreStrings(left.id, right.id))
    .map(({ id, kind, name, currency, memberIds, syncState }) => ({ id, kind, name, currency, memberIds: [...memberIds].sort(compareFirestoreStrings), syncState }))
  return JSON.stringify({ currentUserId, contexts })
}

function contextIds(contexts: readonly AccountBalanceContext[]): string[] { return sortedIds(contexts.map(({ group }) => group.id)) }
function sortedIds(ids: readonly string[]): string[] { return [...new Set(ids)].sort(compareFirestoreStrings) }
function emptyProjection(): AccountBalanceProjection { return { currencies: [], groups: [], friends: [] } }
function emptyCoverage(): AccountBalanceCoverage { return { status: 'idle', loadedContextIds: [], failedContextIds: [] } }
