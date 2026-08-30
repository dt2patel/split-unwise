<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { IonIcon, IonLabel, IonRouterOutlet, IonTabBar, IonTabButton, IonTabs } from '@ionic/vue'
import { homeOutline, peopleOutline, personCircleOutline, timeOutline } from 'ionicons/icons'
import AppFab from '../../components/AppFab.vue'

const route = useRoute()
const expenseRoute = computed(() => {
  const activeTab = /^\/tabs\/(home|groups|activity|account)(?:\/|$)/.exec(route?.path ?? '')?.[1] ?? 'home'
  return `/tabs/${activeTab}/expenses/new`
})
</script>

<template>
  <ion-tabs>
    <ion-router-outlet />

    <ion-tab-bar slot="bottom" aria-label="Primary navigation">
      <ion-tab-button tab="home" href="/tabs/home">
        <ion-icon :icon="homeOutline" aria-hidden="true" />
        <ion-label>Home</ion-label>
      </ion-tab-button>
      <ion-tab-button tab="groups" href="/tabs/groups">
        <ion-icon :icon="peopleOutline" aria-hidden="true" />
        <ion-label>Groups</ion-label>
      </ion-tab-button>
      <ion-tab-button tab="activity" href="/tabs/activity">
        <ion-icon :icon="timeOutline" aria-hidden="true" />
        <ion-label>Activity</ion-label>
      </ion-tab-button>
      <ion-tab-button tab="account" href="/tabs/account">
        <ion-icon :icon="personCircleOutline" aria-hidden="true" />
        <ion-label>Account</ion-label>
      </ion-tab-button>
    </ion-tab-bar>
    <app-fab :to="expenseRoute" />
  </ion-tabs>
</template>
