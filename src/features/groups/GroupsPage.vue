<script setup lang="ts">
import { onMounted } from 'vue'
import { storeToRefs } from 'pinia'
import { IonContent, IonHeader, IonIcon, IonPage, IonTitle, IonToolbar } from '@ionic/vue'
import { chevronForward } from 'ionicons/icons'
import { useGroupStore } from './groupStore'

const store = useGroupStore()
const { groups, error, isLoading } = storeToRefs(store)

onMounted(() => store.loadOverview())
</script>

<template>
  <ion-page>
    <ion-header translucent>
      <ion-toolbar>
        <ion-title>Groups</ion-title>
      </ion-toolbar>
    </ion-header>
    <ion-content :fullscreen="true">
      <main class="groups-page">
        <h1>Groups</h1>
        <p>Trips, homes, and everyday plans—all in one clear journal.</p>

        <p v-if="isLoading" role="status">Loading groups…</p>
        <p v-else-if="error" role="alert">{{ error }}</p>
        <div v-else class="groups-page__list">
          <router-link
            v-for="group in groups"
            :key="group.id"
            class="group-row"
            data-testid="lake-house-link"
            :to="`/tabs/groups/${group.id}`"
          >
            <img v-if="group.coverImageUrl" :src="group.coverImageUrl" alt="" aria-hidden="true">
            <span class="group-row__copy">
              <strong>{{ group.name }}</strong>
              <small>{{ group.memberIds.length }} people · {{ group.currency }}</small>
            </span>
            <ion-icon :icon="chevronForward" aria-hidden="true" />
          </router-link>
        </div>
      </main>
    </ion-content>
  </ion-page>
</template>

<style scoped>
.groups-page { padding: 20px 18px 110px; }
.groups-page h1 { margin: 0; font-size: 2rem; letter-spacing: -0.035em; }
.groups-page > p { margin: 8px 0 24px; color: var(--ion-color-medium); line-height: 1.45; }
.groups-page__list { border-top: 1px solid var(--su-divider); }
.group-row { display: grid; grid-template-columns: 64px minmax(0, 1fr) 18px; align-items: center; gap: 12px; min-height: 88px; border-bottom: 1px solid var(--su-divider); color: inherit; text-decoration: none; }
.group-row img { width: 64px; height: 64px; border-radius: 18px; object-fit: cover; object-position: 50% 88%; }
.group-row__copy { display: grid; gap: 4px; }
.group-row__copy strong { font-size: 1rem; }
.group-row__copy small { color: var(--ion-color-medium); }
.group-row > ion-icon { color: var(--su-accent); font-size: 1.05rem; }
</style>
