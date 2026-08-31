import { createRouter, createWebHistory } from '@ionic/vue-router'
import type { Router, RouteRecordRaw } from 'vue-router'
import TabsShell from '../features/shell/TabsShell.vue'
import RoutePlaceholderPage from '../features/shell/RoutePlaceholderPage.vue'
import HomePage from '../features/home/HomePage.vue'
import GroupsPage from '../features/groups/GroupsPage.vue'
import GroupDetailPage from '../features/groups/GroupDetailPage.vue'
import ExpenseEditorPage from '../features/expenses/ExpenseEditorPage.vue'
import ActivityPage from '../features/activity/ActivityPage.vue'
import BalancesPage from '../features/balances/BalancesPage.vue'
import SettleUpPage from '../features/balances/SettleUpPage.vue'

const ExpenseDetailPage = () => import('../features/expenses/ExpenseDetailPage.vue')
const SettlementDetailPage = () => import('../features/balances/SettlementDetailPage.vue')
const TotalsPage = () => import('../features/analytics/TotalsPage.vue')
const ChartsPage = () => import('../features/analytics/ChartsPage.vue')
const SearchPage = () => import('../features/search/SearchPage.vue')
const GroupSettingsPage = () => import('../features/groups/GroupSettingsPage.vue')
const ExportPage = () => import('../features/exports/ExportPage.vue')

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
      { path: 'home/search', name: 'home-search', component: SearchPage, meta: { pageTitle: 'Search', pageDescription: 'Search confirmed expenses across your authorized groups.', hideAppChrome: true } },
      ...(['home', 'groups', 'activity', 'account'] as const).flatMap((origin) => [
        { path: `${origin}/expenses/new`, name: `${origin}-expense-create`, component: ExpenseEditorPage, meta: { pageTitle: 'Add expense', pageDescription: `Create an expense from the ${origin} stack.`, hideAppChrome: true } },
        { path: `${origin}/expenses/:expenseId/edit`, name: `${origin}-expense-edit`, component: ExpenseEditorPage, meta: { pageTitle: 'Edit expense', pageDescription: `Edit an expense from the ${origin} stack.`, hideAppChrome: true } },
        { path: `${origin}/expenses/:expenseId`, name: `${origin}-expense-detail`, component: ExpenseDetailPage, meta: { pageTitle: 'Expense detail', pageDescription: `Review an expense from the ${origin} stack.`, hideAppChrome: true } },
      ] satisfies RouteRecordRaw[]),
      { path: 'groups/:groupId/expenses/new', redirect: (to) => ({ name: 'groups-expense-create', query: { groupId: String(to.params.groupId ?? '') } }) },
      { path: 'groups/:groupId/settle-up', name: 'group-settle-up', component: SettleUpPage, meta: { pageTitle: 'Settle up', pageDescription: 'Record a payment for this group.', hideAppChrome: true } },
      { path: 'groups/:groupId/balances', name: 'group-balances', component: BalancesPage, meta: { pageTitle: 'Balances', pageDescription: 'Review who owes whom in this group.', hideAppChrome: true } },
      { path: 'groups/:groupId/settlements/:settlementId', name: 'group-settlement-detail', component: SettlementDetailPage, meta: { pageTitle: 'Payment', pageDescription: 'Review or void an audited settlement record.', hideAppChrome: true } },
      { path: 'groups/:groupId/search', name: 'group-search', component: SearchPage, meta: { pageTitle: 'Search', pageDescription: 'Search confirmed expenses in this group.', hideAppChrome: true } },
      { path: 'groups/:groupId/totals', name: 'group-totals', component: TotalsPage, meta: { pageTitle: 'Totals', pageDescription: 'Review paid, shared, and net totals.', hideAppChrome: true } },
      { path: 'groups/:groupId/charts', name: 'group-charts', component: ChartsPage, meta: { pageTitle: 'Charts', pageDescription: 'Explore spending over time and by category.', hideAppChrome: true } },
      { path: 'groups/:groupId/export', name: 'group-export', component: ExportPage, meta: { pageTitle: 'Export', pageDescription: 'Download this group as CSV or JSON.', hideAppChrome: true } },
      { path: 'groups/:groupId/settings', name: 'group-settings', component: GroupSettingsPage, meta: { pageTitle: 'Group settings', pageDescription: 'Manage members, currency, and group defaults.', hideAppChrome: true } },
      { path: 'groups/:groupId', name: 'group-detail', component: GroupDetailPage, meta: { hideAppChrome: true } },
      { path: 'activity', name: 'activity', component: ActivityPage, meta: { pageTitle: 'Activity', pageDescription: 'Review expense changes, comments, and settlements.' } },
      { path: 'account', name: 'account', component: RoutePlaceholderPage, meta: { pageTitle: 'Account', pageDescription: 'Manage your profile, appearance, currencies, and data.' } },
      { path: 'account/export', name: 'account-export', component: ExportPage, meta: { pageTitle: 'Export', pageDescription: 'Download your account data as CSV or JSON.', hideAppChrome: true } },
    ],
  },
]

export function createAppRouter(): Router {
  return createRouter({
    history: createWebHistory(import.meta.env.BASE_URL),
    routes,
  })
}
