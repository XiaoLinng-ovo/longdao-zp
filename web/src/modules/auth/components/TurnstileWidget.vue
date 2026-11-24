<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

interface TurnstileApi {
  render(container: HTMLElement, options: Record<string, unknown>): string
  reset(widgetId?: string): void
  remove(widgetId?: string): void
}

declare global {
  interface Window {
    turnstile?: TurnstileApi
  }
}

const props = withDefaults(defineProps<{
  siteKey: string
  action?: string
  resetKey?: number
}>(), {
  action: 'managed',
  resetKey: 0,
})

const emit = defineEmits<{
  'update:modelValue': [token: string]
  expired: []
  error: [message: string]
}>()

const container = ref<HTMLElement>()
let widgetId: string | undefined
let loadPromise: Promise<TurnstileApi> | undefined

function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile)
  if (loadPromise) return loadPromise
  loadPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>('script[data-cloudflare-turnstile]')
    const script = existing ?? document.createElement('script')
    const loaded = () => window.turnstile ? resolve(window.turnstile) : reject(new Error('Turnstile 初始化失败'))
    script.addEventListener('load', loaded, { once: true })
    script.addEventListener('error', () => reject(new Error('人机验证加载失败')), { once: true })
    if (!existing) {
      script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
      script.async = true
      script.defer = true
      script.dataset.cloudflareTurnstile = 'true'
      document.head.appendChild(script)
    }
  })
  return loadPromise
}

async function renderWidget() {
  if (!props.siteKey || !container.value || widgetId) return
  try {
    const api = await loadTurnstile()
    await nextTick()
    if (!container.value || widgetId) return
    widgetId = api.render(container.value, {
      sitekey: props.siteKey,
      action: props.action,
      callback: (token: string) => emit('update:modelValue', token),
      'expired-callback': () => {
        emit('update:modelValue', '')
        emit('expired')
      },
      'error-callback': () => {
        emit('update:modelValue', '')
        emit('error', '人机验证暂时不可用，请刷新后重试')
      },
    })
  } catch (cause) {
    emit('error', cause instanceof Error ? cause.message : '人机验证加载失败')
  }
}

function resetWidget() {
  if (widgetId) window.turnstile?.reset(widgetId)
  emit('update:modelValue', '')
}

watch(() => props.siteKey, async () => {
  if (widgetId) window.turnstile?.remove(widgetId)
  widgetId = undefined
  await nextTick()
  await renderWidget()
})
watch(() => props.resetKey, resetWidget)

onMounted(renderWidget)
onBeforeUnmount(() => {
  if (widgetId) window.turnstile?.remove(widgetId)
})
</script>

<template>
  <div v-if="siteKey" ref="container" class="turnstile-widget" aria-label="人机验证"></div>
</template>

<style scoped>
.turnstile-widget { min-height: 65px; display: flex; justify-content: center; }
</style>
