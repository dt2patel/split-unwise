<script setup lang="ts">
import { IonLabel, IonRouterOutlet, IonTabBar, IonTabButton, IonTabs } from '@ionic/vue'
</script>

<template>
  <ion-tabs>
    <ion-router-outlet />

    <ion-tab-bar slot="bottom" aria-label="Primary navigation">
      <ion-tab-button tab="home" href="/tabs/home">
        <ion-label>Home</ion-label>
      </ion-tab-button>
      <ion-tab-button tab="groups" href="/tabs/groups">
        <ion-label>Groups</ion-label>
      </ion-tab-button>
      <ion-tab-button tab="activity" href="/tabs/activity">
        <ion-label>Activity</ion-label>
      </ion-tab-button>
      <ion-tab-button tab="account" href="/tabs/account">
        <ion-label>Account</ion-label>
      </ion-tab-button>
    </ion-tab-bar>
  </ion-tabs>
</template>
