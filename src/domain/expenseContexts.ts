import type { Group } from '../data/repositories'

export function groupContexts(contexts: readonly Group[]): readonly Group[] {
  return contexts.filter(({ kind }) => kind === 'group')
}

export function friendshipContexts(contexts: readonly Group[]): readonly Group[] {
  return contexts.filter(({ kind }) => kind === 'friendship')
}
