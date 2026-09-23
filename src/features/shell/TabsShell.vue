<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { IonIcon, IonLabel, IonRouterOutlet, IonTabBar, IonTabButton, IonTabs } from '@ionic/vue'
import { homeOutline, peopleOutline, personCircleOutline, timeOutline } from 'ionicons/icons'
import { useI18n } from '../../app/i18n'
import AppFab from '../../components/AppFab.vue'

const route = useRoute()
const { t } = useI18n()
const hideGlobalChrome = computed(() => route?.meta.hideAppChrome === true)
const expenseRoute = computed(() => {
  const activeTab = /^\/tabs\/(home|groups|activity|account)(?:\/|$)/.exec(route?.path ?? '')?.[1] ?? 'home'
  return `/tabs/${activeTab}/expenses/new`
})
</script>

<template>
  <ion-tabs>
    <ion-router-outlet />
    <app-fab v-if="!hideGlobalChrome" :to="expenseRoute" />

    <ion-tab-bar v-if="!hideGlobalChrome" slot="bottom" :aria-label="t('nav.primary')">
      <ion-tab-button tab="home" href="/tabs/home">
        <ion-icon :icon="homeOutline" aria-hidden="true" />
        <ion-label>{{ t('nav.home') }}</ion-label>
      </ion-tab-button>
      <ion-tab-button tab="groups" href="/tabs/groups">
        <ion-icon :icon="peopleOutline" aria-hidden="true" />
        <ion-label>{{ t('nav.groups') }}</ion-label>
      </ion-tab-button>
      <ion-tab-button tab="activity" href="/tabs/activity">
        <ion-icon :icon="timeOutline" aria-hidden="true" />
        <ion-label>{{ t('nav.activity') }}</ion-label>
      </ion-tab-button>
      <ion-tab-button tab="account" href="/tabs/account">
        <ion-icon :icon="personCircleOutline" aria-hidden="true" />
        <ion-label>{{ t('nav.account') }}</ion-label>
      </ion-tab-button>
    </ion-tab-bar>
  </ion-tabs>
</template>
