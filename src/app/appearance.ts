export type AppearancePreference = 'system' | 'light' | 'dark'

export interface AppearanceController {
  readonly preference: AppearancePreference
  setPreference(preference: AppearancePreference): void
  destroy(): void
}

export interface AppearanceControllerOptions {
  readonly document?: Document
  readonly storage?: Pick<Storage, 'getItem' | 'setItem'>
  readonly matchMedia?: (query: string) => Pick<MediaQueryList, 'matches' | 'addEventListener' | 'removeEventListener'>
}

export const APPEARANCE_STORAGE_KEY = 'split-unwise:appearance:v1'

let sharedController: AppearanceController | undefined

export function bootstrapAppearance(options: AppearanceControllerOptions = {}): AppearanceController {
  const documentRef = options.document ?? document
  const storage = options.storage ?? browserStorage()
  const media = options.matchMedia ?? ((query) => window.matchMedia(query))
  const colorQuery = media('(prefers-color-scheme: dark)')
  const contrastQuery = media('(prefers-contrast: more)')
  let preference = readAppearancePreference(storage)
  let colorListening = false

  const apply = () => {
    const dark = preference === 'dark' || (preference === 'system' && colorQuery.matches)
    const contrast = contrastQuery.matches
    const root = documentRef.documentElement
    root.classList.toggle('ion-palette-dark', dark && !contrast)
    root.classList.toggle('ion-palette-high-contrast', contrast && !dark)
    root.classList.toggle('ion-palette-high-contrast-dark', contrast && dark)
    root.classList.toggle('su-theme-dark', dark)
    root.classList.toggle('su-contrast-more', contrast)
    root.dataset.appearance = preference
    root.style.colorScheme = dark ? 'dark' : 'light'
    const meta = documentRef.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
    meta?.setAttribute('content', dark ? (contrast ? '#000000' : '#17152A') : '#F8F7FF')
  }
  const colorChanged = () => apply()
  const contrastChanged = () => apply()
  const syncColorListener = () => {
    if (preference === 'system' && !colorListening) { colorQuery.addEventListener('change', colorChanged); colorListening = true }
    if (preference !== 'system' && colorListening) { colorQuery.removeEventListener('change', colorChanged); colorListening = false }
  }

  contrastQuery.addEventListener('change', contrastChanged)
  syncColorListener()
  apply()
  const controller: AppearanceController = {
    get preference() { return preference },
    setPreference(next) {
      if (!isAppearancePreference(next)) throw new Error('Appearance must be system, light, or dark')
      preference = next
      try { storage?.setItem(APPEARANCE_STORAGE_KEY, next) } catch { /* device storage is optional */ }
      syncColorListener()
      apply()
    },
    destroy() {
      if (colorListening) colorQuery.removeEventListener('change', colorChanged)
      contrastQuery.removeEventListener('change', contrastChanged)
      colorListening = false
    },
  }
  return controller
}

export function getAppearanceController(): AppearanceController {
  return sharedController ??= bootstrapAppearance()
}

export function installAppearanceController(controller: AppearanceController): void {
  sharedController?.destroy()
  sharedController = controller
}

export function readAppearancePreference(storage: Pick<Storage, 'getItem'> | undefined = browserStorage()): AppearancePreference {
  try {
    const value = storage?.getItem(APPEARANCE_STORAGE_KEY)
    return isAppearancePreference(value) ? value : 'system'
  } catch { return 'system' }
}

function isAppearancePreference(value: unknown): value is AppearancePreference { return value === 'system' || value === 'light' || value === 'dark' }
function browserStorage(): Storage | undefined { try { return typeof localStorage === 'undefined' ? undefined : localStorage } catch { return undefined } }
