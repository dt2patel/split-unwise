import { computed, onMounted, onUnmounted, ref } from 'vue'

export type NetworkStatus = 'online' | 'offline' | 'unknown'

export interface NetworkCapabilities {
  readonly window?: Pick<Window, 'addEventListener' | 'removeEventListener'>
  readonly navigator?: Pick<Navigator, 'onLine'>
}

/** Connectivity guides retry behavior only; it is never proof that a write completed. */
export function useNetwork(capabilities?: NetworkCapabilities) {
  const browser = capabilities ?? browserCapabilities()
  const status = ref<NetworkStatus>(readStatus(browser.navigator))
  const markOnline = () => { status.value = 'online' }
  const markOffline = () => { status.value = 'offline' }

  onMounted(() => {
    browser.window?.addEventListener('online', markOnline)
    browser.window?.addEventListener('offline', markOffline)
  })
  onUnmounted(() => {
    browser.window?.removeEventListener('online', markOnline)
    browser.window?.removeEventListener('offline', markOffline)
  })

  const canAttemptNetwork = computed(() => status.value === 'online')
  return { status, canAttemptNetwork }
}

function readStatus(browserNavigator: NetworkCapabilities['navigator']): NetworkStatus {
  if (!browserNavigator || typeof browserNavigator.onLine !== 'boolean') return 'unknown'
  return browserNavigator.onLine ? 'online' : 'offline'
}

function browserCapabilities(): NetworkCapabilities {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return {}
  return { window, navigator }
}
