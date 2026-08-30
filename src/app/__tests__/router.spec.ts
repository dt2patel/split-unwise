import { describe, expect, it } from 'vitest'
import { createAppRouter } from '../router'

describe('application routes', () => {
  it.each([
    ['/tabs/home', 'home'],
    ['/tabs/groups', 'groups'],
    ['/tabs/activity', 'activity'],
    ['/tabs/account', 'account'],
    ['/tabs/groups/lake-house-weekend', 'group-detail'],
  ])('resolves %s to %s', (path, routeName) => {
    const router = createAppRouter()

    expect(router.resolve(path).name).toBe(routeName)
  })
})
