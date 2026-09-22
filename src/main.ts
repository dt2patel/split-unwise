import { createApp } from 'vue'
import { IonicVue } from '@ionic/vue'
import { createPinia, disposePinia } from 'pinia'
import App from './App.vue'
import { browserOwnsBackGesture, createRouteAnimation } from './app/navigation'
import { Capacitor } from '@capacitor/core'
import { createAppRouter } from './app/router'
import { createRepositorySessionRuntime } from './data/repositoryFactory'
import { createAppSession, createAppSessionCoordinator, createAppSessionMountHost, setActiveAppSession } from './data/session'
import { appPrincipalKey } from './data/principal'
import { createIndexedDbReceiptStore } from './data/receipts'
import { createFirebaseReceiptProvider } from './data/firebaseReceiptProvider'
import { createOnDeviceReceiptProvider } from './data/onDeviceReceiptProvider'
import { setAuthService } from './features/auth/authService'
import { registerPwa } from './app/pwa'
import { forgetFirebaseProfileReady } from './data/profileReady'
import { installWebMcp } from './app/webmcp'
import { markLaunch } from './app/perfMarks'
import './app/theme.css'

// In a Safari tab the browser owns edge-swipe back; Ionic's swipe-back only belongs in the home-screen app and native shell.
const ionicConfig = { mode: 'ios' as const, navAnimation: createRouteAnimation(), swipeBackEnabled: !browserOwnsBackGesture(Capacitor.isNativePlatform()) }
const repositoryRuntime = await createRepositorySessionRuntime()
markLaunch('runtime-ready')
setAuthService(repositoryRuntime.auth)
let independentApp: ReturnType<typeof createApp> | undefined

async function mountIndependentSurface(): Promise<void> {
  if (independentApp) return
  const app = createApp(App)
  const pinia = createPinia()
  const router = createAppRouter({ auth: repositoryRuntime.auth })
  app.use(IonicVue, ionicConfig)
  app.use(pinia)
  app.use(router)
  await router.isReady()
  app.mount('#app')
  markLaunch('app-mounted')
  independentApp = app
}

function unmountIndependentSurface(): void {
  independentApp?.unmount()
  independentApp = undefined
}

void registerPwa()
const mountHost = createAppSessionMountHost({
  setSession: setActiveAppSession,
  async mount(session) {
    unmountIndependentSurface()
    const app = createApp(App)
    const pinia = createPinia()
    const router = createAppRouter({ auth: repositoryRuntime.auth })
    let didMount = false
    let disposeWebMcp: (() => void) | undefined

    app.use(IonicVue, ionicConfig)
    app.use(pinia)
    app.use(router)

    await router.isReady()
    if (session.isActive) {
      app.mount('#app')
      markLaunch('app-mounted')
      didMount = true
      disposeWebMcp = await installWebMcp({ router, session })
    }
    return {
      unmount() {
        disposeWebMcp?.()
        disposeWebMcp = undefined
        if (didMount) app.unmount()
      },
      disposeFeatureStores() { disposePinia(pinia) },
    }
  },
})
const sessionCoordinator = createAppSessionCoordinator({
  createSession: (principal) => {
    const receipts = createIndexedDbReceiptStore({ namespace: appPrincipalKey(principal) })
    const uploadProvider = principal.mode === 'firebase' && repositoryRuntime.configuration.kind === 'firebase'
      && repositoryRuntime.configuration.capabilities.storage === 'available'
      && repositoryRuntime.configuration.capabilities.functions === 'available'
      ? createFirebaseReceiptProvider(repositoryRuntime.configuration.firebase, receipts)
      : undefined
    return createAppSession({
      principal,
      repository: repositoryRuntime.createRepository(principal),
      receipts,
      receiptProvider: createOnDeviceReceiptProvider(receipts, { ...(uploadProvider ? { uploadProvider } : {}) }),
    })
  },
  resetFeatureStores: mountHost.resetFeatureStores,
  activateSession: mountHost.activateSession,
})
const unsubscribePrincipal = await repositoryRuntime.principals.listen(async (principal) => {
  markLaunch('principal-ready')
  try {
    await sessionCoordinator.transition(principal)
    markLaunch('session-ready')
    if (!principal) await mountIndependentSurface()
  } catch (error: unknown) {
    if (error instanceof Error && error.message === 'Current Firebase user profile is missing') forgetFirebaseProfileReady()
    repositoryRuntime.auth.reportSessionError?.(error instanceof Error && error.message === 'Current Firebase user profile is missing'
      ? 'Your signed-in account is missing its Split Unwise profile. Secure profile setup is not complete yet.'
      : error instanceof Error ? error.message : 'Your account could not be opened.')
    await mountIndependentSurface()
  }
})

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    unsubscribePrincipal()
    repositoryRuntime.auth.dispose()
    unmountIndependentSurface()
    void sessionCoordinator.stop()
  })
}
