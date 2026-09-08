import { createApp } from 'vue'
import App from './App.vue'
import { createAppRouter } from './app/router'
import './shared/styles/base.css'
import './shared/styles/layout.css'
import './shared/styles/components.css'

createApp(App).use(createAppRouter()).mount('#app')
