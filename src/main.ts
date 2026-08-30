import { createApp } from 'vue'
import { IonicVue } from '@ionic/vue'
import { createPinia, disposePinia } from 'pinia'
import App from './App.vue'
import { createRouteAnimation } from './app/navigation'
import { createAppRouter } from './app/router'
import { createRepositorySessionRuntime } from './data/repositoryFactory'
import { createAppSession, createAppSessionCoordinator, createAppSessionMountHost, setActiveAppSession } from './data/session'
import './app/theme.css'

const repositoryRuntime = await createRepositorySessionRuntime()
const mountHost = createAppSessionMountHost({
  setSession: setActiveAppSession,
  async mount(session) {
    const app = createApp(App)
    const pinia = createPinia()
    const router = createAppRouter()
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
const unsubscribePrincipal = await repositoryRuntime.principals.listen((principal) => sessionCoordinator.transition(principal))

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    unsubscribePrincipal()
    void sessionCoordinator.stop()
  })
}
