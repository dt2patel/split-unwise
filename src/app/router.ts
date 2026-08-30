import { createRouter, createWebHistory } from '@ionic/vue-router'
import type { Router, RouteRecordRaw } from 'vue-router'
import TabsShell from '../features/shell/TabsShell.vue'
import RoutePlaceholderPage from '../features/shell/RoutePlaceholderPage.vue'
import HomePage from '../features/home/HomePage.vue'
import GroupsPage from '../features/groups/GroupsPage.vue'
import GroupDetailPage from '../features/groups/GroupDetailPage.vue'

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
      { path: 'home/expenses/new', name: 'home-expense-create', component: RoutePlaceholderPage, meta: { pageTitle: 'Add expense', pageDescription: 'Create an expense from your Home stack.' } },
      { path: 'groups/expenses/new', name: 'groups-expense-create', component: RoutePlaceholderPage, meta: { pageTitle: 'Add expense', pageDescription: 'Choose a group and add a shared expense.' } },
      { path: 'activity/expenses/new', name: 'activity-expense-create', component: RoutePlaceholderPage, meta: { pageTitle: 'Add expense', pageDescription: 'Create an expense while keeping your Activity stack in place.' } },
      { path: 'account/expenses/new', name: 'account-expense-create', component: RoutePlaceholderPage, meta: { pageTitle: 'Add expense', pageDescription: 'Create an expense while keeping your Account stack in place.' } },
      { path: 'groups/:groupId/expenses/new', name: 'group-expense-create', component: RoutePlaceholderPage, meta: { pageTitle: 'Add expense', pageDescription: 'Add a new expense to this group.' } },
      { path: 'groups/:groupId/settle-up', name: 'group-settle-up', component: RoutePlaceholderPage, meta: { pageTitle: 'Settle up', pageDescription: 'Record a payment for this group.' } },
      { path: 'groups/:groupId/balances', name: 'group-balances', component: RoutePlaceholderPage, meta: { pageTitle: 'Balances', pageDescription: 'Review who owes whom in this group.' } },
      { path: 'groups/:groupId/totals', name: 'group-totals', component: RoutePlaceholderPage, meta: { pageTitle: 'Totals', pageDescription: 'Review paid, shared, and net totals.' } },
      { path: 'groups/:groupId/charts', name: 'group-charts', component: RoutePlaceholderPage, meta: { pageTitle: 'Charts', pageDescription: 'Explore spending over time and by category.' } },
      { path: 'groups/:groupId/export', name: 'group-export', component: RoutePlaceholderPage, meta: { pageTitle: 'Export', pageDescription: 'Download this group as CSV or JSON.' } },
      { path: 'groups/:groupId/settings', name: 'group-settings', component: RoutePlaceholderPage, meta: { pageTitle: 'Group settings', pageDescription: 'Manage members, currency, and group defaults.' } },
      { path: 'groups/:groupId', name: 'group-detail', component: GroupDetailPage },
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
