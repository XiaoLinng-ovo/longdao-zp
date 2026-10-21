<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { authSession, loginWithEmail, refreshAuthSession, switchWorkspace } from '../session'
import { describeApiFailure } from '../../../shared/utils/errorMessage'

const router = useRouter()
const route = useRoute()
const addingAccount = computed(() => route.query.addAccount === '1')
const email = ref('')
const password = ref('')
const showPassword = ref(false)
const error = ref('')
const submitting = ref(false)
const workspaceChoiceOpen = ref(false)
const onboardingOpen = ref(true)
let compactLayout: MediaQueryList | undefined

function syncOnboardingLayout() {
  onboardingOpen.value = !compactLayout?.matches
}

function onOnboardingToggle(event: Event) {
  onboardingOpen.value = (event.currentTarget as HTMLDetailsElement).open
}

onBeforeUnmount(() => {
  compactLayout?.removeEventListener('change', syncOnboardingLayout)
})
const workspaces = ref<Awaited<ReturnType<typeof loginWithEmail>>>([])

async function completeLogin(path: string) {
  if (addingAccount.value) {
    // Clear all page-local state before displaying the newly authenticated account.
    const destination = new URL(path, window.location.origin)
    window.location.assign(destination.origin === window.location.origin ? destination.pathname + destination.search + destination.hash : '/')
    return
  }
  await router.push(path)
}

async function chooseWorkspace(workspaceId: string) {
  const workspace = workspaces.value.find((item) => item.id === workspaceId)
  if (!workspace) return
  await switchWorkspace(workspaceId)
  workspaceChoiceOpen.value = false
  const redirect = typeof route.query.redirect === 'string' ? route.query.redirect : '/'
  await completeLogin(redirect)
}

function fillDevelopmentAccount() {
  email.value = 'recruiter@smartrecruit.local'
  password.value = 'recruiter123'
  error.value = ''
}

async function submit() {
  if (submitting.value) return
  if (!email.value.trim() || !password.value) {
    error.value = '请输入邮箱和密码'
    return
  }
  submitting.value = true
  error.value = ''
  try {
    workspaces.value = await loginWithEmail(email.value.trim(), password.value)
    if (typeof route.query.redirect === 'string' && /^\/workspaces(?:[?#]|$)/.test(route.query.redirect)) {
      await completeLogin(route.query.redirect)
      return
    }
    if (workspaces.value.length === 0) {
      await completeLogin('/workspaces')
      return
    }
    if (workspaces.value.length > 1 || (workspaces.value.length === 1 && !authSession.user?.workspaceId)) {
      workspaceChoiceOpen.value = true
      return
    }
    const redirect = typeof route.query.redirect === 'string' ? route.query.redirect : '/'
    await completeLogin(redirect)
  } catch (cause) {
    error.value = describeApiFailure(cause, '登录失败').message
  } finally {
    submitting.value = false
  }
}

onMounted(async () => {
  compactLayout = window.matchMedia?.('(max-width: 720px)')
  syncOnboardingLayout()
  compactLayout?.addEventListener('change', syncOnboardingLayout)
  if (!authSession.ready) await refreshAuthSession()
  if (authSession.user && !addingAccount.value) {
    const redirect = typeof route.query.redirect === 'string' && /^\/workspaces(?:[?#]|$)/.test(route.query.redirect) ? route.query.redirect : undefined
    await router.push(redirect ?? (authSession.user.workspaceId ? '/' : '/workspaces'))
    return
  }
  if (route.query.logoutError === '1') {
    error.value = '退出请求未能完成，本地登录状态已清除。请检查网络后重试。'
  }
})
</script>

<template>
  <main class="login-shell">
    <div class="login-orb login-orb-one" aria-hidden="true"></div>
    <div class="login-orb login-orb-two" aria-hidden="true"></div>
    <div class="login-grid" aria-hidden="true"></div>

    <div class="login-layout">
      <div class="login-story">
        <section class="login-intro" aria-labelledby="login-intro-title">
          <span class="intro-kicker">SMART RECRUIT · TALENT OS</span>
          <span class="intro-line" aria-hidden="true"></span>
          <h1 id="login-intro-title">智能招聘与人才管理平台</h1>
          <p>
            为企业打造一体化智能招聘解决方案，融合AI招聘、人才评估与招聘协同能力，覆盖招聘需求、岗位管理、简历筛选、面试评估、录用审批及人才库全流程，提升招聘效率与人才决策能力。
          </p>
          <div class="intro-tags" aria-label="平台能力">
            <span>AI 招聘</span>
            <span>人才评估</span>
            <span>招聘协同</span>
          </div>
        </section>

        <details class="workspace-onboarding" :open="onboardingOpen" aria-label="企业账号使用流程" @toggle="onOnboardingToggle">
          <summary class="workspace-onboarding-head">
            <span class="workspace-icon" aria-hidden="true">⌂</span>
            <strong>首次使用怎么进入？</strong>
            <span class="workspace-onboarding-chevron" aria-hidden="true">⌄</span>
          </summary>
          <div class="workspace-onboarding-content">
            <p class="workspace-onboarding-description">注册或登录后粘贴邀请码，确认企业和角色即可加入。</p>
            <div class="workspace-steps">
              <div class="workspace-step"><span>1</span><div><b>绑定企业</b><small>创建企业或使用邀请码加入</small></div></div>
              <div class="workspace-step"><span>2</span><div><b>分配角色</b><small>管理员、HR、面试官或部门负责人</small></div></div>
              <div class="workspace-step"><span>3</span><div><b>选择职位</b><small>进入企业后开展招聘协作</small></div></div>
            </div>
            <p class="workspace-footnote">已有邀请码？登录后进入企业工作空间粘贴，或直接打开管理员发来的邀请链接。</p>
          </div>
        </details>
      </div>

      <section class="login-panel" aria-labelledby="login-title">
        <div class="brand"><span class="brand-mark">龙道</span><span><b>龙道招聘系统</b><small>全流程智能招聘</small></span></div>
        <div class="login-heading">
          <h2 id="login-title">{{ addingAccount ? '添加登录账号' : '进入企业工作空间' }}</h2>
          <p class="list-muted">账号先绑定企业，登录后再按权限选择职位，不在登录时固定到某一个职位。</p>
        </div>
        <p v-if="addingAccount" class="list-muted">当前账号保持登录；新账号登录成功后会保存在本机，便于直接切换。<router-link to="/">返回当前账号</router-link></p>
        <div v-if="error" class="error-note" role="alert">{{ error }}</div>
        <form class="login-form" @submit.prevent="submit">
          <div class="form-grid">
            <div class="form-field">
              <label for="login-email">邮箱</label>
              <input id="login-email" v-model="email" type="email" autocomplete="username" placeholder="recruiter@smartrecruit.local" />
            </div>
            <div class="form-field">
              <label for="login-password">密码</label>
              <div class="password-input-wrap">
                <input id="login-password" v-model="password" :type="showPassword ? 'text' : 'password'" autocomplete="current-password" placeholder="recruiter123" />
                <button
                  class="password-toggle"
                  type="button"
                  :aria-label="showPassword ? '隐藏密码' : '显示密码'"
                  :title="showPassword ? '隐藏密码' : '显示密码'"
                  @click="showPassword = !showPassword"
                >
                  <svg v-if="showPassword" viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M3 3l18 18M10.6 10.6a2 2 0 0 0 2.8 2.8M9.9 4.3A10.8 10.8 0 0 1 12 4c5.2 0 8.7 4 10 8a14.8 14.8 0 0 1-3.1 5.2M6.2 6.2C4.5 7.5 3.4 9.4 2 12c1.3 4 4.8 8 10 8 1.6 0 3-.4 4.2-1" />
                  </svg>
                  <svg v-else viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
                    <circle cx="12" cy="12" r="2.8" />
                  </svg>
                </button>
              </div>
            </div>
          </div>
          <div class="login-hint"><strong>登录规则</strong><span>企业管理员邀请成员并分配企业角色；邀请码用于加入企业，请先使用自己的邮箱密码登录。</span></div>
          <div class="login-actions">
            <button class="btn btn-primary" type="submit" :disabled="submitting || authSession.loading">{{ submitting ? '登录中...' : '登录工作空间' }}</button>
            <span class="enter-hint">填写完成后按 Enter 即可登录</span>
          </div>
          <div class="login-links"><span>还没有账号？</span><router-link :to="{ name: 'register', query: route.query.redirect ? { redirect: route.query.redirect } : {} }">注册企业账号</router-link><span class="login-link-divider">·</span><router-link to="/workspaces">管理工作空间</router-link></div>
        </form>
        <div v-if="workspaceChoiceOpen" class="workspace-choice" role="dialog" aria-label="选择工作空间">
          <div class="workspace-choice-head"><strong>选择工作空间</strong><span>你可以在同一个账号下保留测试企业和正式企业。</span></div>
          <button v-for="workspace in workspaces" :key="workspace.id" type="button" class="workspace-choice-item" @click="chooseWorkspace(workspace.id)">
            <span class="workspace-choice-icon">{{ workspace.kind === 'test' ? '测' : '正' }}</span>
            <span><b>{{ workspace.name }}</b><small>{{ workspace.kind === 'test' ? '测试企业 · 可重置或归档' : '正式企业 · 数据独立保留' }}</small></span>
            <span class="workspace-choice-arrow">›</span>
          </button>
        </div>
        <router-link class="workspace-invite-entry" :to="{ name: 'workspaces', query: { join: '1' } }">已有邀请码？加入企业 →</router-link>
        <details class="dev-account">
          <summary>开发环境测试账号</summary>
          <div class="dev-account-content">
            <span>招聘专员：recruiter@smartrecruit.local / recruiter123</span>
            <button type="button" class="dev-account-fill" @click="fillDevelopmentAccount">填入测试账号</button>
          </div>
        </details>
      </section>
    </div>
  </main>
</template>

<style scoped>
.workspace-invite-entry { display:block; margin:14px 0; text-align:center; color:#328795; font-size:13px; text-decoration:none; }

.login-shell {
  position: relative;
  isolation: isolate;
  min-height: 100vh;
  display: grid;
  place-items: center;
  overflow: hidden;
  padding: 42px 32px;
  background:
    radial-gradient(circle at 9% 18%, rgba(255, 255, 255, .94) 0 7%, transparent 34%),
    radial-gradient(circle at 90% 83%, rgba(174, 231, 220, .55) 0 8%, transparent 35%),
    linear-gradient(135deg, #eaf5f3 0%, #dceef2 48%, #e9f2fb 100%);
}
.login-shell::before,
.login-shell::after {
  position: absolute;
  z-index: -1;
  content: '';
  border-radius: 50%;
  filter: blur(2px);
  pointer-events: none;
}
.login-shell::before {
  width: 48vw;
  height: 48vw;
  min-width: 360px;
  min-height: 360px;
  left: -15vw;
  bottom: -20vw;
  background: rgba(126, 210, 204, .26);
}
.login-shell::after {
  width: 42vw;
  height: 42vw;
  min-width: 320px;
  min-height: 320px;
  right: -13vw;
  top: -18vw;
  background: rgba(151, 192, 240, .25);
}
.login-orb {
  position: absolute;
  border-radius: 50%;
  pointer-events: none;
  filter: blur(1px);
}
.login-orb-one {
  width: 180px;
  height: 180px;
  left: 10%;
  top: 11%;
  background: rgba(255, 255, 255, .58);
}
.login-orb-two {
  width: 120px;
  height: 120px;
  right: 16%;
  bottom: 14%;
  background: rgba(113, 202, 192, .18);
}
.login-grid {
  position: absolute;
  inset: 0;
  pointer-events: none;
  opacity: .24;
  background-image: linear-gradient(rgba(255, 255, 255, .55) 1px, transparent 1px), linear-gradient(90deg, rgba(255, 255, 255, .55) 1px, transparent 1px);
  background-size: 42px 42px;
  mask-image: radial-gradient(ellipse at center, black 0%, transparent 72%);
}
.login-layout {
  position: relative;
  z-index: 1;
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(420px, 500px);
  align-items: center;
  gap: clamp(56px, 8vw, 130px);
  width: min(1180px, 100%);
}
.login-story { min-width: 0; }
.login-intro {
  max-width: 560px;
  padding: 20px 0 20px 8px;
}
.intro-kicker {
  display: block;
  margin-bottom: 18px;
  color: #439b9b;
  font-size: 11px;
  font-weight: 750;
  letter-spacing: .18em;
}
.intro-line {
  display: block;
  width: 58px;
  height: 4px;
  margin-bottom: 22px;
  border-radius: 99px;
  background: linear-gradient(90deg, #35bdbb, #6f9ceb);
  box-shadow: 0 5px 12px rgba(63, 164, 185, .2);
}
.login-intro h1 {
  max-width: 540px;
  margin: 0 0 22px;
  color: #17324c;
  font-size: clamp(34px, 4vw, 54px);
  font-weight: 750;
  letter-spacing: -.055em;
  line-height: 1.18;
}
.login-intro p {
  max-width: 535px;
  margin: 0;
  color: #5f7889;
  font-size: 15px;
  line-height: 2;
}
.intro-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 9px;
  margin-top: 26px;
}
.intro-tags span {
  padding: 7px 12px;
  border: 1px solid rgba(132, 202, 202, .42);
  border-radius: 999px;
  background: rgba(255, 255, 255, .38);
  color: #43838e;
  font-size: 11.5px;
  box-shadow: 0 5px 14px rgba(80, 143, 157, .06);
}
.login-panel {
  position: relative;
  width: 100%;
  padding: 34px 38px 36px;
  border: 1px solid rgba(255, 255, 255, .78);
  border-radius: 22px;
  background: rgba(255, 255, 255, .72);
  box-shadow: 0 24px 70px rgba(73, 130, 143, .18), inset 0 1px 0 rgba(255, 255, 255, .76);
  backdrop-filter: blur(18px);
  -webkit-backdrop-filter: blur(18px);
  text-align: center;
}
.login-panel::before {
  position: absolute;
  top: 0;
  left: 34px;
  right: 34px;
  height: 3px;
  content: '';
  border-radius: 0 0 99px 99px;
  background: linear-gradient(90deg, #53c7c5, #75a9f2, #9c8ce8);
}
.brand {
  display: inline-flex;
  align-items: center;
  gap: 11px;
  margin-bottom: 26px;
  text-align: left;
}
.brand-mark {
  display: inline-grid;
  place-items: center;
  width: 42px;
  height: 42px;
  border-radius: 13px;
  background: linear-gradient(145deg, #4c91f2, #6f80ec);
  box-shadow: 0 8px 16px rgba(82, 139, 232, .2);
  color: #fff;
  font-weight: 800;
  letter-spacing: -1px;
}
.brand b { display: block; color: #17324c; font-size: 18px; }
.brand small { display: block; margin-top: 3px; color: #7590a5; font-size: 11px; }
.login-heading { margin-bottom: 20px; }
.login-heading h2 { margin: 0 0 8px; color: #17324c; font-size: 25px; letter-spacing: -.03em; }
.list-muted { margin: 0; color: #698398; font-size: 12px; line-height: 1.75; }
.login-form { text-align: left; }
.form-grid { display: grid; grid-template-columns: 1fr; gap: 14px; }
.form-field { display: grid; gap: 7px; }
.form-field label { color: #52718a; font-size: 14px; font-weight: 700; text-align: left; }
.form-field input {
  width: 100%;
  min-height: 46px;
  padding: 0 14px;
  border: 1px solid rgba(151, 191, 205, .52);
  border-radius: 12px;
  outline: 0;
  background: rgba(255, 255, 255, .76);
  box-shadow: inset 0 1px 2px rgba(79, 137, 151, .04);
  color: #284a64;
  transition: border-color .18s ease, box-shadow .18s ease, background .18s ease;
}
.password-input-wrap { position: relative; }
.password-input-wrap input { padding-right: 46px; }
.password-toggle {
  position: absolute;
  top: 50%;
  right: 10px;
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  padding: 0;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: #7291a2;
  cursor: pointer;
  transform: translateY(-50%);
  transition: color .18s ease, background .18s ease;
}
.password-toggle:hover { background: rgba(84, 191, 192, .12); color: #338e9a; }
.password-toggle:focus-visible { outline: 3px solid rgba(84, 191, 192, .2); outline-offset: 1px; }
.password-toggle svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-linecap: round; stroke-linejoin: round; stroke-width: 1.8; }.form-field input::placeholder { color: #9aafbd; }
.form-field input:hover { background: rgba(255, 255, 255, .9); border-color: rgba(101, 183, 188, .6); }
.form-field input:focus { background: rgba(255, 255, 255, .96); border-color: #54bfc0; box-shadow: 0 0 0 4px rgba(84, 191, 192, .14); }

.login-hint { display: grid; gap: 3px; margin-top: 14px; padding: 10px 12px; border: 1px dashed rgba(89, 170, 183, .48); border-radius: 10px; background: rgba(239, 251, 250, .65); color: #5d8291; font-size: 12px; line-height: 1.5; text-align: left; }
.login-hint strong { color: #327985; font-size: 12px; }
.login-hint span { color: #6d8b98; }
.workspace-onboarding { margin-top: 22px; padding: 18px; border: 1px solid rgba(121, 170, 214, .28); border-radius: 16px; background: linear-gradient(145deg, rgba(247, 252, 255, .58), rgba(244, 250, 249, .48)); box-shadow: 0 10px 30px rgba(73, 130, 143, .06); text-align: left; }
.workspace-onboarding-head { display: flex; align-items: center; gap: 10px; cursor: pointer; list-style: none; border-radius: 9px; }
.workspace-onboarding-head::-webkit-details-marker { display: none; }
.workspace-onboarding-head:focus-visible { outline: 3px solid rgba(84, 191, 192, .4); outline-offset: 5px; }
.workspace-icon { display: grid; place-items: center; flex: 0 0 30px; width: 30px; height: 30px; border-radius: 9px; background: #e4f5f5; color: #268d93; font-size: 17px; }
.workspace-onboarding-head strong { color: #21465e; font-size: 14px; }
.workspace-onboarding-chevron { margin-left: auto; color: #43838e; transition: transform .18s ease; }
.workspace-onboarding[open] .workspace-onboarding-chevron { transform: rotate(180deg); }
.workspace-onboarding-description { margin: 10px 0 0; color: #5f7889; font-size: 12px; line-height: 1.7; }
.workspace-steps { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-top: 14px; }
.workspace-step { display: flex; gap: 7px; min-width: 0; }
.workspace-step > span { display: grid; place-items: center; flex: 0 0 20px; width: 20px; height: 20px; border-radius: 50%; background: #e7efff; color: #4571bd; font-size: 11px; font-weight: 800; }
.workspace-step b, .workspace-step small { display: block; }
.workspace-step b { color: #45657b; font-size: 11px; }
.workspace-step small { margin-top: 3px; color: #5f7889; font-size: 11px; line-height: 1.6; }
.workspace-footnote { margin: 13px 0 0; padding-top: 10px; border-top: 1px solid rgba(145, 183, 202, .2); color: #5f7889; font-size: 11px; line-height: 1.7; }
.login-links { display: flex; justify-content: center; align-items: center; flex-wrap: wrap; gap: 5px; margin-top: 13px; color: #8aa0ad; font-size: 11px; }
.login-links a { color: #368c92; text-decoration: none; }
.login-links a:hover { text-decoration: underline; }
.login-link-divider { color: #c0ced4; }
.workspace-choice { margin-top: 18px; padding: 13px; border: 1px solid #d4e7ed; border-radius: 13px; background: #f8fcfd; text-align: left; }
.workspace-choice-head { display: grid; gap: 3px; margin-bottom: 9px; }
.workspace-choice-head strong { color: #28536a; font-size: 13px; }
.workspace-choice-head span { color: #829aa7; font-size: 10.5px; line-height: 1.5; }
.workspace-choice-item { display: flex; align-items: center; width: 100%; gap: 9px; margin-top: 7px; padding: 9px; border: 1px solid #e2edf1; border-radius: 10px; background: #fff; color: inherit; text-align: left; cursor: pointer; }
.workspace-choice-item:hover { border-color: #8dd0d0; background: #f3fbfa; }
.workspace-choice-icon { display: grid; place-items: center; flex: 0 0 25px; width: 25px; height: 25px; border-radius: 7px; background: #e3f3f4; color: #368c92; font-size: 11px; font-weight: 700; }
.workspace-choice-item > span:nth-child(2) { display: grid; min-width: 0; gap: 3px; }
.workspace-choice-item b { overflow: hidden; color: #3b5d70; font-size: 11.5px; text-overflow: ellipsis; white-space: nowrap; }
.workspace-choice-item small { color: #8aa0ab; font-size: 10px; }
.workspace-choice-arrow { margin-left: auto; color: #78a3ae; font-size: 18px; }
.dev-account { color: #78909e; font-size: 11px; text-align: left; }
.dev-account summary { cursor: pointer; color: #688493; }
.dev-account-content { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding-top: 7px; }
.dev-account-content span { color: #8ca0aa; line-height: 1.5; }
.dev-account-fill { flex: 0 0 auto; border: 1px solid rgba(104, 160, 175, .32); border-radius: 7px; padding: 4px 8px; background: rgba(255, 255, 255, .65); color: #4d8794; font-size: 10px; cursor: pointer; }
.dev-account-fill:hover { background: #fff; border-color: rgba(78, 157, 172, .55); }

.error-note { margin-bottom: 14px; border-color: rgba(235, 116, 129, .4); background: rgba(255, 240, 243, .78); color: #c05667; text-align: center; }
.login-actions { display: grid; justify-items: center; gap: 9px; margin-top: 18px; }
.login-panel .btn-primary { min-width: 132px; min-height: 42px; border: 0; border-radius: 11px; background: linear-gradient(135deg, #36b9be, #478de8); box-shadow: 0 10px 20px rgba(71, 153, 205, .2); }
.login-panel .btn-primary:hover:not(:disabled) { background: linear-gradient(135deg, #2da9b0, #397fdc); transform: translateY(-1px); }
.login-panel .btn-primary:disabled { opacity: .7; }
.enter-hint { color: #8aa1af; font-size: 11px; }
@media (max-width: 900px) {
  .login-shell { padding: 34px 22px; }
  .login-layout { grid-template-columns: minmax(0, 1fr) minmax(360px, 440px); gap: 36px; }
  .login-intro h1 { font-size: 38px; }
  .workspace-steps { grid-template-columns: 1fr; gap: 10px; }
  .login-intro p { font-size: 13px; }
}
@media (max-width: 720px) {
  .login-shell { padding: 28px 16px; }
  .login-layout { grid-template-columns: 1fr; gap: 24px; }
  .login-story { display: contents; }
  .login-intro { order: 0; padding: 0; text-align: center; }
  .login-panel { order: 1; }
  .workspace-onboarding { order: 2; margin-top: 0; }
  .login-intro h1, .login-intro p { margin-left: auto; margin-right: auto; }
  .intro-line { margin-left: auto; margin-right: auto; }
  .intro-tags { justify-content: center; }
  .login-panel { padding: 28px 22px 24px; border-radius: 18px; }
  .login-panel::before { left: 22px; right: 22px; }
  .brand { margin-bottom: 24px; }
  .login-heading h2 { font-size: 22px; }
  .workspace-steps { grid-template-columns: 1fr; gap: 10px; }
  .dev-account-content { align-items: flex-start; flex-direction: column; }
}

</style>
