<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { IonBackButton, IonButtons, IonContent, IonHeader, IonPage, IonTitle, IonToolbar } from '@ionic/vue'

const route = useRoute()
const title = computed(() => String(route.meta.pageTitle ?? 'Split Unwise'))
const description = computed(() => String(route.meta.pageDescription ?? 'This feature is ready for its full workflow.'))
const backPath = computed(() => route.params.groupId ? `/tabs/groups/${String(route.params.groupId)}` : undefined)
</script>

<template>
  <ion-page>
    <ion-header translucent>
      <ion-toolbar>
        <ion-buttons v-if="backPath" slot="start">
          <ion-back-button :default-href="backPath" text="Back" />
        </ion-buttons>
        <ion-title>{{ title }}</ion-title>
      </ion-toolbar>
    </ion-header>
    <ion-content :fullscreen="true">
      <main class="route-page">
        <p class="route-page__eyebrow">Split Unwise</p>
        <h1>{{ title }}</h1>
        <p>{{ description }}</p>
        <span class="route-page__status">Coming next</span>
      </main>
    </ion-content>
  </ion-page>
</template>

<style scoped>
.route-page { padding: 28px 18px 110px; }
.route-page__eyebrow { margin: 0 0 5px; color: var(--su-accent); font-size: 0.82rem; font-weight: 650; }
.route-page h1 { margin: 0; font-size: 2rem; letter-spacing: -0.035em; }
.route-page > p:not(.route-page__eyebrow) { max-width: 30rem; margin: 10px 0 18px; color: var(--ion-color-medium); line-height: 1.5; }
.route-page__status { display: inline-flex; min-height: 32px; align-items: center; padding: 0 12px; border-radius: 16px; background: var(--su-lilac); color: var(--su-indigo); font-size: 0.82rem; font-weight: 650; }
</style>
