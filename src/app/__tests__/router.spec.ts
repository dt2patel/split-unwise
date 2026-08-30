import { describe, expect, it } from 'vitest'
import { createAppRouter } from '../router'

describe('application routes', () => {
  it.each([
    ['/tabs/home', 'home'],
    ['/tabs/groups', 'groups'],
    ['/tabs/activity', 'activity'],
    ['/tabs/account', 'account'],
    ['/tabs/groups/lake-house-weekend', 'group-detail'],
    ['/tabs/home/expenses/new', 'home-expense-create'],
    ['/tabs/groups/expenses/new', 'groups-expense-create'],
    ['/tabs/activity/expenses/new', 'activity-expense-create'],
    ['/tabs/account/expenses/new', 'account-expense-create'],
    ['/tabs/groups/lake-house-weekend/expenses/new', 'group-expense-create'],
    ['/tabs/groups/lake-house-weekend/settle-up', 'group-settle-up'],
    ['/tabs/groups/lake-house-weekend/balances', 'group-balances'],
    ['/tabs/groups/lake-house-weekend/totals', 'group-totals'],
    ['/tabs/groups/lake-house-weekend/charts', 'group-charts'],
    ['/tabs/groups/lake-house-weekend/export', 'group-export'],
    ['/tabs/groups/lake-house-weekend/settings', 'group-settings'],
  ])('resolves %s through the tabs shell to %s', (path, routeName) => {
    const router = createAppRouter()
    const resolvedRoute = router.resolve(path)

    expect(resolvedRoute.name).toBe(routeName)
    expect(resolvedRoute.matched.map((route) => route.name)).toEqual(['tabs', routeName])
  })
})
