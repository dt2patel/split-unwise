/**
 * Native stand-ins for the Ionic controls used by the staged expense sheets. Each forwards the sheet's attributes to
 * the element it renders and re-emits the Ionic event (ionChange/ionInput) that the real component would dispatch.
 */
export const ionicSheetStubs = {
  IonHeader: { template: '<header data-ionic-header><slot /></header>' },
  IonToolbar: { template: '<div data-ionic-toolbar><slot /></div>' },
  IonTitle: { template: '<div data-ionic-title><slot /></div>' },
  IonButtons: { template: '<div><slot /></div>' },
  IonButton: {
    props: ['disabled', 'strong', 'fill', 'size'], emits: ['click'],
    template: '<button type="button" :disabled="disabled" :data-strong="strong" :data-fill="fill" :data-size="size" @click="$emit(\'click\', $event)"><slot /></button>',
  },
  IonContent: { template: '<section data-ionic-content><slot /></section>' },
  IonList: { props: { inset: Boolean, lines: String }, template: '<div data-ionic-list :data-inset="String(inset)" :data-lines="lines"><slot /></div>' },
  IonItem: { template: '<div data-ionic-item><slot /></div>' },
  IonLabel: { template: '<span><slot /></span>' },
  IonRadioGroup: {
    name: 'IonRadioGroup', props: ['value'], emits: ['ionChange'],
    // Like Ionic, report a click (or VTU's setValue change) on a radio only when it changes the group value.
    methods: {
      select(this: { value: unknown; $emit: (event: 'ionChange', payload: unknown) => void }, event: Event): void {
        const radio = event.target
        if (radio instanceof HTMLInputElement && radio.type === 'radio' && radio.value !== this.value) this.$emit('ionChange', { detail: { value: radio.value } })
      },
    },
    template: '<div role="radiogroup" @click="select" @change="select"><slot /></div>',
  },
  IonRadio: {
    name: 'IonRadio', inheritAttrs: false, props: ['value', 'justify'],
    template: '<label><input type="radio" v-bind="$attrs" :value="value"><slot /></label>',
  },
  IonCheckbox: {
    name: 'IonCheckbox', inheritAttrs: false, props: ['checked', 'justify', 'labelPlacement'], emits: ['ionChange'],
    template: '<label><input type="checkbox" v-bind="$attrs" :checked="checked" @change="$emit(\'ionChange\', { detail: { checked: $event.target.checked } })"><slot /></label>',
  },
  IonInput: {
    name: 'IonInput', props: ['value', 'modelValue', 'label', 'labelPlacement', 'inputmode'], emits: ['ionInput', 'update:modelValue'],
    template: '<input :value="modelValue ?? value" :inputmode="inputmode" @input="$emit(\'update:modelValue\', $event.target.value); $emit(\'ionInput\', { detail: { value: $event.target.value } })">',
  },
  IonSegment: { name: 'IonSegment', props: ['value', 'selectOnFocus'], emits: ['ionChange'], template: '<div role="group"><slot /></div>' },
  IonSegmentButton: { props: ['value'], emits: ['click'], template: '<button type="button" :value="value" @click="$emit(\'click\', $event)"><slot /></button>' },
}
