<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useRouter } from 'vue-router'
import { IonButton, IonButtons, IonContent, IonHeader, IonIcon, IonPage, IonTitle, IonToolbar } from '@ionic/vue'
import { add, chevronForward } from 'ionicons/icons'
import { useGroupStore } from './groupStore'
import { getAppSession } from '../../data/session'
import { callSplitUnwiseFunction } from '../../data/firebaseCallables'
import { createClientOperationId } from '../../data/clientOperationId'
import { loadCurrencyPreferences, SUPPORTED_CURRENCIES } from '../account/currencyPreferences'

const store = useGroupStore()
const { groups, error, isLoading } = storeToRefs(store)
const session = getAppSession()
const router = useRouter()
const showingCreate = ref(false)
const groupName = ref('')
const currency = ref('USD')
const createError = ref('')
const creating = ref(false)

onMounted(async () => {
  currency.value = loadCurrencyPreferences(await session.principal).defaultCurrency
  await store.loadOverview()
})

async function createGroup(): Promise<void> {
  const name = groupName.value.trim()
  if (!name) { createError.value = 'Enter a group name.'; return }
  creating.value = true; createError.value = ''
  try {
    const value = await callSplitUnwiseFunction('createGroup', { schemaVersion: 1, operationId: createClientOperationId('group'), name, currency: currency.value }, { replayProtected: true })
    if (!isRecord(value) || typeof value.groupId !== 'string') throw new Error('Group service returned an invalid response.')
    await store.loadOverview()
    await router.push(`/tabs/groups/${encodeURIComponent(value.groupId)}`)
  } catch (reason) { createError.value = reason instanceof Error ? reason.message : 'The group could not be created.' } finally { creating.value = false }
}
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
</script>

<template>
  <ion-page>
    <ion-header translucent>
      <ion-toolbar>
        <ion-title>Groups</ion-title>
        <ion-buttons v-if="session.repository.mode === 'firebase'" slot="end"><ion-button aria-label="Create group" @click="showingCreate = !showingCreate"><ion-icon :icon="add" /></ion-button></ion-buttons>
      </ion-toolbar>
    </ion-header>
    <ion-content :fullscreen="true">
      <main class="groups-page">
        <h1>Groups</h1>
        <p>Trips, homes, and everyday plans—all in one clear journal.</p>

        <form v-if="showingCreate" class="create-group" @submit.prevent="createGroup">
          <label><span>Group name</span><input v-model="groupName" autocomplete="off" maxlength="120" placeholder="Weekend in Chicago"></label>
          <label><span>Currency</span><select v-model="currency"><option v-for="code in SUPPORTED_CURRENCIES" :key="code" :value="code">{{ code }}</option></select></label>
          <p v-if="createError" role="alert">{{ createError }}</p>
          <div><ion-button type="button" fill="clear" @click="showingCreate = false">Cancel</ion-button><ion-button type="submit" shape="round" :disabled="creating">{{ creating ? 'Creating…' : 'Create group' }}</ion-button></div>
        </form>

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
.create-group{display:grid;grid-template-columns:minmax(0,1fr) 100px;gap:12px;margin:0 0 22px;padding:16px;border:1px solid color-mix(in srgb,var(--su-divider) 35%,transparent);border-radius:20px;background:var(--su-surface);box-shadow:0 12px 30px rgb(37 29 87 / 8%);animation:group-create-in 220ms cubic-bezier(.2,.8,.2,1) both}.create-group label{display:grid;gap:6px;color:var(--ion-color-medium);font-size:.75rem;font-weight:650}.create-group input,.create-group select{box-sizing:border-box;width:100%;min-height:46px;padding:0 12px;border:1px solid color-mix(in srgb,var(--su-divider) 40%,transparent);border-radius:12px;background:var(--su-surface);color:var(--su-text);font:inherit;font-size:16px}.create-group>p{grid-column:1/-1;margin:0;color:var(--ion-color-danger);font-size:.78rem}.create-group>div{display:flex;grid-column:1/-1;justify-content:flex-end}.create-group ion-button{text-transform:none}@keyframes group-create-in{from{opacity:0;transform:translateY(-8px) scale(.985)}}
.group-row { display: grid; grid-template-columns: 64px minmax(0, 1fr) 18px; align-items: center; gap: 12px; min-height: 88px; border-bottom: 1px solid var(--su-divider); color: inherit; text-decoration: none; }
.group-row img { width: 64px; height: 64px; border-radius: 18px; object-fit: cover; object-position: 50% 88%; }
.group-row__copy { display: grid; gap: 4px; }
.group-row__copy strong { font-size: 1rem; }
.group-row__copy small { color: var(--ion-color-medium); }
.group-row > ion-icon { color: var(--su-accent); font-size: 1.05rem; }
</style>
