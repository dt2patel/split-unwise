<script setup lang="ts">
import { IonApp, IonRouterOutlet } from '@ionic/vue'
import AppStatus from './components/AppStatus.vue'
</script>

<template>
  <ion-app mode="ios">
    <app-status />
    <ion-router-outlet />
  </ion-app>
</template>
