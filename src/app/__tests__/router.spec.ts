import { describe, expect, it } from 'vitest'
import { createAppRouter } from '../router'

describe('application routes', () => {
  it.each([
    ['/tabs/home', 'home'],
    ['/tabs/groups', 'groups'],
    ['/tabs/activity', 'activity'],
    ['/tabs/account', 'account'],
    ['/tabs/groups/lake-house-weekend', 'group-detail'],
  ])('resolves %s through the tabs shell to %s', (path, routeName) => {
    const router = createAppRouter()
    const resolvedRoute = router.resolve(path)

    expect(resolvedRoute.name).toBe(routeName)
    expect(resolvedRoute.matched.map((route) => route.name)).toEqual(['tabs', routeName])
  })
})
