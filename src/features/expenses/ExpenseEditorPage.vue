<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, shallowRef, watch, type ComponentPublicInstance } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { IonButton, IonButtons, IonContent, IonHeader, IonIcon, IonItem, IonLabel, IonList, IonModal, IonNote, IonPage, IonTitle, IonToolbar } from '@ionic/vue'
import { calendarOutline, cameraOutline, cashOutline, documentTextOutline, peopleOutline, pricetagOutline, repeatOutline } from 'ionicons/icons'
import { currencyExponent, toMinorUnits, type CurrencyCode } from '../../domain/money'
import { useHaptics } from '../../composables/useHaptics'
import ContextSheet from './components/ContextSheet.vue'
import ParticipantSheet from './components/ParticipantSheet.vue'
import PayerSheet from './components/PayerSheet.vue'
import ReceiptReview from './components/ReceiptReview.vue'
import RecurrenceSheet from './components/RecurrenceSheet.vue'
import SplitEditor from './components/SplitEditor.vue'
import { useExpenseStore, type ExpenseOrigin, type PaymentInput, type ReceiptItemInput, type SplitInput } from './expenseStore'
import { parseStrictScalarId } from '../../data/identifiers'
import { restoreInteractiveFocus } from '../../app/focus'

const route = useRoute()
const router = useRouter()
const store = useExpenseStore()
const haptics = useHaptics()
const errorSummary = ref<HTMLElement>()
const receiptInput = ref<HTMLInputElement>()
const presentingElement = shallowRef<HTMLElement>()
const receiptPreviewUrl = ref<string>()
const sheetDirty = ref(false)
const categories = ['Food', 'Transport', 'Lodging', 'Supplies', 'Entertainment', 'Utilities', 'Other']
const pageTitle = computed(() => store.mode === 'edit' ? 'Edit expense' : 'Add expense')
const totalMinorAmount = computed(() => {
  try { return Math.max(0, toMinorUnits(store.editor.amountText || '0', store.editor.currency)) } catch { return 0 }
})
const isReimbursement = computed(() => store.editor.split.type === 'reimbursement')
const payerSummary = computed(() => {
  if (!store.editor.payments.length) return 'Choose who paid'
  const names = store.editor.payments.map((payment) => store.members.find(({ id }) => id === payment.participantId)?.displayName ?? 'Unknown')
  const prefix = isReimbursement.value ? 'Refund received by' : 'Paid by'
  return names.length === 1 ? `${prefix} ${names[0]}` : `${prefix} ${names.length} people`
})
const splitSummary = computed(() => {
  const type = store.editor.split.type
  if (type === 'reimbursement') return 'distributed as a reimbursement'
  const labels: Record<Exclude<SplitInput['type'], 'reimbursement'>, string> = { equal: 'equally', exact: 'by exact amounts', percentage: 'by percentage', shares: 'by shares', adjustment: 'with adjustments', itemized: 'by receipt items' }
  return `split ${labels[type]}`
})
const recurrenceSummary = computed(() => store.editor.recurrence ? `${store.editor.recurrence.frequency} · ${store.editor.recurrence.timeZone}` : 'Does not repeat')
const hasReceipt = computed(() => store.editor.attachmentRefs.length > 0)
const modalCanDismiss = computed<true | typeof canDismissSheet>(() => sheetDirty.value ? canDismissSheet : true)
const receiptItems = computed<readonly ReceiptItemInput[]>(() => {
  if (store.editor.split.type === 'itemized') return store.editor.split.items
  return store.receiptSuggestions.map((suggestion) => ({ description: suggestion.description, amountText: suggestion.amountText, participantIds: [...store.editor.participants] }))
})

watch(() => route.fullPath, () => { void initialize() }, { immediate: true })
watch(() => store.saveState, (state) => {
  if (state === 'saved') void haptics.light()
})
watch(() => store.receiptPreview, (asset) => {
  if (receiptPreviewUrl.value && typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(receiptPreviewUrl.value)
  receiptPreviewUrl.value = asset && typeof URL.createObjectURL === 'function' ? URL.createObjectURL(asset.blob) : undefined
}, { immediate: true })
onBeforeUnmount(() => {
  store.leaveEditor()
  if (receiptPreviewUrl.value && typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(receiptPreviewUrl.value)
})

async function initialize(): Promise<void> {
  const match = /^\/tabs\/(home|groups|activity|account)\/expenses\//.exec(route.path)
  const origin = (match?.[1] ?? 'home') as ExpenseOrigin
  const groupId = parseStrictScalarId(route.query.groupId)
  const importDraftId = parseStrictScalarId(route.query.importDraft)
  const expenseId = typeof route.params.expenseId === 'string' ? route.params.expenseId : undefined
  await store.initialize({ origin, groupId, expenseId, importDraftId })
}

async function cancel(): Promise<void> {
  if (store.isDirty && !window.confirm('Discard your unsaved expense changes?')) return
  await router.replace(store.returnPath)
}

async function save(): Promise<void> {
  if (!await store.submit()) {
    await haptics.warning()
    await nextTick()
    errorSummary.value?.focus()
    return
  }
  await router.replace(store.returnPath)
}

function setPresentingElement(value: Element | ComponentPublicInstance | null): void {
  const element = value && '$el' in value ? value.$el : value
  presentingElement.value = element instanceof HTMLElement ? element : undefined
}
function openSheet(sheet: Parameters<typeof store.openSheet>[0], triggerId: string): void { sheetDirty.value = false; store.openSheet(sheet, triggerId) }
function openReceipt(): void {
  if (hasReceipt.value) openSheet('receipt', 'receipt-sheet-trigger')
  else receiptInput.value?.click()
}
async function closeSheet(): Promise<void> {
  const target = store.focusTarget
  store.closeSheet()
  await nextTick()
  if (target) restoreInteractiveFocus(document.getElementById(target))
}
function markSheetDirty(): void { sheetDirty.value = true }
async function canDismissSheet(_data?: unknown, role?: string): Promise<boolean> {
  if (sheetDirty.value && (role === 'backdrop' || role === 'gesture')) return window.confirm('Discard staged sheet changes?')
  return true
}
async function applyContext(groupId: string): Promise<void> { if (await store.selectContext(groupId)) await closeSheet() }
async function applyPayers(value: readonly PaymentInput[]): Promise<void> { store.editor.payments = value.map((item) => ({ ...item })); await closeSheet() }
async function applyParticipants(value: readonly string[]): Promise<void> {
  const previous = store.editor.split
  store.editor.participants = [...value]
  store.editor.split = previous.type === 'reimbursement'
    ? { type: 'reimbursement', values: Object.fromEntries(value.map((id) => [id, previous.values[id] ?? '0'])) }
    : { type: 'equal' }
  await closeSheet()
}
async function applySplit(value: { readonly input: SplitInput }): Promise<void> { store.editor.split = value.input; await closeSheet() }
async function applyRecurrence(value: { recurrence: typeof store.editor.recurrence; occurrenceEditScope?: 'occurrence' | 'future' }): Promise<void> {
  store.editor.recurrence = value.recurrence
  store.editor.occurrenceEditScope = value.occurrenceEditScope
  await closeSheet()
}
async function confirmReceipt(items: readonly ReceiptItemInput[]): Promise<void> { if (store.confirmReceipt(items)) await closeSheet() }

function changeCurrency(event: Event): void { store.changeCurrency((event.target as HTMLSelectElement).value as CurrencyCode) }
function changeDate(event: Event): void { store.changeDate((event.target as HTMLInputElement).value) }
async function selectReceipt(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  if (await store.attachReceipt(file, file.name)) openSheet('receipt', 'receipt-sheet-trigger')
  input.value = ''
}
</script>

<template>
  <ion-page :ref="setPresentingElement" class="expense-editor-page">
    <ion-header class="expense-editor__header" translucent>
      <ion-toolbar>
        <ion-buttons slot="start"><ion-button data-action="cancel-expense" @click="cancel">Cancel</ion-button></ion-buttons>
        <ion-title>{{ pageTitle }}</ion-title>
        <ion-buttons slot="end"><ion-button strong data-action="save-expense" :disabled="!store.canSubmit" @click="save">Save</ion-button></ion-buttons>
      </ion-toolbar>
    </ion-header>

    <ion-content :fullscreen="true">
      <main class="expense-editor" :class="`expense-editor--${store.saveState}`">
        <h1 class="su-visually-hidden">{{ pageTitle }}</h1>
        <p v-if="store.isLoading" data-testid="expense-loading" role="status" aria-live="polite" class="load-status">Loading expense editor…</p>
        <p v-else-if="store.loadError" role="alert" class="load-error">{{ store.loadError }}</p>
        <template v-else-if="store.hasInitialized">
          <ion-list inset lines="none" class="context-list" data-testid="expense-context-list" aria-label="Expense context">
            <ion-item id="context-sheet-trigger" button :detail="true" data-testid="expense-context" :aria-invalid="store.errors.context ? 'true' : undefined" :aria-describedby="store.errors.context ? 'expense-context-error' : undefined" @click="openSheet('context', 'context-sheet-trigger')">
              <ion-icon slot="start" :icon="peopleOutline" aria-hidden="true" />
              <ion-label class="context-list__label">{{ store.contextName || 'Choose a group or friend' }}</ion-label>
              <ion-note slot="end">{{ store.editor.groupId ? 'Change' : 'Choose' }}</ion-note>
            </ion-item>
          </ion-list>
          <p v-if="store.errors.context" id="expense-context-error" class="field-error">{{ store.errors.context }}</p>

          <section class="expense-core" aria-label="Expense details">
            <span class="expense-core__icon"><ion-icon :icon="pricetagOutline" aria-hidden="true" /></span>
            <label class="expense-core__description" for="expense-description">
              <span class="su-visually-hidden">Description</span>
              <input id="expense-description" v-model="store.editor.description" placeholder="Enter a description" autocomplete="off" :aria-invalid="store.errors.description ? 'true' : undefined" :aria-describedby="store.errors.description ? 'expense-description-error' : undefined">
              <small v-if="store.errors.description" id="expense-description-error" class="field-error">{{ store.errors.description }}</small>
            </label>
            <span class="expense-core__currency-symbol">{{ store.editor.currency }}</span>
            <label class="expense-core__amount" for="expense-amount">
              <span class="su-visually-hidden">Amount</span>
              <input id="expense-amount" v-model="store.editor.amountText" inputmode="decimal" :placeholder="currencyExponent(store.editor.currency) ? '0.00' : '0'" :aria-invalid="store.errors.amount ? 'true' : undefined" :aria-describedby="store.errors.amount ? 'expense-amount-error' : undefined">
              <small v-if="store.errors.amount" id="expense-amount-error" class="field-error">{{ store.errors.amount }}</small>
            </label>
          </section>

          <div class="paid-split-sentence" aria-label="Payer and split settings">
            <ion-button id="payer-sheet-trigger" fill="outline" shape="round" size="small" :aria-invalid="store.errors.payments ? 'true' : undefined" :aria-describedby="store.errors.payments ? 'expense-payments-error' : undefined" @click="openSheet('payers', 'payer-sheet-trigger')">{{ payerSummary }}</ion-button>
            <span>and</span>
            <ion-button id="split-sheet-trigger" fill="outline" shape="round" size="small" :aria-invalid="store.errors.split ? 'true' : undefined" :aria-describedby="store.errors.split ? 'expense-split-error' : undefined" @click="openSheet('split', 'split-sheet-trigger')">{{ splitSummary }}</ion-button>
          </div>
          <p v-if="store.errors.payments" id="expense-payments-error" class="field-error field-error--center">{{ store.errors.payments }}</p>
          <p v-if="store.errors.split" id="expense-split-error" class="field-error field-error--center">{{ store.errors.split }}</p>

          <ion-list inset lines="full" class="editor-list" data-testid="expense-options-list" aria-label="More expense options">
            <ion-item class="editor-row"><ion-icon slot="start" :icon="pricetagOutline" aria-hidden="true" /><ion-label>Category</ion-label><select id="expense-category" slot="end" v-model="store.editor.category" aria-label="Category" :aria-invalid="store.errors.category ? 'true' : undefined" :aria-describedby="store.errors.category ? 'expense-category-error' : undefined"><option value="" disabled>Choose</option><option v-for="category in categories" :key="category">{{ category }}</option></select></ion-item>
            <p v-if="store.errors.category" id="expense-category-error" class="field-error">{{ store.errors.category }}</p>
            <ion-item class="editor-row"><ion-icon slot="start" :icon="cashOutline" aria-hidden="true" /><ion-label>Currency</ion-label><select id="expense-currency" slot="end" :value="store.editor.currency" aria-label="Currency" @change="changeCurrency"><option v-for="currency in store.currencyOptions" :key="currency">{{ currency }}</option></select></ion-item>
            <ion-item class="editor-row"><ion-icon slot="start" :icon="calendarOutline" aria-hidden="true" /><ion-label>Date</ion-label><input id="expense-date" slot="end" :value="store.editor.date" type="date" aria-label="Date" :aria-invalid="store.errors.date ? 'true' : undefined" :aria-describedby="store.errors.date ? 'expense-date-error' : undefined" @input="changeDate"></ion-item>
            <p v-if="store.errors.date" id="expense-date-error" class="field-error">{{ store.errors.date }}</p>
            <ion-item id="participant-sheet-trigger" button :detail="true" class="editor-row" :aria-invalid="store.errors.participants ? 'true' : undefined" :aria-describedby="store.errors.participants ? 'expense-participants-error' : undefined" @click="openSheet('participants', 'participant-sheet-trigger')"><ion-icon slot="start" :icon="peopleOutline" aria-hidden="true" /><ion-label>Split with</ion-label><ion-note slot="end" class="editor-row__note">{{ store.editor.participants.length }} participant{{ store.editor.participants.length === 1 ? '' : 's' }}</ion-note></ion-item>
            <p v-if="store.errors.participants" id="expense-participants-error" class="field-error">{{ store.errors.participants }}</p>
            <ion-item id="receipt-sheet-trigger" button :detail="true" class="editor-row" :aria-label="hasReceipt ? 'Review attached receipt' : 'Add receipt image'" :aria-invalid="store.errors.receipt ? 'true' : undefined" :aria-describedby="store.errors.receipt ? 'expense-receipt-error' : undefined" @click="openReceipt"><ion-icon slot="start" :icon="cameraOutline" aria-hidden="true" /><ion-label>Receipt</ion-label><ion-note slot="end" class="editor-row__note">{{ hasReceipt ? `${store.editor.attachmentRefs.length} attached` : 'Add receipt' }}</ion-note></ion-item>
            <p v-if="store.errors.receipt" id="expense-receipt-error" class="field-error">{{ store.errors.receipt }}</p>
            <input id="expense-receipt-input" ref="receiptInput" hidden tabindex="-1" aria-hidden="true" type="file" accept="image/jpeg,image/png,image/heic,image/webp" @change="selectReceipt">
            <ion-item class="editor-row editor-row--notes"><ion-icon slot="start" :icon="documentTextOutline" aria-hidden="true" /><label class="editor-notes-field" for="expense-notes"><span>Notes</span><textarea id="expense-notes" v-model="store.editor.notes" rows="2" placeholder="Optional details"></textarea></label></ion-item>
            <ion-item id="recurrence-sheet-trigger" button :detail="true" class="editor-row" :aria-invalid="store.errors.recurrence ? 'true' : undefined" :aria-describedby="store.errors.recurrence ? 'expense-recurrence-error' : undefined" @click="openSheet('recurrence', 'recurrence-sheet-trigger')"><ion-icon slot="start" :icon="repeatOutline" aria-hidden="true" /><ion-label>Repeat</ion-label><ion-note slot="end" class="editor-row__note">{{ recurrenceSummary }}</ion-note></ion-item>
            <p v-if="store.errors.recurrence" id="expense-recurrence-error" class="field-error">{{ store.errors.recurrence }}</p>
          </ion-list>

          <p v-if="store.notice" role="status" aria-live="polite" class="editor-notice">{{ store.notice }}</p>
          <p ref="errorSummary" v-if="store.errorSummary" data-testid="expense-error-summary" class="error-summary" role="alert" aria-live="assertive" tabindex="-1">{{ store.errorSummary }}</p>
        </template>
      </main>

      <ion-modal :is-open="Boolean(store.activeSheet)" :presenting-element="presentingElement" :can-dismiss="modalCanDismiss" @input="markSheetDirty" @change="markSheetDirty" @did-dismiss="closeSheet">
        <ion-content class="expense-sheet-host">
          <context-sheet v-if="store.activeSheet === 'context'" class="expense-sheet--ionic-content" :model-value="store.editor.groupId" :groups="store.availableGroups" @apply="applyContext" @cancel="closeSheet" />
          <payer-sheet v-else-if="store.activeSheet === 'payers'" class="expense-sheet--ionic-content" :model-value="store.editor.payments" :members="store.members" :currency="store.editor.currency" :total-minor-amount="totalMinorAmount" :reimbursement="isReimbursement" @apply="applyPayers" @cancel="closeSheet" />
          <participant-sheet v-else-if="store.activeSheet === 'participants'" class="expense-sheet--ionic-content" :model-value="store.editor.participants" :members="store.members" @apply="applyParticipants" @cancel="closeSheet" />
          <split-editor v-else-if="store.activeSheet === 'split'" class="expense-sheet--ionic-content" :model-value="store.editor.split" :participants="store.members.filter((member) => store.editor.participants.includes(member.id))" :currency="store.editor.currency" :total-minor-amount="totalMinorAmount" @apply="applySplit" @cancel="closeSheet" @dirty="markSheetDirty" />
          <recurrence-sheet v-else-if="store.activeSheet === 'recurrence'" class="expense-sheet--ionic-content" :model-value="store.editor.recurrence" :occurrence-edit-scope="store.editor.occurrenceEditScope" :is-recurring-instance="Boolean(store.recurringTemplateId)" :date="store.editor.date" @apply="applyRecurrence" @cancel="closeSheet" @dirty="markSheetDirty" />
          <receipt-review v-else-if="store.activeSheet === 'receipt'" class="expense-sheet--ionic-content" :model-value="receiptItems" :members="store.members.filter((member) => store.editor.participants.includes(member.id))" :currency="store.editor.currency" :total-minor-amount="totalMinorAmount" :provider-message="store.receiptMessage" :image-url="receiptPreviewUrl" :durability="store.receiptDurability" @confirm="confirmReceipt" @cancel="closeSheet" @dirty="markSheetDirty" />
        </ion-content>
      </ion-modal>
    </ion-content>
  </ion-page>
</template>

<style scoped>
.expense-editor-page { --su-editor-gutter: 18px; }
.expense-editor__header ion-toolbar { --min-height: 54px; --border-color: color-mix(in srgb, var(--su-divider) 55%, transparent); }
.expense-editor__header ion-title { font-size: 1rem; font-weight: 650; }
.expense-editor__header ion-button { min-width: 64px; min-height: 44px; margin: 0; text-transform: none; }
.expense-editor { min-height: 100%; padding: 10px 0 calc(26px + env(safe-area-inset-bottom)); background: var(--su-surface); }
.context-list, .editor-list { overflow: hidden; margin-inline: var(--su-editor-gutter); padding: 0; border: 1px solid color-mix(in srgb, var(--su-divider) 72%, transparent); border-radius: 13px; background: var(--su-surface); box-shadow: 0 1px 3px rgb(40 31 93 / 7%); }
.context-list { margin-block: 0; }
.context-list ion-item { --min-height: 50px; --padding-start: 12px; --inner-padding-end: 12px; --background: var(--su-surface); font-size: 0.95rem; }
.context-list ion-icon { margin-inline-end: 11px; color: var(--ion-color-primary); font-size: 1.2rem; }
.context-list__label { min-width: 0; font-weight: 600; overflow-wrap: anywhere; white-space: normal; }
.context-list ion-note { color: var(--ion-color-medium); font-size: 0.78rem; }
.expense-core { display: grid; grid-template-columns: minmax(46px, max-content) minmax(0, 1fr); gap: 14px 10px; align-items: end; width: min(100%, 278px); margin: 28px auto 20px; }
.expense-core__icon, .expense-core__currency-symbol { display: grid; box-sizing: border-box; width: max-content; min-width: 46px; min-height: 46px; place-items: center; padding: 0.25rem; border: 1px solid color-mix(in srgb, var(--su-divider) 70%, transparent); border-radius: 8px; background: color-mix(in srgb, var(--su-lilac) 32%, var(--su-surface)); color: var(--ion-color-primary); font-size: 1.38rem; font-weight: 650; line-height: 1.15; overflow-wrap: anywhere; box-shadow: 0 1px 2px rgb(40 31 93 / 8%); }
.expense-core input { width: 100%; min-height: 46px; border: 0; border-bottom: 1px solid var(--ion-color-medium); border-radius: 0; background: transparent; color: inherit; font: inherit; }
.expense-core__description input { font-size: 1.08rem; }
.expense-core__amount input { border-color: var(--ion-color-primary); font-size: 2rem; font-weight: 520; letter-spacing: -0.03em; }
.paid-split-sentence { display: flex; flex-wrap: wrap; align-items: center; justify-content: center; gap: 6px; margin: 0 auto 24px; font-size: 0.86rem; }
.paid-split-sentence ion-button { --border-color: color-mix(in srgb, var(--su-divider) 82%, transparent); --border-radius: 10px; --color: var(--ion-text-color); --padding-start: 12px; --padding-end: 12px; min-height: 44px; margin: 0; font-size: 0.84rem; font-weight: 500; letter-spacing: 0; text-transform: none; }
.editor-list { margin-block: 0; }
.editor-row { --min-height: 52px; --padding-start: 12px; --inner-padding-end: 12px; --background: var(--su-surface); --border-color: color-mix(in srgb, var(--su-divider) 78%, transparent); color: inherit; font-size: 0.94rem; }
.editor-row ion-icon[slot="start"] { width: 22px; margin-inline-end: 11px; color: var(--ion-color-primary); font-size: 1.15rem; }
.editor-row ion-label { min-width: 0; margin-block: 13px; color: var(--ion-text-color); }
.editor-row select, .editor-row input[type="date"] { width: auto; min-width: 0; min-height: 44px; max-width: 54%; margin-inline-start: 12px; border: 0; background: transparent; color: var(--ion-color-medium); font: inherit; text-align: end; }
.editor-row__note { min-width: 0; max-width: 46%; margin-inline-start: 8px; color: var(--ion-color-medium); font-size: 0.78rem; overflow-wrap: anywhere; text-align: end; white-space: normal; }
.editor-row--notes { --min-height: 88px; align-items: flex-start; }
.editor-row--notes ion-icon[slot="start"] { margin-top: 15px; }
.editor-notes-field { display: grid; min-width: 0; flex: 1; gap: 3px; padding-block: 11px 8px; }
.editor-notes-field > span { font-size: 0.94rem; }
.editor-notes-field textarea { width: 100%; min-height: 44px; padding: 6px 0 0; border: 0; background: transparent; color: var(--ion-color-medium); font: inherit; line-height: 1.35; resize: none; text-align: start; }
.field-error { margin: 5px var(--su-editor-gutter) 0; color: var(--ion-color-danger); font-size: 0.76rem; }
.field-error--center { text-align: center; }
.error-summary, .load-error { margin: 14px 0; padding: 12px; border: 1px solid color-mix(in srgb, var(--ion-color-danger) 36%, transparent); border-radius: 11px; background: color-mix(in srgb, var(--ion-color-danger) 8%, var(--su-surface)); color: var(--ion-color-danger); font-size: 0.86rem; }
.editor-notice { color: var(--ion-color-primary); font-size: 0.84rem; }
.load-status { padding: 32px 0; color: var(--ion-color-medium); text-align: center; }
@media (prefers-reduced-motion: reduce) { .expense-editor * { scroll-behavior: auto; } }
</style>
