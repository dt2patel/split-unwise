export const GROUP_COVER_IMAGE_URLS = [
  '/covers/group-trip.jpg',
  '/covers/group-home.jpg',
  '/covers/group-couple.jpg',
  '/covers/group-other.jpg',
] as const

export type GroupCoverImageUrl = typeof GROUP_COVER_IMAGE_URLS[number]

export function isGroupCoverImageUrl(value: unknown): value is GroupCoverImageUrl {
  return typeof value === 'string' && (GROUP_COVER_IMAGE_URLS as readonly string[]).includes(value)
}

export function assertGroupCoverImageUrl(value: unknown): asserts value is GroupCoverImageUrl {
  if (!isGroupCoverImageUrl(value)) throw new Error('Choose a supported group cover.')
}
