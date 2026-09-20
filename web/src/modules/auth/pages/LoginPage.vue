<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { authSession, loginWithEmail, refreshAuthSession } from '../session'
import { describeApiFailure } from '../../../shared/utils/errorMessage'

const router = useRouter()
const route = useRoute()
const email = ref('recruiter@smartrecruit.local')
const password = ref('recruiter123')
const error = ref('')
const submitting = ref(false)

async function submit() {
  if (submitting.value) return
  if (!email.value.trim() || !password.value) {
    error.value = '请输入邮箱和密码'
    return
  }
  submitting.value = true
  error.value = ''
  try {
    await loginWithEmail(email.value.trim(), password.value)
    const redirect = typeof route.query.redirect === 'string' ? route.query.redirect : '/'
    await router.push(redirect)
  } catch (cause) {
    error.value = describeApiFailure(cause, '登录失败').message
  } finally {
    submitting.value = false
  }
}

onMounted(async () => {
  if (!authSession.ready) await refreshAuthSession()
  if (authSession.user) await router.push('/')
})
</script>

<template>
  <main class="login-shell">
    <section class="login-panel">
      <div class="brand"><span class="brand-mark">龙道</span><span><b>龙道招聘系统</b><small>全流程智能招聘</small></span></div>
      <h1>登录招聘管理平台</h1>
      <p class="list-muted">当前阶段提供本地开发账号登录，生产环境将接入企业 SSO 与更严格密码策略。</p>
      <div v-if="error" class="error-note" role="alert">{{ error }}</div>
      <div class="form-grid">
        <div class="form-field">
          <label for="login-email">邮箱</label>
          <input id="login-email" v-model="email" type="email" autocomplete="username" placeholder="recruiter@smartrecruit.local" />
        </div>
        <div class="form-field">
          <label for="login-password">密码</label>
          <input id="login-password" v-model="password" type="password" autocomplete="current-password" placeholder="recruiter123" />
        </div>
      </div>
      <div class="login-hint">开发账号：recruiter@smartrecruit.local / recruiter123</div>
      <div class="inline-actions" style="margin-top: 14px">
        <button class="btn btn-primary" type="button" :disabled="submitting || authSession.loading" @click="submit">{{ submitting ? '登录中...' : '登录' }}</button>
      </div>
    </section>
  </main>
</template>

<style scoped>
.login-shell { min-height: 100vh; display: grid; place-items: center; padding: 28px; background: linear-gradient(135deg, #0f172a 0%, #1e3a8a 100%); }
.login-panel { width: min(460px, 100%); background: #fff; border-radius: 18px; box-shadow: 0 18px 50px rgb(15 23 42 / 0.32); padding: 26px; }
.brand { display: flex; align-items: center; gap: 10px; margin-bottom: 22px; }
.brand-mark { display: inline-grid; place-items: center; width: 38px; height: 38px; border-radius: 12px; background: #2563eb; color: #fff; font-weight: 800; }
.brand b { display: block; color: #0f172a; font-size: 18px; }
.brand small { display: block; color: var(--muted); font-size: 11px; }
h1 { font-size: 22px; margin: 0 0 8px; }
.list-muted { color: var(--muted); font-size: 12px; margin: 0 0 16px; }
.login-hint { margin-top: 10px; padding: 8px 10px; background: #f8fafc; border: 1px dashed #cbd5e1; border-radius: 8px; color: #475569; font-size: 12px; }
.error-note { margin-bottom: 12px; }
</style>
