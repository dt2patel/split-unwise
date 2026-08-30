import { createRouter, createWebHistory } from '@ionic/vue-router'
import type { Router, RouteRecordRaw } from 'vue-router'
import TabsShell from '../features/shell/TabsShell.vue'
import RoutePlaceholderPage from '../features/shell/RoutePlaceholderPage.vue'
import HomePage from '../features/home/HomePage.vue'
import GroupsPage from '../features/groups/GroupsPage.vue'
import GroupDetailPage from '../features/groups/GroupDetailPage.vue'
import ExpenseEditorPage from '../features/expenses/ExpenseEditorPage.vue'

const routes: RouteRecordRaw[] = [
  { path: '/', redirect: '/tabs/home' },
  {
    path: '/tabs',
    name: 'tabs',
    component: TabsShell,
    children: [
      { path: '', name: 'tabs-index', redirect: '/tabs/home' },
      { path: 'home', name: 'home', component: HomePage },
      { path: 'groups', name: 'groups', component: GroupsPage },
      ...(['home', 'groups', 'activity', 'account'] as const).flatMap((origin) => [
        { path: `${origin}/expenses/new`, name: `${origin}-expense-create`, component: ExpenseEditorPage, meta: { pageTitle: 'Add expense', pageDescription: `Create an expense from the ${origin} stack.`, hideAppChrome: true } },
        { path: `${origin}/expenses/:expenseId/edit`, name: `${origin}-expense-edit`, component: ExpenseEditorPage, meta: { pageTitle: 'Edit expense', pageDescription: `Edit an expense from the ${origin} stack.`, hideAppChrome: true } },
      ] satisfies RouteRecordRaw[]),
      { path: 'groups/:groupId/expenses/new', redirect: (to) => ({ name: 'groups-expense-create', query: { groupId: String(to.params.groupId ?? '') } }) },
      { path: 'groups/:groupId/settle-up', name: 'group-settle-up', component: RoutePlaceholderPage, meta: { pageTitle: 'Settle up', pageDescription: 'Record a payment for this group.', hideAppChrome: true } },
      { path: 'groups/:groupId/balances', name: 'group-balances', component: RoutePlaceholderPage, meta: { pageTitle: 'Balances', pageDescription: 'Review who owes whom in this group.', hideAppChrome: true } },
      { path: 'groups/:groupId/totals', name: 'group-totals', component: RoutePlaceholderPage, meta: { pageTitle: 'Totals', pageDescription: 'Review paid, shared, and net totals.', hideAppChrome: true } },
      { path: 'groups/:groupId/charts', name: 'group-charts', component: RoutePlaceholderPage, meta: { pageTitle: 'Charts', pageDescription: 'Explore spending over time and by category.', hideAppChrome: true } },
      { path: 'groups/:groupId/export', name: 'group-export', component: RoutePlaceholderPage, meta: { pageTitle: 'Export', pageDescription: 'Download this group as CSV or JSON.', hideAppChrome: true } },
      { path: 'groups/:groupId/settings', name: 'group-settings', component: RoutePlaceholderPage, meta: { pageTitle: 'Group settings', pageDescription: 'Manage members, currency, and group defaults.', hideAppChrome: true } },
      { path: 'groups/:groupId', name: 'group-detail', component: GroupDetailPage, meta: { hideAppChrome: true } },
      { path: 'activity', name: 'activity', component: RoutePlaceholderPage, meta: { pageTitle: 'Activity', pageDescription: 'Review expense changes, comments, and settlements.' } },
      { path: 'account', name: 'account', component: RoutePlaceholderPage, meta: { pageTitle: 'Account', pageDescription: 'Manage your profile, appearance, currencies, and data.' } },
    ],
  },
]

export function createAppRouter(): Router {
  return createRouter({
    history: createWebHistory(import.meta.env.BASE_URL),
    routes,
  })
}
