<script setup lang="ts">
import { IonApp, IonRouterOutlet } from '@ionic/vue'
import AuthPage from './features/auth/AuthPage.vue'
import InvitationLandingPage from './features/invitations/InvitationLandingPage.vue'
import { peekActiveAppSession } from './data/session'

const ownsFeatureSession = Boolean(peekActiveAppSession())
const isInvitationPath = typeof location !== 'undefined' && /^\/invite\/[A-Za-z0-9._~-]+$/.test(location.pathname)
</script>

<template>
  <ion-app mode="ios">
    <ion-router-outlet v-if="ownsFeatureSession" />
    <invitation-landing-page v-else-if="isInvitationPath" />
    <auth-page v-else />
  </ion-app>
</template>
