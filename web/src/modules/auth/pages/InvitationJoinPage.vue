<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { Building2, LogIn, UserPlus } from '@lucide/vue'
import { authSession, switchWorkspace } from '../session'
import { acceptInvitation, getInvitationSummary, type SharedInvitationSummary } from '../api/invitations'
import { extractInvitationCode } from '../utils/invitations'
import { describeApiFailure } from '../../../shared/utils/errorMessage'
const route = useRoute()
const code = computed(() => extractInvitationCode(typeof route.query.invite === 'string' ? route.query.invite : ''))
const summary = ref<SharedInvitationSummary | null>(null)
const loading = ref(false), busy = ref(false), error = ref(''), joinedId = ref('')
const redirect = computed(() => '/join?invite=' + encodeURIComponent(code.value))
let generation = 0
watch(code, async value => {
  const current = ++generation
  summary.value = null; error.value = ''; joinedId.value = ''; loading.value = true
  try { const result = await getInvitationSummary(value); if (current === generation) summary.value = result }
  catch (cause) { if (current === generation) error.value = describeApiFailure(cause, '无法读取邀请').message }
  finally { if (current === generation) loading.value = false }
}, { immediate:true })
async function join() {
  if (busy.value || !summary.value) return
  busy.value = true; error.value = ''
  try {
    if (!joinedId.value) joinedId.value = (await acceptInvitation(code.value)).workspaceId
    await switchWorkspace(joinedId.value)
    window.location.assign('/')
  } catch (cause) { error.value = joinedId.value ? '已加入企业，但切换失败，请点击下方按钮重试进入。' : describeApiFailure(cause, '加入企业失败').message }
  finally { busy.value = false }
}
</script>
<template>
  <main class="join-shell"><section class="join-content" :aria-busy="loading || busy">
    <Building2 :size="36" class="brand-icon" aria-hidden="true" />
    <h1>{{ summary ? summary.workspaceName : '加入企业' }}</h1>
    <p v-if="loading" role="status">正在验证邀请...</p>
    <p v-if="error" role="alert" class="error">{{ error }}</p>
    <template v-if="summary">
      <p>企业邀请</p>
      <dl><div><dt>加入身份</dt><dd>普通成员</dd></div><div><dt>有效期至</dt><dd>{{ new Date(summary.expiresAt).toLocaleString('zh-CN') }}</dd></div></dl>
      <template v-if="authSession.user">
        <p class="account">当前账号：{{ authSession.user.name }} · {{ authSession.user.email }}</p>
        <button type="button" :disabled="busy" @click="join">{{ busy ? '处理中...' : joinedId ? '进入企业' : '确认加入企业' }}</button>
        <router-link :to="{name:'login',query:{addAccount:'1',redirect}}">使用其他账号</router-link>
      </template>
      <div v-else class="entry-actions">
        <router-link class="primary" :to="{name:'register',query:{invite:code}}"><UserPlus :size="18" />注册并加入</router-link>
        <router-link :to="{name:'login',query:{redirect}}"><LogIn :size="18" />登录并加入</router-link>
      </div>
    </template>
    <router-link v-if="!loading && !summary" :to="{name:'login'}">返回登录</router-link>
  </section></main>
</template>
<style scoped>
.join-shell { min-height:100dvh; display:grid; place-items:center; background:#f4f7f8; padding:24px; box-sizing:border-box; color:#203c44; }
.join-content { width:100%; max-width:440px; } .brand-icon { color:#18836d; } h1 { font-size:26px; line-height:1.4; overflow-wrap:anywhere; margin:20px 0 8px; } p { color:#5b6e76; line-height:1.7; font-size:14px; overflow-wrap:anywhere; }
dl { border-block:1px solid #d5e0e3; padding:12px 0; margin:24px 0; font-size:14px; } dl div { display:flex; gap:20px; justify-content:space-between; padding:8px 0; } dt { color:#5b6e76; flex-shrink:0; } dd { margin:0; text-align:right; }
a,button { display:flex; align-items:center; justify-content:center; gap:8px; min-height:44px; border:1px solid #bdcfd5; border-radius:6px; padding:0 16px; font:inherit; font-size:14px; text-decoration:none; color:#28566b; background:white; box-sizing:border-box; } button,.primary { background:#147d67; color:white; border-color:#147d67; width:100%; } button { cursor:pointer; margin-bottom:12px; } button:disabled { opacity:.6; } .entry-actions { display:grid; gap:12px; } .error { color:#a33847; } a:focus-visible,button:focus-visible { outline:3px solid #4b9eae; outline-offset:3px; } .account { margin-bottom:20px; }
</style>
