import { createApp } from 'vue'
import { IonicVue } from '@ionic/vue'
import App from './App.vue'
import { createAppRouter } from './app/router'
import './app/theme.css'

const app = createApp(App)
const router = createAppRouter()

app.use(IonicVue, { mode: 'ios' })
app.use(router)

router.isReady().then(() => {
  app.mount('#app')
})
