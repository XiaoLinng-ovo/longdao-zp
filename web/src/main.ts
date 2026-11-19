import { createApp } from 'vue'
import App from './App.vue'
import { createAppRouter, installAuthGuard } from './app/router'
import './shared/styles/base.css'
import './shared/styles/layout.css'
import './shared/styles/components.css'

const router = createAppRouter(); installAuthGuard(router); createApp(App).use(router).mount('#app')
