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
    ['/tabs/groups/expenses/groceries/edit?groupId=lake-house-weekend', 'groups-expense-edit'],
    ['/tabs/home/expenses/groceries?groupId=lake-house-weekend', 'home-expense-detail'],
    ['/tabs/groups/expenses/groceries?groupId=lake-house-weekend', 'groups-expense-detail'],
    ['/tabs/activity/expenses/groceries?groupId=lake-house-weekend', 'activity-expense-detail'],
    ['/tabs/account/expenses/groceries?groupId=lake-house-weekend', 'account-expense-detail'],
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

  it.each(['home', 'groups', 'activity', 'account'])('marks the %s composer routes as the sole hidden-chrome authority', (origin) => {
    const router = createAppRouter()
    const create = router.resolve(`/tabs/${origin}/expenses/new?groupId=lake-house-weekend`)
    const edit = router.resolve(`/tabs/${origin}/expenses/groceries/edit?groupId=lake-house-weekend`)
    const detail = router.resolve(`/tabs/${origin}/expenses/groceries?groupId=lake-house-weekend`)

    expect(create.meta.hideAppChrome).toBe(true)
    expect(edit.meta.hideAppChrome).toBe(true)
    expect(detail.meta.hideAppChrome).toBe(true)
  })

  it('redirects the legacy group-specific composer to the origin-scoped route with validated context', async () => {
    const router = createAppRouter()
    await router.push('/tabs/groups/lake-house-weekend/expenses/new')
    await router.isReady()

    expect(router.currentRoute.value.name).toBe('groups-expense-create')
    expect(router.currentRoute.value.query.groupId).toBe('lake-house-weekend')
  })
})
