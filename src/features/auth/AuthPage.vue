<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { IonButton, IonContent, IonIcon, IonPage, IonSpinner } from '@ionic/vue'
import { logoGoogle, mailOutline, lockClosedOutline, personOutline } from 'ionicons/icons'
import { useAuthStore } from './authStore'

const store = useAuthStore()
const displayName = ref('')
const email = ref('')
const password = ref('')
const errorSummary = ref<HTMLElement>()
const heading = computed(() => store.view === 'sign-up' ? 'Create your account' : store.view === 'reset' ? 'Reset your password' : 'Welcome back')
const subtitle = computed(() => store.view === 'sign-up' ? 'Start splitting without the premium gate.' : store.view === 'reset' ? 'We’ll send a secure reset link.' : 'Bills, balances, and the truth—settled.')

async function submit(): Promise<void> {
  const ok = store.view === 'sign-up'
    ? await store.signUp(displayName.value, email.value, password.value)
    : store.view === 'reset'
      ? await store.resetPassword(email.value)
      : await store.signIn(email.value, password.value)
  if (!ok && store.error) { await nextTick(); errorSummary.value?.focus() }
}
</script>

<template>
  <ion-page class="auth-page">
    <ion-content :fullscreen="true">
      <main class="auth-shell">
        <section class="auth-brand" aria-labelledby="auth-heading">
          <div class="auth-mark" aria-hidden="true"><span /><span /><span /></div>
          <p class="auth-kicker">SPLIT UNWISE</p>
          <h1 id="auth-heading">{{ heading }}</h1>
          <p>{{ subtitle }}</p>
        </section>

        <div v-if="store.state.status === 'loading'" class="auth-state" role="status" aria-live="polite">
          <ion-spinner name="crescent" />
          <span>Opening your account…</span>
        </div>
        <div v-else-if="store.state.status === 'error'" class="auth-card auth-card--error" role="alert">
          <strong>Split Unwise needs attention</strong>
          <p>{{ store.state.message }}</p>
          <small>No demo data was opened.</small>
        </div>
        <div v-else-if="store.state.status === 'signed-in'" class="auth-state" role="status" aria-live="polite">
          <ion-spinner name="crescent" />
          <span>Loading {{ store.state.identity.displayName }}’s groups…</span>
        </div>
        <form v-else class="auth-card" novalidate @submit.prevent="submit">
          <label v-if="store.view === 'sign-up'" for="auth-name">
            <span>Name</span>
            <span class="auth-input"><ion-icon :icon="personOutline" aria-hidden="true" /><input id="auth-name" v-model="displayName" autocomplete="name" required placeholder="Your name" :aria-invalid="store.fieldErrors.displayName ? 'true' : undefined" :aria-describedby="store.fieldErrors.displayName ? 'auth-name-error' : undefined"></span>
            <small v-if="store.fieldErrors.displayName" id="auth-name-error" class="field-error">{{ store.fieldErrors.displayName }}</small>
          </label>
          <label for="auth-email">
            <span>Email</span>
            <span class="auth-input"><ion-icon :icon="mailOutline" aria-hidden="true" /><input id="auth-email" v-model="email" type="email" inputmode="email" autocomplete="email" required placeholder="you@example.com" :aria-invalid="store.fieldErrors.email ? 'true' : undefined" :aria-describedby="store.fieldErrors.email ? 'auth-email-error' : undefined"></span>
            <small v-if="store.fieldErrors.email" id="auth-email-error" class="field-error">{{ store.fieldErrors.email }}</small>
          </label>
          <label v-if="store.view !== 'reset'" for="auth-password">
            <span>Password</span>
            <span class="auth-input"><ion-icon :icon="lockClosedOutline" aria-hidden="true" /><input id="auth-password" v-model="password" type="password" :autocomplete="store.view === 'sign-up' ? 'new-password' : 'current-password'" minlength="8" required placeholder="At least 8 characters" :aria-invalid="store.fieldErrors.password ? 'true' : undefined" :aria-describedby="store.fieldErrors.password ? 'auth-password-error' : undefined"></span>
            <small v-if="store.fieldErrors.password" id="auth-password-error" class="field-error">{{ store.fieldErrors.password }}</small>
          </label>

          <p v-if="store.error" ref="errorSummary" class="auth-error" role="alert" aria-live="assertive" tabindex="-1">{{ store.error }}</p>
          <p v-if="store.notice" class="auth-notice" role="status" aria-live="polite">{{ store.notice }}</p>
          <ion-button type="submit" expand="block" shape="round" :disabled="store.busy">
            {{ store.busy ? 'Please wait…' : store.view === 'sign-up' ? 'Create account' : store.view === 'reset' ? 'Send reset link' : 'Sign in' }}
          </ion-button>

          <template v-if="store.view === 'sign-in'">
            <div class="auth-divider"><span>or</span></div>
            <ion-button class="google-button" type="button" expand="block" shape="round" fill="outline" :disabled="store.busy || !store.canUseGoogle" @click="store.google()">
              <ion-icon slot="start" :icon="logoGoogle" aria-hidden="true" /> Continue with Google
            </ion-button>
            <p v-if="!store.canUseApple" class="provider-note">Apple sign-in isn’t configured yet.</p>
          </template>

          <nav class="auth-links" aria-label="Account help">
            <button v-if="store.view !== 'sign-in'" type="button" @click="store.show('sign-in')">Back to sign in</button>
            <template v-else>
              <button type="button" @click="store.show('reset')">Forgot password?</button>
              <button type="button" @click="store.show('sign-up')">Create account</button>
            </template>
          </nav>
        </form>
        <p class="demo-note">Your financial data is isolated to the signed-in account.</p>
      </main>
    </ion-content>
  </ion-page>
</template>

<style scoped>
.auth-page { --background: var(--su-auth-bg, #f7f5ff); }
.auth-page ion-content { --background: radial-gradient(circle at 50% -8%, color-mix(in srgb, var(--ion-color-primary) 18%, transparent), transparent 40%), var(--su-auth-bg, var(--su-surface)); }
.auth-shell { box-sizing: border-box; display: grid; min-height: 100%; align-content: center; gap: 24px; width: min(100%, 430px); margin: auto; padding: max(34px, env(safe-area-inset-top)) 20px max(28px, env(safe-area-inset-bottom)); }
.auth-brand { text-align: center; }
.auth-mark { position: relative; display: grid; width: 72px; height: 72px; place-items: center; margin: 0 auto 18px; border-radius: 22px; background: linear-gradient(145deg, #7b61ff, #4b2bc5); box-shadow: 0 18px 36px rgb(74 43 197 / 25%); transform: rotate(-3deg); }
.auth-mark span { position: absolute; width: 34px; height: 8px; border-radius: 8px; background: white; }
.auth-mark span:first-child { transform: translateY(-11px) rotate(8deg); }
.auth-mark span:nth-child(2) { width: 24px; transform: translate(7px, 1px) rotate(-8deg); }
.auth-mark span:last-child { width: 16px; transform: translate(12px, 13px) rotate(8deg); }
.auth-kicker { margin: 0 0 7px; color: var(--ion-color-primary); font-size: .72rem; font-weight: 800; letter-spacing: .15em; }
.auth-brand h1 { margin: 0; font-size: clamp(2rem, 9vw, 2.65rem); letter-spacing: -.055em; }
.auth-brand > p:last-child { margin: 9px 0 0; color: var(--ion-color-medium); line-height: 1.45; }
.auth-card { display: grid; gap: 15px; padding: 20px; border: 1px solid color-mix(in srgb, var(--su-divider) 25%, transparent); border-radius: 24px; background: color-mix(in srgb, var(--su-surface) 94%, transparent); box-shadow: 0 18px 50px rgb(35 27 82 / 10%); backdrop-filter: blur(18px); }
.auth-card label { display: grid; gap: 7px; color: var(--ion-color-medium); font-size: .8rem; font-weight: 650; }
.auth-input { display: grid; min-height: 50px; grid-template-columns: 24px 1fr; align-items: center; gap: 8px; padding: 0 14px; border: 1px solid color-mix(in srgb, var(--su-divider) 40%, transparent); border-radius: 14px; background: var(--su-surface); color: var(--ion-color-primary); }
.auth-input input { min-width: 0; min-height: 48px; border: 0; outline: 0; background: transparent; color: var(--su-text); font: inherit; font-size: 16px; }
.auth-input:focus-within { border-color: var(--ion-color-primary); box-shadow: 0 0 0 3px color-mix(in srgb, var(--ion-color-primary) 15%, transparent); }
.auth-card ion-button { min-height: 48px; margin: 2px 0 0; font-weight: 700; text-transform: none; }
.google-button { --border-color: color-mix(in srgb, var(--su-divider) 45%, transparent); --color: var(--su-text); }
.auth-divider { display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; gap: 10px; color: var(--ion-color-medium); font-size: .75rem; }
.auth-divider::before, .auth-divider::after { height: 1px; background: color-mix(in srgb, var(--su-divider) 35%, transparent); content: ''; }
.auth-links { display: flex; flex-wrap: wrap; justify-content: center; gap: 6px 16px; }
.auth-links button { min-height: 44px; padding: 0; border: 0; background: none; color: var(--ion-color-primary); font: inherit; font-size: .85rem; font-weight: 650; }
.auth-error, .auth-notice { margin: 0; padding: 10px 12px; border-radius: 12px; font-size: .82rem; line-height: 1.35; }
.field-error { color: var(--ion-color-danger); font-size: .72rem; font-weight: 550; }
.auth-error { background: color-mix(in srgb, var(--ion-color-danger) 10%, var(--su-surface)); color: var(--ion-color-danger); }
.auth-notice { background: color-mix(in srgb, var(--ion-color-primary) 10%, var(--su-surface)); color: var(--ion-color-primary); }
.provider-note, .demo-note { margin: 0; color: var(--ion-color-medium); font-size: .72rem; text-align: center; }
.auth-state { display: grid; min-height: 150px; place-items: center; align-content: center; gap: 12px; color: var(--ion-color-medium); }
.auth-card--error strong { font-size: 1.1rem; }.auth-card--error p,.auth-card--error small { margin: 0; line-height: 1.45; }
@media (prefers-reduced-motion: no-preference) { .auth-card { animation: auth-rise 320ms cubic-bezier(.2,.8,.2,1) both; } @keyframes auth-rise { from { opacity: 0; transform: translateY(12px) scale(.985); } } }
</style>
