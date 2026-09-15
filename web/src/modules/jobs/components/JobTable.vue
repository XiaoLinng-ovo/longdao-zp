<script setup lang="ts">
import { ref } from 'vue'
import type { JobAction, JobView } from '../api'
import { JOB_ACTION_LABEL, JOB_REASON_REQUIRED, JOB_STATUS_LABEL } from '../workflow'

defineProps<{
  rows: JobView[]
  actingId?: string
}>()

const emit = defineEmits<{
  action: [row: JobView, action: JobAction, reason?: string]
  open: [row: JobView]
  openDoc: [row: JobView, kind: 'spec' | 'jd']
}>()

const pending = ref<{ row: JobView; action: JobAction } | null>(null)
const reason = ref('')

function label(row: JobView): string { return JOB_STATUS_LABEL[row.status] ?? row.status }

function quickActions(row: JobView): JobAction[] {
  const actions: JobAction[] = []
  if (row.spec && !row.spec.confirmed) actions.push('confirm-spec')
  if (row.jd && !row.jd.confirmed) actions.push('confirm-jd')
  if (row.status === 'draft' || row.status === 'ready') actions.push('publish')
  if (row.status === 'published') actions.push('pause')
  if (row.status === 'paused') actions.push('resume')
  if (['ready', 'published', 'paused'].includes(row.status)) actions.push('close')
  return actions
}

function tone(action: JobAction): string {
  if (action === 'close' || action === 'pause') return 'btn-danger'
  if (action === 'publish') return 'btn-primary'
  return 'btn-ghost'
}

function run(row: JobView, action: JobAction) {
  if (JOB_REASON_REQUIRED.includes(action)) {
    reason.value = ''
    pending.value = { row, action }
    return
  }
  emit('action', row, action)
}

function submitPending() {
  if (!pending.value) return
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
          <th>编号</th>
          <th>岗位名称</th>
          <th>部门</th>
          <th>状态</th>
          <th>发布渠道</th>
          <th>更新时间</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="row.entityId || row.id">
          <td>{{ row.id }}</td>
          <td><a class="row-link" href="#" @click.prevent="emit('open', row)">{{ row.title }}</a></td>
          <td>{{ row.department }}</td>
          <td>{{ label(row) }}</td>
          <td>{{ row.channels.length ? row.channels.join('、') : '未发布' }}</td>
          <td>{{ row.updatedAt }}</td>
          <td>
            <div class="inline-actions">
              <button class="btn btn-ghost" type="button" @click="emit('open', row)">详情</button>
              <button v-if="!row.spec" class="btn btn-primary" type="button" @click="emit('openDoc', row, 'spec')">新建说明书</button>
              <button v-if="!row.jd" class="btn btn-primary" type="button" @click="emit('openDoc', row, 'jd')">新建 JD</button>
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
            </div>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td class="table-empty" colspan="7">暂无岗位记录</td>
        </tr>
      </tbody>
    </table>
  </div>

  <div v-if="pending" class="overlay" role="presentation" @click.self="pending = null">
    <div class="dialog" role="dialog" aria-modal="true">
      <h3>{{ JOB_ACTION_LABEL[pending.action] }}</h3>
      <p>岗位 {{ pending.row.title }}（{{ pending.row.id }}）</p>
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
</style>