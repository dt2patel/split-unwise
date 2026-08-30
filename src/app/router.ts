import { defineComponent, h } from 'vue'
import { createRouter, createWebHistory } from '@ionic/vue-router'
import type { Router, RouteRecordRaw } from 'vue-router'

const RoutePlaceholder = defineComponent({
  name: 'RoutePlaceholder',
  setup() {
    return () => h('main', { class: 'ion-page' })
  },
})

const routes: RouteRecordRaw[] = [
  { path: '/', redirect: '/tabs/home' },
  { path: '/tabs', redirect: '/tabs/home' },
  { path: '/tabs/home', name: 'home', component: RoutePlaceholder },
  { path: '/tabs/groups', name: 'groups', component: RoutePlaceholder },
  { path: '/tabs/groups/:groupId', name: 'group-detail', component: RoutePlaceholder },
  { path: '/tabs/activity', name: 'activity', component: RoutePlaceholder },
  { path: '/tabs/account', name: 'account', component: RoutePlaceholder },
]

export function createAppRouter(): Router {
  return createRouter({
    history: createWebHistory(import.meta.env.BASE_URL),
    routes,
  })
}
