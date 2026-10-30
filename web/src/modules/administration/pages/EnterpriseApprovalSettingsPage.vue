<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { getRecruitmentApprovalSettings, updateRecruitmentApprovalSettings, type RecruitmentApprovalMode } from '../api'
import { describeApiFailure } from '../../../shared/utils/errorMessage'

const currentMode = ref<RecruitmentApprovalMode>('platform')
const draftMode = ref<RecruitmentApprovalMode>('platform')
const loading = ref(true)
const loaded = ref(false)
const saving = ref(false)
const error = ref('')
const notice = ref('')

async function refresh() {
  loading.value = true
  loaded.value = false
  notice.value = ''
  error.value = ''
  try {
    const settings = await getRecruitmentApprovalSettings()
    currentMode.value = settings.mode
    draftMode.value = settings.mode
    loaded.value = true
  } catch (cause) {
    error.value = describeApiFailure(cause, '读取企业审批方式失败').message
  } finally {
    loading.value = false
  }
}

async function save() {
  if (!loaded.value || loading.value || saving.value || draftMode.value === currentMode.value) return
  saving.value = true
  error.value = ''
  notice.value = ''
  try {
    const settings = await updateRecruitmentApprovalSettings(draftMode.value)
    currentMode.value = settings.mode
    draftMode.value = settings.mode
    notice.value = '已更新企业统一审批方式'
  } catch (cause) {
    error.value = describeApiFailure(cause, '保存企业审批方式失败').message
  } finally {
    saving.value = false
  }
}

onMounted(refresh)
</script>

<template>
  <section class="section enterprise-approval-settings">
    <div class="section-heading">
      <div>
        <h2 class="section-title">企业统一需求审批方式</h2>
        <p class="muted">由当前企业所有者或管理员统一设置，企业内所有成员提交招聘需求时使用相同方式。</p>
      </div>
    </div>

    <div v-if="loading" class="muted" role="status">正在读取企业审批设置…</div>
    <div v-else class="form-panel approval-mode-panel">
      <div class="form-field">
        <label for="enterprise-recruitment-approval-mode">招聘需求审批方式</label>
        <select id="enterprise-recruitment-approval-mode" v-model="draftMode" :disabled="saving || !loaded">
          <option value="platform">平台内审批（不需要绑定钉钉）</option>
          <option value="dingtalk">钉钉审批</option>
        </select>
        <small class="muted">平台内审批可直接在本平台提交、审批，不需要绑定钉钉账号。选择钉钉审批后，新提交和重新提交的需求会发起钉钉审批。</small>
      </div>
      <p class="muted approval-mode-note">切换只影响之后提交或重新提交的招聘需求；已发起的审批继续按原渠道处理。钉钉模式需完成钉钉服务、部门模板和发起人映射配置。</p>
      <div class="inline-actions">
        <button class="btn btn-primary" type="button" :disabled="saving || !loaded || draftMode === currentMode" @click="save">
          {{ saving ? '保存中…' : '保存企业审批方式' }}
        </button>
        <span v-if="loaded" class="muted">当前生效：{{ currentMode === 'platform' ? '平台内审批' : '钉钉审批' }}</span>
      </div>
      <p v-if="notice" class="muted" role="status">{{ notice }}</p>
      <p v-if="error" class="error-note" role="alert">{{ error }} <button class="btn btn-ghost" type="button" @click="refresh">重试</button></p>
    </div>
  </section>
</template>

<style scoped>
.approval-mode-panel { max-width: 760px; }
.approval-mode-note { margin: 12px 0 18px; }
</style>
