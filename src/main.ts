import { createApp } from 'vue'
import { IonicVue } from '@ionic/vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import { createRouteAnimation } from './app/navigation'
import { createAppRouter } from './app/router'
import './app/theme.css'

const app = createApp(App)
const router = createAppRouter()

app.use(IonicVue, { mode: 'ios', navAnimation: createRouteAnimation() })
app.use(createPinia())
app.use(router)

router.isReady().then(() => {
  app.mount('#app')
})
