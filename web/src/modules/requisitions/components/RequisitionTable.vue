<script setup lang="ts">
import { ref } from 'vue'
import type { RequisitionAction, RequisitionView } from '../api'
import { REQ_ACTION_LABEL, REQ_REASON_REQUIRED, REQ_STATUS_LABEL, requisitionActionsForApproval } from '../workflow'

defineProps<{
  rows: RequisitionView[]
  actingId?: string
}>()

const emit = defineEmits<{
  action: [row: RequisitionView, action: RequisitionAction, reason?: string]
  open: [row: RequisitionView]
}>()

const pending = ref<{ row: RequisitionView; action: RequisitionAction } | null>(null)
const reason = ref('')

function label(status: string): string { return REQ_STATUS_LABEL[status] ?? status }
function buttons(row: RequisitionView): RequisitionAction[] {
  return requisitionActionsForApproval(row.status, {
    provider: row.approvalProvider,
    status: row.approvalStatus,
    externalInstanceId: row.approvalExternalInstanceId,
  })
}

function isDingTalkActive(row: RequisitionView): boolean {
  return row.status === 'pending_approval'
    && row.approvalProvider === 'dingtalk'
    && row.approvalStatus === 'pending'
    && Boolean(row.approvalExternalInstanceId)
}

function confirm(row: RequisitionView, action: RequisitionAction) {
  if (REQ_REASON_REQUIRED.includes(action)) {
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
  if (REQ_REASON_REQUIRED.includes(action) && !value) return
  emit('action', row, action, value || undefined)
  pending.value = null
}

function tone(action: RequisitionAction): string {
  if (action === 'reject' || action === 'cancel' || action === 'close') return 'btn-danger'
  if (action === 'approve' || action === 'submit' || action === 'resubmit') return 'btn-primary'
  return 'btn-ghost'
}
</script>

<template>
  <div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th>需求名称</th>
          <th>部门</th>
          <th>人数</th>
          <th>审批人</th>
          <th>状态</th>
          <th>更新时间</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="row.entityId || row.id">
          <td><a class="row-link" href="#" @click.prevent="emit('open', row)">{{ row.title }}</a></td>
          <td>{{ row.department }}</td>
          <td>{{ row.headcount }}</td>
          <td>{{ row.approver }}</td>
          <td>{{ label(row.status) }}</td>
          <td>{{ row.updatedAt }}</td>
          <td>
            <div class="inline-actions">
              <button
                v-for="action in buttons(row)"
                :key="action"
                type="button"
                class="btn"
                :class="tone(action)"
                :disabled="actingId === (row.entityId || row.id)"
                @click="confirm(row, action)"
              >
                {{ REQ_ACTION_LABEL[action] }}
              </button>
              <button
                v-if="row.status === 'approved' && row.convertedJobIds && row.convertedJobIds.length"
                class="btn btn-primary"
                type="button"
                :disabled="actingId === (row.entityId || row.id)"
                @click="confirm(row, 'convert')"
              >
                转换为岗位
              </button>
              <span v-if="isDingTalkActive(row)" class="list-muted">请在钉钉中完成审批</span>
              <span v-else-if="!buttons(row).length" class="list-muted">无可执行动作</span>
            </div>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td class="table-empty" colspan="7">暂无需求记录</td>
        </tr>
      </tbody>
    </table>
  </div>

  <div v-if="pending" class="overlay" role="presentation" @click.self="pending = null">
    <div class="dialog" role="dialog" aria-modal="true">
      <h3>{{ REQ_ACTION_LABEL[pending.action] }}</h3>
      <p>需求 {{ pending.row.title }}</p>
      <div class="form-field">
        <label for="req-reason">操作原因（必填）</label>
        <textarea id="req-reason" v-model="reason" rows="3" placeholder="请填写操作原因"></textarea>
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
