import { GROUP_COVER_IMAGE_URLS, type GroupCoverImageUrl } from '@split-unwise/shared'

export type GroupCoverId = 'trip' | 'home' | 'couple' | 'other'

export interface GroupCoverChoice {
  readonly id: GroupCoverId
  readonly label: string
  readonly description: string
  readonly imageUrl: GroupCoverImageUrl
}

export const GROUP_COVER_CHOICES: readonly GroupCoverChoice[] = Object.freeze([
  { id: 'trip', label: 'Trip', description: 'Travel and weekends', imageUrl: GROUP_COVER_IMAGE_URLS[0] },
  { id: 'home', label: 'Home', description: 'Rent and household bills', imageUrl: GROUP_COVER_IMAGE_URLS[1] },
  { id: 'couple', label: 'Couple', description: 'Everyday shared costs', imageUrl: GROUP_COVER_IMAGE_URLS[2] },
  { id: 'other', label: 'Other', description: 'Friends, events, and more', imageUrl: GROUP_COVER_IMAGE_URLS[3] },
])

export function groupCoverChoice(id: GroupCoverId): GroupCoverChoice {
  return GROUP_COVER_CHOICES.find((choice) => choice.id === id) ?? GROUP_COVER_CHOICES[0]
}
