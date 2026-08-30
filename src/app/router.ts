import { defineComponent, h } from 'vue'
import { createRouter, createWebHistory } from '@ionic/vue-router'
import type { Router, RouteRecordRaw } from 'vue-router'
import TabsShell from '../features/shell/TabsShell.vue'

const RoutePlaceholder = defineComponent({
  name: 'RoutePlaceholder',
  setup() {
    return () => h('main', { class: 'ion-page', 'aria-label': 'Split Unwise content' })
  },
})

const routes: RouteRecordRaw[] = [
  { path: '/', redirect: '/tabs/home' },
  {
    path: '/tabs',
    name: 'tabs',
    component: TabsShell,
    children: [
      { path: '', name: 'tabs-index', redirect: '/tabs/home' },
      { path: 'home', name: 'home', component: RoutePlaceholder },
      { path: 'groups', name: 'groups', component: RoutePlaceholder },
      { path: 'groups/:groupId', name: 'group-detail', component: RoutePlaceholder },
      { path: 'activity', name: 'activity', component: RoutePlaceholder },
      { path: 'account', name: 'account', component: RoutePlaceholder },
    ],
  },
]

export function createAppRouter(): Router {
  return createRouter({
    history: createWebHistory(import.meta.env.BASE_URL),
    routes,
  })
}
