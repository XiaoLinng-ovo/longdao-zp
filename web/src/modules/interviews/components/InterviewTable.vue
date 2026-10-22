<script setup lang="ts">
import type { InterviewView } from '../api'
import StatusTag from '../../../shared/components/StatusTag.vue'

const props = defineProps<{
  rows: InterviewView[]
  confirmingDeleteId?: string | null
  deletingInterviewId?: string | null
  emptyMessage?: string
}>()

const emit = defineEmits<{
  arrange: [row: InterviewView]
  feedback: [row: InterviewView]
  conclude: [row: InterviewView]
  detail: [row: InterviewView]
  delete: [row: InterviewView]
  confirmDelete: [row: InterviewView]
  cancelDelete: []
}>()

function rowId(row: InterviewView): string {
  return row.entityId || row.id
}

function needsFinalSchedule(row: InterviewView): boolean {
  const isFinal = row.stage === 'final' || (!row.stage && Number.parseInt(row.round, 10) >= 2)
  const missingStart = row.scheduledStartAt === undefined ? row.scheduledAt === '待安排' : !row.scheduledStartAt
  return isFinal && row.status === 'scheduled' && missingStart
}
</script>

<template>
  <div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th>候选人</th>
          <th>岗位</th>
          <th>轮次</th>
          <th>时间</th>
          <th>面试官</th>
          <th>反馈状态</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="row.entityId || row.id">
          <td><strong>{{ row.candidate }}</strong></td>
          <td>{{ row.job }}</td>
          <td>{{ row.round }}</td>
          <td>{{ row.scheduledAt }}</td>
          <td>{{ row.interviewers.join('、') || '未分配' }}</td>
          <td><StatusTag :status="row.feedbackStatus" /></td>
          <td>
            <div class="inline-actions">
              <button class="btn btn-ghost" type="button" @click="emit('detail', row)">详情</button>
              <button
                v-if="needsFinalSchedule(row)"
                class="btn btn-primary"
                type="button"
                @click="emit('arrange', row)"
              >
                安排复试
              </button>
              <button
                v-else-if="row.interviewerOptions.length"
                class="btn btn-ghost"
                type="button"
                @click="emit('feedback', row)"
              >
                填写反馈
              </button>
              <span v-else class="list-muted">需重排面试官</span>
              <button
                v-if="row.status === 'scheduled' && !needsFinalSchedule(row)"
                class="btn btn-primary"
                type="button"
                @click="emit('conclude', row)"
              >
                完成面试
              </button>
              <template v-if="props.confirmingDeleteId === rowId(row)">
                <span class="list-muted">删除后不可恢复</span>
                <button
                  class="btn btn-danger"
                  type="button"
                  :disabled="props.deletingInterviewId === rowId(row)"
                  @click="emit('confirmDelete', row)"
                >
                  {{ props.deletingInterviewId === rowId(row) ? '删除中...' : '确认删除' }}
                </button>
                <button
                  class="btn btn-ghost"
                  type="button"
                  :disabled="props.deletingInterviewId === rowId(row)"
                  @click="emit('cancelDelete')"
                >
                  取消
                </button>
              </template>
              <button
                v-else
                class="btn btn-danger"
                type="button"
                :disabled="Boolean(props.deletingInterviewId)"
                @click="emit('delete', row)"
              >
                删除
              </button>
            </div>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td class="table-empty" colspan="7">{{ props.emptyMessage || '暂无面试记录，请先点击右上角「安排面试」发起面试' }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.list-muted {
  color: #b45309;
  font-size: 12px;
  white-space: nowrap;
}
</style>
