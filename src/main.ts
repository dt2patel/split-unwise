import { createApp } from 'vue'
import { IonicVue } from '@ionic/vue'
import { createPinia, disposePinia } from 'pinia'
import App from './App.vue'
import { createRouteAnimation } from './app/navigation'
import { createAppRouter } from './app/router'
import { createRepositorySessionRuntime } from './data/repositoryFactory'
import { createAppSession, createAppSessionCoordinator, createAppSessionMountHost, setActiveAppSession } from './data/session'
import { setAuthService } from './features/auth/authService'
import './app/theme.css'

const repositoryRuntime = await createRepositorySessionRuntime()
setAuthService(repositoryRuntime.auth)
let independentApp: ReturnType<typeof createApp> | undefined

async function mountIndependentSurface(): Promise<void> {
  if (independentApp) return
  const app = createApp(App)
  const pinia = createPinia()
  const router = createAppRouter({ auth: repositoryRuntime.auth })
  app.use(IonicVue, { mode: 'ios', navAnimation: createRouteAnimation() })
  app.use(pinia)
  app.use(router)
  await router.isReady()
  app.mount('#app')
  independentApp = app
}

function unmountIndependentSurface(): void {
  independentApp?.unmount()
  independentApp = undefined
}

await mountIndependentSurface()
const mountHost = createAppSessionMountHost({
  setSession: setActiveAppSession,
  async mount(session) {
    unmountIndependentSurface()
    const app = createApp(App)
    const pinia = createPinia()
    const router = createAppRouter({ auth: repositoryRuntime.auth })
    let didMount = false

    app.use(IonicVue, { mode: 'ios', navAnimation: createRouteAnimation() })
    app.use(pinia)
    app.use(router)

    await router.isReady()
    if (session.isActive) {
      app.mount('#app')
      didMount = true
    }
    return {
      unmount() { if (didMount) app.unmount() },
      disposeFeatureStores() { disposePinia(pinia) },
    }
  },
})
const sessionCoordinator = createAppSessionCoordinator({
  createSession: (principal) => createAppSession({
    principal,
    repository: repositoryRuntime.createRepository(principal),
  }),
  resetFeatureStores: mountHost.resetFeatureStores,
  activateSession: mountHost.activateSession,
})
const unsubscribePrincipal = await repositoryRuntime.principals.listen(async (principal) => {
  try {
    await sessionCoordinator.transition(principal)
    if (!principal) await mountIndependentSurface()
  } catch (error: unknown) {
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
