<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { storeToRefs } from 'pinia'
import { IonButton, IonButtons, IonContent, IonHeader, IonIcon, IonPage, IonTitle, IonToolbar } from '@ionic/vue'
import { chevronForward, searchOutline } from 'ionicons/icons'
import { useGroupStore } from '../groups/groupStore'
import { friendshipContexts, groupContexts } from '../../domain/expenseContexts'

const store = useGroupStore()
const { groups, currentUser, error, isLoading } = storeToRefs(store)
const friends = computed(() => friendshipContexts(groups.value))
const recentGroups = computed(() => groupContexts(groups.value))

onMounted(() => store.loadOverview())
</script>

<template>
  <ion-page>
    <ion-header translucent>
      <ion-toolbar>
        <ion-title>Split Unwise</ion-title>
        <ion-buttons slot="end"><ion-button class="home-search-button" router-link="/tabs/home/search" aria-label="Search expenses"><ion-icon :icon="searchOutline" aria-hidden="true" /></ion-button></ion-buttons>
      </ion-toolbar>
    </ion-header>
    <ion-content :fullscreen="true">
      <main class="browse-page">
        <p class="browse-page__eyebrow">{{ currentUser ? `Welcome back, ${currentUser.displayName}` : 'Your shared expenses' }}</p>
        <h1>Home</h1>
        <p class="browse-page__intro">See what is shared, what is settled, and what needs your attention.</p>

        <p v-if="isLoading" role="status">Loading your groups…</p>
        <p v-else-if="error" role="alert">{{ error }}</p>
        <template v-else>
        <section class="friends-card" aria-labelledby="friends-title">
          <div><h2 id="friends-title">Friends</h2><p>{{ friends.length ? `${friends.length} direct ${friends.length === 1 ? 'friend' : 'friends'}` : 'Add someone for direct expenses' }}</p></div>
          <router-link data-testid="friends-link" to="/tabs/home/friends">View all <ion-icon :icon="chevronForward" aria-hidden="true" /></router-link>
          <router-link v-for="friend in friends.slice(0, 2)" :key="friend.id" :data-testid="friend.id" class="friend-chip" :to="`/tabs/groups/${friend.id}`"><span>{{ friend.name.slice(0, 1).toUpperCase() }}</span><strong>{{ friend.name }}</strong><small>{{ friend.memberIds.length < 2 ? 'Pending' : 'Open' }}</small></router-link>
        </section>
        <section aria-labelledby="recent-groups-title">
          <h2 id="recent-groups-title">Recent groups</h2>
          <router-link
            v-for="group in recentGroups"
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
        </template>
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
.home-search-button { min-width: 44px; min-height: 44px; }
.friends-card{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;margin:0 0 28px;padding:16px;border-radius:20px;background:var(--su-lilac);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--su-divider) 18%,transparent)}.friends-card h2,.friends-card p{margin:0}.friends-card p{margin-top:4px;color:var(--ion-color-medium);font-size:.78rem}.friends-card>a{display:flex;min-height:44px;align-items:center;gap:2px;color:var(--ion-color-primary);font-size:.8rem;font-weight:700;text-decoration:none}.friend-chip{grid-column:1/-1!important;display:grid!important;grid-template-columns:38px minmax(0,1fr) auto;min-height:50px!important;padding:5px 0;border-top:1px solid color-mix(in srgb,var(--su-divider) 28%,transparent);color:inherit!important}.friend-chip>span{display:grid;width:34px;height:34px;place-items:center;border-radius:50%;background:var(--su-indigo);color:#fff}.friend-chip small{color:var(--ion-color-medium);font-weight:550}
</style>
