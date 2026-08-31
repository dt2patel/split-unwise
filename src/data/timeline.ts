import type { TimelineCursor } from './repositories'

export interface TimelineIdentity {
  readonly createdAt: string
  readonly id: string
}

/** Firestore string indexes use UTF-8 byte ordering; never delegate identity ties to the host locale. */
export function compareFirestoreStrings(left: string, right: string): number {
  if (left === right) return 0
  const encoder = new TextEncoder()
  const leftBytes = encoder.encode(left)
  const rightBytes = encoder.encode(right)
  const length = Math.min(leftBytes.length, rightBytes.length)
  for (let index = 0; index < length; index += 1) {
    const difference = leftBytes[index] - rightBytes[index]
    if (difference !== 0) return difference
  }
  return leftBytes.length - rightBytes.length
}

export function compareTimelineAscending(left: TimelineIdentity, right: TimelineIdentity): number {
  return compareFirestoreStrings(left.createdAt, right.createdAt) || compareFirestoreStrings(left.id, right.id)
}

export function compareTimelineDescending(left: TimelineIdentity, right: TimelineIdentity): number {
  return compareTimelineAscending(right, left)
}

/** Descending queries continue strictly after the inclusive cursor item. */
export function isAfterDescendingCursor(item: TimelineIdentity, cursor: TimelineCursor): boolean {
  return compareTimelineAscending(item, cursor) < 0
}
