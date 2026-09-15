<script setup lang="ts">
import { ref } from 'vue'
import type { OfferAction, OfferRow } from '../api'
import { OFFER_ACTION_LABEL, OFFER_STATUS_LABEL } from '../api'
import StatusTag from '../../../shared/components/StatusTag.vue'

defineProps<{ rows: OfferRow[]; actingId?: string }>()

const emit = defineEmits<{
  action: [row: OfferRow, action: OfferAction, reason?: string]
  open: [row: OfferRow]
  revise: [row: OfferRow]
}>()

const REASON_ACTIONS: OfferAction[] = ['decline', 'cancel', 'reject']
const pending = ref<{ row: OfferRow; action: OfferAction } | null>(null)
const reason = ref('')

function actionsFor(row: OfferRow): OfferAction[] {
  switch (row.status) {
    case 'draft': return ['submit-approval', 'cancel']
    case 'pending_approval': return ['approve', 'reject', 'cancel']
    case 'approved': return ['send', 'cancel']
    case 'sent': return ['accept', 'decline', 'expire', 'cancel']
    case 'accepted': return ['archive-onboarding']
    default: return []
  }
}

function tone(action: OfferAction): string {
  if (action === 'decline' || action === 'cancel' || action === 'reject') return 'btn-danger'
  if (action === 'approve' || action === 'send' || action === 'submit-approval') return 'btn-primary'
  return 'btn-ghost'
}

function run(row: OfferRow, action: OfferAction) {
  if (REASON_ACTIONS.includes(action)) {
    reason.value = ''
    pending.value = { row, action }
    return
  }
  emit('action', row, action)
}

function submitReason() {
  if (!pending.value) return
  const value = reason.value.trim()
  if (!value) return
  emit('action', pending.value.row, pending.value.action, value)
  pending.value = null
}
</script>

<template>
  <div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th>编号</th>
          <th>申请</th>
          <th>候选人</th>
          <th>岗位</th>
          <th>状态</th>
          <th>审批</th>
          <th>审批人</th>
          <th>更新时间</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="row.entityId || row.id">
          <td><a class="row-link" href="#" @click.prevent="emit('open', row)">{{ row.code }}</a></td>
          <td>{{ row.applicationId }}</td>
          <td><strong>{{ row.candidate }}</strong></td>
          <td>{{ row.job }}</td>
          <td><StatusTag :status="row.status" /></td>
          <td><StatusTag :status="row.approvalStatus" /></td>
          <td>{{ row.approver }}</td>
          <td>{{ row.updatedAt }}</td>
          <td>
            <div class="inline-actions">
              <button class="btn btn-ghost" type="button" @click="emit('open', row)">详情</button>
              <button v-if="row.status === 'draft'" class="btn btn-ghost" type="button" @click="emit('revise', row)">修订</button>
              <button
                v-for="action in actionsFor(row)"
                :key="action"
                type="button"
                class="btn"
                :class="tone(action)"
                :disabled="actingId === row.entityId"
                @click="run(row, action)"
              >
                {{ OFFER_ACTION_LABEL[action] }}
              </button>
              <span v-if="!actionsFor(row).length" class="list-muted">{{ OFFER_STATUS_LABEL[row.status] }}</span>
            </div>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td class="table-empty" colspan="9">暂无 Offer 记录</td>
        </tr>
      </tbody>
    </table>
  </div>

  <div v-if="pending" class="overlay" role="presentation" @click.self="pending = null">
    <div class="dialog" role="dialog" aria-modal="true">
      <h3>{{ OFFER_ACTION_LABEL[pending.action] }}</h3>
      <p>Offer {{ pending.row.code }}（{{ pending.row.applicationId }}）</p>
      <div class="form-field">
        <label for="offer-reason">操作原因（必填）</label>
        <textarea id="offer-reason" v-model="reason" rows="3" placeholder="请填写操作原因"></textarea>
      </div>
      <div class="dialog-buttons">
        <button class="btn btn-ghost" type="button" @click="pending = null">取消</button>
        <button class="btn btn-primary" type="button" :disabled="!reason.trim()" @click="submitReason">确认</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.row-link { color: var(--primary); font-weight: 500 }
.row-link:hover { text-decoration: underline }
</style>
