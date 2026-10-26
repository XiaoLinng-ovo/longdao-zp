<script setup lang="ts">
import { ref } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { register } from '../api'
import { loginWithEmail, switchWorkspace } from '../session'
import { describeApiFailure } from '../../../shared/utils/errorMessage'

const router = useRouter()
const route = useRoute()
const companyName = ref('')
const name = ref('')
const email = ref('')
const phone = ref('')
const password = ref('')
const confirmPassword = ref('')
const error = ref('')
const submitting = ref(false)

async function submit() {
  if (submitting.value) return
  error.value = ''
  if (!companyName.value.trim() || !name.value.trim() || !email.value.trim() || !password.value) { error.value = '请填写企业名称、姓名、邮箱和密码'; return }
  if (companyName.value.trim().length < 2) { error.value = '企业名称至少需要 2 个字符'; return }
  if (password.value.length < 8) { error.value = '密码至少需要 8 个字符'; return }
  if (password.value !== confirmPassword.value) { error.value = '两次输入的密码不一致'; return }
  submitting.value = true
  try {
    const registered = await register({
      companyName: companyName.value.trim(),
      name: name.value.trim(),
      email: email.value.trim(),
      password: password.value,
      ...(phone.value.trim() ? { phone: phone.value.trim() } : {}),
    })
    const workspaces = await loginWithEmail(email.value.trim(), password.value)
    const redirect = typeof route.query.redirect === 'string' && /^\/workspaces(?:[?#]|$)/.test(route.query.redirect) ? route.query.redirect : undefined
    if (redirect) {
      await router.push(redirect)
    } else if (workspaces.length === 1 && workspaces[0]?.id === registered.workspace.id) {
      await switchWorkspace(registered.workspace.id)
      await router.push('/')
    } else {
      await router.push('/workspaces')
    }
  } catch (cause) {
    error.value = describeApiFailure(cause, '注册失败').message
  } finally { submitting.value = false }
}
</script>

<template>
  <main class="register-shell">
    <section class="register-card">
      <div class="register-brand"><span>龙道</span><div><b>注册企业账号</b><small>注册后自动创建企业并成为所有者</small></div></div>
      <div class="register-heading"><h1>开始使用智能招聘</h1><p>填写企业和管理员信息即可开通 14 天试用。注册完成后，你将直接进入企业工作台。</p></div>
      <div v-if="error" class="register-error" role="alert">{{ error }}</div>
      <form class="register-form" @submit.prevent="submit">
        <label>企业名称<input v-model="companyName" autocomplete="organization" placeholder="例如：龙道科技" /></label>
        <label>姓名<input v-model="name" autocomplete="name" placeholder="请输入姓名" /></label>
        <label>邮箱<input v-model="email" type="email" autocomplete="email" placeholder="name@company.com" /></label>
        <label>手机号（可选）<input v-model="phone" type="tel" autocomplete="tel" placeholder="用于账号支持" /></label>
        <label>密码<input v-model="password" type="password" autocomplete="new-password" placeholder="至少 8 个字符" /></label>
        <label>确认密码<input v-model="confirmPassword" type="password" autocomplete="new-password" placeholder="再次输入密码" /></label>
        <button class="register-submit" type="submit" :disabled="submitting">{{ submitting ? '注册中...' : '注册并继续' }}</button>
      </form>
      <div class="register-flow"><span>填写企业信息</span><i>→</i><span>自动创建企业</span><i>→</i><span>邀请同事加入</span></div>
      <router-link class="back-login" :to="{ name: 'login', query: route.query.redirect ? { redirect: route.query.redirect } : {} }">已有账号？返回登录</router-link>
    </section>
  </main>
</template>

<style scoped>
.register-shell { min-height: 100vh; display: grid; place-items: center; padding: 28px 16px; background: radial-gradient(circle at 20% 10%, #e5f8f4, transparent 34%), linear-gradient(135deg, #f5fbfc, #edf4fb); }
.register-card { width: min(100%, 510px); padding: 31px; border: 1px solid rgba(151, 194, 209, .35); border-radius: 22px; background: rgba(255,255,255,.94); box-shadow: 0 20px 55px rgba(59, 101, 130, .14); }
.register-brand { display: flex; align-items: center; gap: 11px; color: #27546c; }.register-brand > span { display:grid; place-items:center; width:39px; height:39px; border-radius: 12px; background: linear-gradient(135deg,#54c3b8,#5e91e4); color:#fff; font-weight: 800; }.register-brand div { display:grid; gap:3px; }.register-brand b { font-size:15px; }.register-brand small { color:#88a0ad; font-size:10.5px; }
.register-heading { margin: 26px 0 19px; }.register-heading h1 { margin:0; color:#22485d; font-size:25px; }.register-heading p { margin:8px 0 0; color:#79919f; font-size:12px; line-height:1.7; }.register-error { margin-bottom:13px; padding:9px 11px; border:1px solid #f0cbd0; border-radius:9px; background:#fff4f5; color:#bb5c6a; font-size:12px; }
.register-form { display:grid; gap:13px; }.register-form label { display:grid; gap:6px; color:#567287; font-size:12px; }.register-form input { box-sizing:border-box; width:100%; min-height:42px; border:1px solid #d8e7ed; border-radius:10px; padding:0 12px; outline:0; color:#31566a; background:#fbfdfe; }.register-form input:focus { border-color:#60bfc2; box-shadow:0 0 0 4px rgba(96,191,194,.13); }.register-submit { min-height:43px; margin-top:4px; border:0; border-radius:11px; background:linear-gradient(135deg,#37b7b6,#4c8ee7); color:#fff; font-weight:700; cursor:pointer; }.register-submit:disabled { opacity:.6; cursor:wait; }
.register-flow { display:flex; justify-content:center; flex-wrap:wrap; gap:7px; margin-top:19px; color:#8299a6; font-size:10.5px; }.register-flow i { color:#aec1ca; font-style:normal; }.back-login { display:block; margin-top:18px; color:#398c94; text-align:center; font-size:11.5px; text-decoration:none; }.back-login:hover { text-decoration:underline; }
@media (max-width: 520px) { .register-card { padding:23px 18px; } .register-heading h1 { font-size:22px; } }
</style>
