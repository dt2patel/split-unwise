<script setup lang="ts">
import { computed } from 'vue'
import { IonIcon } from '@ionic/vue'
import { peopleOutline, personOutline } from 'ionicons/icons'
import BalanceSummary from './BalanceSummary.vue'
import type { Group } from '../../../data'
import type { Money } from '../../../domain/model'

const props = defineProps<{ group: Group; balances: readonly Money[]; collapsed: boolean }>()
const initials = computed(() => {
  const parts = props.group.name.trim().split(/\s+/).filter(Boolean)
  return [parts[0], parts.at(-1)].filter((part, index, values) => part && (index === 0 || part !== values[0])).map((part) => part![0]).join('').toUpperCase() || 'G'
})
</script>

<template>
  <section class="group-hero" :class="{ 'group-hero--collapsed': collapsed }" aria-labelledby="group-title">
    <div class="group-hero__cover-frame">
      <img
        v-if="group.coverImageUrl"
        class="group-hero__cover"
        data-testid="group-cover"
        :src="group.coverImageUrl"
        alt=""
      >
      <div v-else class="group-hero__cover-fallback" data-testid="group-cover-fallback" aria-hidden="true">
        <ion-icon :icon="group.kind === 'friendship' ? personOutline : peopleOutline" />
      </div>
    </div>
    <div class="group-hero__identity">
      <div class="group-hero__monogram" data-testid="group-monogram" aria-hidden="true">{{ initials }}</div>
      <h1 id="group-title">{{ group.name }}</h1>
      <div class="group-hero__balances">
        <balance-summary v-for="balance in balances" :key="balance.currency" :money="balance" />
      </div>
    </div>
  </section>
</template>

<style scoped>
.group-hero { position: relative; text-align: center; }
.group-hero__cover-frame { height: 136px; overflow: hidden; background: var(--su-lilac); }
.group-hero__cover { display: block; width: 100%; height: 100%; object-fit: cover; object-position: 50% 88%; transition: transform var(--su-motion-fast) ease-out; }
.group-hero__cover-fallback { display: grid; width: 100%; height: 100%; place-items: center; background: var(--su-indigo); color: color-mix(in srgb, #fff 78%, var(--su-indigo)); font-size: 3.1rem; }
.group-hero__identity { position: relative; z-index: 1; margin-top: -39px; padding: 0 18px; transition: transform var(--su-motion-fast) ease-out, opacity var(--su-motion-fast) ease-out; transform-origin: top center; }
.group-hero__monogram { display: grid; width: 66px; height: 66px; margin: 0 auto; place-items: center; border: 6px solid var(--su-surface); border-radius: 20px; background: var(--su-indigo); color: #fff; box-shadow: 0 4px 14px rgb(38 32 127 / 18%); font-size: 1.7rem; font-weight: 590; letter-spacing: -0.04em; }
.group-hero h1 { margin: 20px 0 7px; color: var(--su-text); font-size: clamp(1.4rem, 6vw, 1.72rem); font-weight: 710; letter-spacing: -0.025em; line-height: 1.12; }
.group-hero__balances { display: grid; gap: 3px; }
.group-hero--collapsed .group-hero__cover { transform: scale(1.025); }
.group-hero--collapsed .group-hero__identity { opacity: 0.18; transform: translateY(-8px) scale(0.97); }

@media (prefers-reduced-motion: reduce) {
  .group-hero__cover,
  .group-hero__identity { transition: none; }
  .group-hero--collapsed .group-hero__cover,
  .group-hero--collapsed .group-hero__identity { transform: none; }
}
</style>
