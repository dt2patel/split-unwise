<script setup lang="ts">
import type { Member } from '../data/repositories'

defineProps<{ member: Member; size?: 'compact' | 'regular' }>()
</script>

<template>
  <span class="member-avatar" :class="`member-avatar--${size ?? 'regular'}`" :aria-label="member.displayName">
    <img v-if="member.avatarUrl" :src="member.avatarUrl" :alt="member.displayName">
    <span v-else class="member-avatar__initials" aria-hidden="true">{{ member.initials }}</span>
  </span>
</template>

<style scoped>
.member-avatar { display: inline-grid; width: 44px; height: 44px; flex: 0 0 auto; place-items: center; overflow: hidden; border: 1px solid var(--su-divider); border-radius: 50%; background: var(--su-lilac); color: var(--su-indigo); font-size: 0.8rem; font-weight: 700; }
.member-avatar--compact { width: 32px; height: 32px; }
.member-avatar img { width: 100%; height: 100%; object-fit: cover; }
</style>
