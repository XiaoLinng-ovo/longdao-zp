<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { actionOnboarding, listOnboardingRows, updateOnboarding, ONBOARDING_ACTION_LABEL, type ApiOnboarding, type OnboardingAction, type OnboardingRow } from '../api'
import { describeApiFailure } from '../../../shared/utils/errorMessage'
import PageHeader from '../../../shared/components/PageHeader.vue'
import PageFeedback from '../../../shared/components/workflow/PageFeedback.vue'
import StatusTag from '../../../shared/components/StatusTag.vue'
import OnboardingTable from '../components/OnboardingTable.vue'

const rows = ref<OnboardingRow[]>([])
const loading = ref(true)
const error = ref('')
const feedback = ref('')

const selected = ref<OnboardingRow | null>(null)
const raw = ref<ApiOnboarding | null>(null)
const showDetail = ref(false)
const plannedStartDate = ref('')
const notes = ref('')
const updating = ref(false)
const detailFeedback = ref('')

async function refresh() {
  loading.value = true
  error.value = ''
  feedback.value = ''
  try {
    rows.value = await listOnboardingRows()
  } catch (cause) {
    error.value = describeApiFailure(cause, '读取入职归档失败').message
  } finally {
    loading.value = false
  }
}

async function runAction(action: OnboardingAction) {
  if (!selected.value || updating.value) return
  const reasonPrompt = action === 'cancel' ? window.prompt('请输入取消原因（必填）') : undefined
  if (action === 'cancel' && !reasonPrompt?.trim()) return
  updating.value = true
  detailFeedback.value = ''
  try {
    const updated = await actionOnboarding(selected.value.id, action, reasonPrompt?.trim() || undefined)
    raw.value = updated
    selected.value = { ...selected.value, status: updated.status, plannedStartDate: updated.plannedStartDate, archivedAt: updated.archivedAt, updatedAt: updated.updatedAt }
    detailFeedback.value = `${ONBOARDING_ACTION_LABEL[action]}成功`
    await refresh()
  } catch (cause) {
    detailFeedback.value = describeApiFailure(cause, `${ONBOARDING_ACTION_LABEL[action]}失败`).message
  } finally {
    updating.value = false
  }
}

async function submitUpdate() {
  if (!selected.value || updating.value) return
  updating.value = true
  detailFeedback.value = ''
  try {
    const updated = await updateOnboarding(selected.value.id, { plannedStartDate: plannedStartDate.value || undefined, notes: notes.value || undefined })
    raw.value = updated
    selected.value = { ...selected.value, plannedStartDate: updated.plannedStartDate, updatedAt: updated.updatedAt }
    detailFeedback.value = '入职排期已保存'
    await refresh()
  } catch (cause) {
    detailFeedback.value = describeApiFailure(cause, '保存入职排期失败').message
  } finally {
    updating.value = false
  }
}

async function open(row: OnboardingRow) {
  selected.value = row
  raw.value = { id: row.id, applicationId: row.applicationId, offerId: row.offerId, status: row.status, createdAt: row.updatedAt, updatedAt: row.updatedAt }
  plannedStartDate.value = ''
  notes.value = ''
  detailFeedback.value = ''
  showDetail.value = true
}

onMounted(refresh)
</script>

<template>
  <section class="page-shell">
    <PageHeader
      title="入职归档"
      eyebrow="录用"
      description="跟踪已接受 Offer 的候选人入职与归档状态，形成招聘闭环的最后一环。"
    />
    <PageFeedback :error="error" :feedback="feedback" />

    <section class="panel">
      <div class="panel-toolbar">
        <div>
          <strong>{{ rows.length }}</strong>
          <span class="list-muted"> 条入职归档记录</span>
        </div>
      </div>
      <OnboardingTable :rows="rows" @open="open" />
      <div v-if="loading" class="loading-note">正在读取入职归档...</div>
    </section>
  </section>

  <div v-if="showDetail && selected" class="overlay" role="presentation" @click.self="showDetail = false">
    <div class="dialog" role="dialog" aria-modal="true" style="max-width: 580px">
      <h3>入职归档详情</h3>
      <div class="detail-card" style="margin-top: 12px">
        <div class="detail-grid">
          <div class="detail-item"><span>入职档案</span><strong>{{ selected.id }}</strong></div>
          <div class="detail-item"><span>状态</span><StatusTag :status="selected.status" /></div>
          <div class="detail-item"><span>申请</span><strong>{{ selected.applicationCode }}</strong></div>
          <div class="detail-item"><span>Offer</span><strong>{{ selected.offerCode }}</strong></div>
          <div class="detail-item"><span>候选人</span><strong>{{ selected.candidate }}</strong></div>
          <div class="detail-item"><span>岗位</span><strong>{{ selected.job }}</strong></div>
          <div class="detail-item"><span>计划入职</span><strong>{{ selected.plannedStartDate || '未排期' }}</strong></div>
          <div class="detail-item"><span>归档时间</span><strong>{{ selected.archivedAt || '—' }}</strong></div>
        </div>
        <p v-if="raw?.notes" class="list-muted" style="margin-top: 10px">{{ raw.notes }}</p>
      </div>

      <div class="form-panel" style="margin-top: 12px">
        <div class="section-title">排期与备注</div>
        <div class="form-grid">
          <div class="form-field"><label>计划入职日期</label><input v-model="plannedStartDate" type="date" :disabled="selected.status === 'completed' || selected.status === 'cancelled'" /></div>
          <div class="form-field"><label>备注</label><input v-model="notes" :disabled="selected.status === 'completed' || selected.status === 'cancelled'" /></div>
        </div>
        <div v-if="detailFeedback" class="form-note">{{ detailFeedback }}</div>
        <div class="inline-actions" style="margin-top:12px">
          <button v-if="selected.status === 'pending' || selected.status === 'cancelled'" class="btn btn-primary" type="button" :disabled="updating" @click="submitUpdate">保存排期</button>
          <button v-if="selected.status === 'pending' || selected.status === 'cancelled'" class="btn btn-primary" type="button" :disabled="updating" @click="runAction('schedule')">安排入职</button>
          <button v-if="selected.status === 'pending' || selected.status === 'scheduled'" class="btn btn-primary" type="button" :disabled="updating" @click="runAction('complete')">完成归档</button>
          <button v-if="selected.status === 'pending' || selected.status === 'scheduled'" class="btn btn-danger" type="button" :disabled="updating" @click="runAction('cancel')">取消入职</button>
        </div>
      </div>

      <div class="dialog-buttons">
        <button class="btn btn-ghost" type="button" @click="showDetail = false">关闭</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.panel-toolbar { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; }
.list-muted { color: var(--muted); font-size: 12px; }
.loading-note { margin-top: 12px; color: var(--muted); font-size: 12px; }
</style>
