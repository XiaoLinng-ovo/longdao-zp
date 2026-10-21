<script setup lang="ts">
import { ref } from 'vue'
import { externalJobPublishingEnabled } from '../../../shared/config/features'
import type { JobAction, JobView } from '../api'
import { JOB_ACTION_LABEL, JOB_REASON_REQUIRED, JOB_STATUS_LABEL, isJobActionVisible, visibleJobActionsFor } from '../workflow'

defineProps<{
  rows: JobView[]
  actingId?: string
  canDelete?: boolean
}>()

const emit = defineEmits<{
  action: [row: JobView, action: JobAction, reason?: string]
  open: [row: JobView]
  openDoc: [row: JobView, kind: 'spec' | 'jd']
  delete: [row: JobView]
}>()

const pending = ref<{ row: JobView; action: JobAction } | null>(null)
const reason = ref('')

function label(row: JobView): string { return JOB_STATUS_LABEL[row.status] ?? row.status }

function quickActions(row: JobView): JobAction[] {
  return visibleJobActionsFor(row)
}

function tone(action: JobAction): string {
  if (action === 'close' || action === 'pause') return 'btn-danger'
  if (action === 'publish') return 'btn-primary'
  return 'btn-ghost'
}

function run(row: JobView, action: JobAction) {
  if (!isJobActionVisible(action)) return
  if (JOB_REASON_REQUIRED.includes(action)) {
    reason.value = ''
    pending.value = { row, action }
    return
  }
  emit('action', row, action)
}

function submitPending() {
  if (!pending.value || !isJobActionVisible(pending.value.action)) return
  const { row, action } = pending.value
  const value = reason.value.trim()
  if (JOB_REASON_REQUIRED.includes(action) && !value) return
  emit('action', row, action, value || undefined)
  pending.value = null
}
</script>

<template>
  <div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th>岗位名称</th>
          <th>部门</th>
          <th v-if="externalJobPublishingEnabled">状态</th>
          <th v-if="externalJobPublishingEnabled">发布渠道</th>
          <th>更新时间</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="row.entityId || row.id">
          <td><a class="row-link" href="#" @click.prevent="emit('open', row)">{{ row.title }}</a></td>
          <td>{{ row.department }}</td>
          <td v-if="externalJobPublishingEnabled">{{ label(row) }}</td>
          <td v-if="externalJobPublishingEnabled">{{ row.channels.length ? row.channels.join('、') : '未发布' }}</td>
          <td>{{ row.updatedAt }}</td>
          <td>
            <div class="inline-actions">
              <button class="btn btn-ghost" type="button" @click="emit('open', row)">详情</button>
              <button
                class="btn btn-primary"
                type="button"
                :disabled="Boolean(row.spec)"
                :title="row.spec ? '说明书已生成，请进入详情页调整' : '生成岗位说明书'"
                @click="emit('openDoc', row, 'spec')"
              >
                AI 生成说明书
              </button>
              <button
                class="btn btn-primary"
                type="button"
                :disabled="Boolean(row.jd)"
                :title="row.jd ? 'JD 已生成，请进入详情页调整' : '生成 JD'"
                @click="emit('openDoc', row, 'jd')"
              >
                AI 生成 JD
              </button>
              <button
                v-for="action in quickActions(row)"
                :key="action"
                type="button"
                class="btn"
                :class="tone(action)"
                :disabled="actingId === (row.entityId || row.id)"
                @click="run(row, action)"
              >
                {{ JOB_ACTION_LABEL[action] }}
              </button>
              <button v-if="canDelete" class="btn btn-danger" type="button" :disabled="Boolean(actingId)" :aria-label="`删除岗位：${row.title}`" @click="emit('delete', row)">删除岗位</button>
            </div>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td class="table-empty" :colspan="externalJobPublishingEnabled ? 6 : 4">暂无岗位记录</td>
        </tr>
      </tbody>
    </table>
  </div>

  <div v-if="pending" class="overlay" role="presentation" @click.self="pending = null">
    <div class="dialog" role="dialog" aria-modal="true">
      <h3>{{ JOB_ACTION_LABEL[pending.action] }}</h3>
      <p>岗位 {{ pending.row.title }}</p>
      <div class="form-field">
        <label for="job-reason">操作原因（必填）</label>
        <textarea id="job-reason" v-model="reason" rows="3" placeholder="请填写操作原因"></textarea>
      </div>
      <div class="dialog-buttons">
        <button class="btn btn-ghost" type="button" @click="pending = null">取消</button>
        <button class="btn btn-primary" type="button" :disabled="!reason.trim()" @click="submitPending">确认</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.row-link { color: var(--primary); font-weight: 500 }
.row-link:hover { text-decoration: underline }
.btn:disabled { opacity: .45; cursor: not-allowed; }
</style>
