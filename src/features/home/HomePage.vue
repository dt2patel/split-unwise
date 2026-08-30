<script setup lang="ts">
import { onMounted } from 'vue'
import { storeToRefs } from 'pinia'
import { IonContent, IonHeader, IonIcon, IonPage, IonTitle, IonToolbar } from '@ionic/vue'
import { chevronForward } from 'ionicons/icons'
import { useGroupStore } from '../groups/groupStore'

const store = useGroupStore()
const { groups, currentUser, error, isLoading } = storeToRefs(store)

onMounted(() => store.loadOverview())
</script>

<template>
  <ion-page>
    <ion-header translucent>
      <ion-toolbar>
        <ion-title>Split Unwise</ion-title>
      </ion-toolbar>
    </ion-header>
    <ion-content :fullscreen="true">
      <main class="browse-page">
        <p class="browse-page__eyebrow">{{ currentUser ? `Welcome back, ${currentUser.displayName}` : 'Your shared expenses' }}</p>
        <h1>Home</h1>
        <p class="browse-page__intro">See what is shared, what is settled, and what needs your attention.</p>

        <p v-if="isLoading" role="status">Loading your groups…</p>
        <p v-else-if="error" role="alert">{{ error }}</p>
        <section v-else aria-labelledby="recent-groups-title">
          <h2 id="recent-groups-title">Recent groups</h2>
          <router-link
            v-for="group in groups"
            :key="group.id"
            class="group-link"
            data-testid="lake-house-link"
            :to="`/tabs/groups/${group.id}`"
          >
            <img v-if="group.coverImageUrl" :src="group.coverImageUrl" alt="" aria-hidden="true">
            <span><strong>{{ group.name }}</strong><small>{{ group.memberIds.length }} members</small></span>
            <ion-icon class="group-link__chevron" :icon="chevronForward" aria-hidden="true" />
          </router-link>
        </section>
      </main>
    </ion-content>
  </ion-page>
</template>

<style scoped>
.browse-page { padding: 22px 18px 110px; }
.browse-page__eyebrow { margin: 0 0 5px; color: var(--su-accent); font-size: 0.82rem; font-weight: 650; }
.browse-page h1 { margin: 0; font-size: 2rem; letter-spacing: -0.035em; }
.browse-page__intro { max-width: 29rem; margin: 8px 0 28px; color: var(--ion-color-medium); line-height: 1.45; }
.browse-page h2 { margin: 0 0 10px; font-size: 1rem; }
.group-link { display: grid; grid-template-columns: 58px minmax(0, 1fr) 24px; align-items: center; gap: 12px; min-height: 72px; padding: 9px 0; border-bottom: 1px solid var(--su-divider); color: inherit; text-decoration: none; }
.group-link img { width: 58px; height: 58px; border-radius: 16px; object-fit: cover; object-position: 50% 88%; }
.group-link span:not(.group-link__chevron) { display: grid; gap: 3px; }
.group-link small { color: var(--ion-color-medium); }
.group-link__chevron { color: var(--su-accent); font-size: 1.7rem; text-align: end; }
</style>
