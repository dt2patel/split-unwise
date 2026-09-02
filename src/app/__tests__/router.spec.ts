import { describe, expect, it } from 'vitest'
import { createAppRouter } from '../router'
import type { AuthService, AuthState } from '../../features/auth/authService'

describe('application routes', () => {
  it.each([
    ['/tabs/home', 'home'],
    ['/tabs/groups', 'groups'],
    ['/tabs/activity', 'activity'],
    ['/tabs/account', 'account'],
    ['/tabs/home/search', 'home-search'],
    ['/tabs/home/friends', 'friends'],
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
    ['/tabs/groups/lake-house-weekend/settlements/settlement-a', 'group-settlement-detail'],
    ['/tabs/groups/lake-house-weekend/search', 'group-search'],
    ['/tabs/groups/lake-house-weekend/totals', 'group-totals'],
    ['/tabs/groups/lake-house-weekend/charts', 'group-charts'],
    ['/tabs/groups/lake-house-weekend/recurring', 'group-recurring'],
    ['/tabs/groups/lake-house-weekend/convert', 'group-convert'],
    ['/tabs/groups/lake-house-weekend/export', 'group-export'],
    ['/tabs/groups/lake-house-weekend/settings', 'group-settings'],
    ['/tabs/account/export', 'account-export'],
    ['/tabs/account/appearance', 'account-appearance'],
    ['/tabs/account/language', 'account-language'],
    ['/tabs/account/currencies', 'account-currencies'],
    ['/tabs/account/transactions/import', 'account-transaction-import'],
    ['/tabs/groups/lake-house-weekend/invite', 'group-invite'],
  ])('resolves %s through the tabs shell to %s', (path, routeName) => {
    const router = createAppRouter()
    const resolvedRoute = router.resolve(path)

    expect(resolvedRoute.name).toBe(routeName)
    expect(resolvedRoute.matched.map((route) => route.name)).toEqual(['tabs', routeName])
  })

  it('guards Firebase tabs after hydration and consumes the safe return route once', async () => {
    let state: AuthState = { status: 'signed-out', mode: 'firebase' }
    const listeners = new Set<(state: AuthState) => void>()
    const auth = {
      mode: 'firebase', getState: () => state,
      subscribe(listener: (state: AuthState) => void) { listeners.add(listener); listener(state); return () => listeners.delete(listener) },
      capabilities: {},
    } as unknown as AuthService
    const router = createAppRouter({ auth })
    await router.push('/tabs/groups')
    await router.isReady()
    expect(router.currentRoute.value.path).toBe('/auth')

    state = { status: 'signed-in', mode: 'firebase', identity: { uid: 'maya', displayName: 'Maya', emailVerified: true, providerIds: ['password'] } }
    listeners.forEach((listener) => listener(state))
    await router.push('/auth?complete=1')
    expect(router.currentRoute.value.fullPath).toBe('/tabs/groups')
    await router.push('/auth')
    expect(router.currentRoute.value.fullPath).toBe('/tabs/home')
  })

  it('resolves Auth and invitation landing outside the tabs shell', () => {
    const router = createAppRouter()
    expect(router.resolve('/auth').matched.map(({ name }) => name)).toEqual(['auth'])
    expect(router.resolve('/invite/invitation-1').matched.map(({ name }) => name)).toEqual(['invitation-landing'])
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

  it.each([
    '/tabs/groups/lake-house-weekend/balances',
    '/tabs/groups/lake-house-weekend/settle-up',
    '/tabs/groups/lake-house-weekend/settlements/settlement-a',
  ])('hides global app chrome for the durable settlement route %s', (path) => {
    expect(createAppRouter().resolve(path).meta.hideAppChrome).toBe(true)
  })

  it.each([
    '/tabs/home/search',
    '/tabs/groups/lake-house-weekend/search',
    '/tabs/groups/lake-house-weekend/totals',
    '/tabs/groups/lake-house-weekend/charts',
    '/tabs/groups/lake-house-weekend/recurring',
    '/tabs/groups/lake-house-weekend/convert',
    '/tabs/groups/lake-house-weekend/settings',
    '/tabs/groups/lake-house-weekend/export',
    '/tabs/account/export',
    '/tabs/account/language',
    '/tabs/account/transactions/import',
  ])('hides global app chrome for the premium tool route %s', (path) => {
    expect(createAppRouter().resolve(path).meta.hideAppChrome).toBe(true)
  })

  it('keeps the recurring management screen lazy inside the Groups stack', () => {
    const resolved = createAppRouter().resolve('/tabs/groups/lake-house-weekend/recurring')
    const component = resolved.matched.at(-1)?.components?.default

    expect(resolved.name).toBe('group-recurring')
    expect(typeof component).toBe('function')
  })
})
