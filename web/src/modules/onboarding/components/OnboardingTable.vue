<script setup lang="ts">
import type { ApiOnboardingWorkbenchItem } from '../api'
import StatusTag from '../../../shared/components/StatusTag.vue'

defineProps<{ rows: ApiOnboardingWorkbenchItem[] }>()
const emit = defineEmits<{ open: [row: ApiOnboardingWorkbenchItem] }>()
</script>

<template>
  <div class="table-wrap">
    <table class="onboarding-table">
      <thead>
        <tr>
          <th>候选人</th>
          <th>岗位 / 部门</th>
          <th>状态</th>
          <th>就绪度</th>
          <th>风险</th>
          <th>下一截止</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="row in rows"
          :key="row.onboarding.id"
          class="row-clickable"
          role="link"
          tabindex="0"
          @click="emit('open', row)"
          @keydown.enter="emit('open', row)"
        >
          <td>
            <strong class="candidate-name">{{ row.candidateName }}</strong>
            <span class="cell-meta">{{ row.offerCode }}</span>
          </td>
          <td>
            <span class="job-title">{{ row.jobTitle }}</span>
            <span class="cell-meta">{{ row.department || '部门未补充' }}</span>
          </td>
          <td><StatusTag :status="row.onboarding.status" /></td>
          <td>
            <div class="readiness">
              <span class="readiness-track" aria-hidden="true"><span :style="{ width: `${row.readiness}%` }" /></span>
              <strong>{{ row.readiness }}%</strong>
            </div>
            <span class="cell-meta">{{ row.requiredTasksRemaining }} 项必选任务待完成</span>
          </td>
          <td>
            <span v-if="row.highRiskReasons.length" class="risk-badge" :title="row.highRiskReasons.join('；')">高风险 {{ row.highRiskReasons.length }}</span>
            <span v-else class="risk-normal">正常</span>
            <span v-if="row.overdueTasks" class="cell-meta">{{ row.overdueTasks }} 项逾期</span>
          </td>
          <td>{{ row.nextDueDate || '暂无截止日期' }}</td>
          <td><button class="btn btn-ghost" type="button" @click.stop="emit('open', row)">进入工作台</button></td>
        </tr>
        <tr v-if="!rows.length">
          <td class="table-empty" colspan="7">暂无符合条件的入职归档。可在「录用审批与 Offer」中将已接受 Offer 执行「入职归档」。</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.row-clickable { cursor: pointer; }
.row-clickable:hover td { background: #f8fbfd; }
.candidate-name, .job-title { display: block; color: #27465f; font-weight: 650; }
.cell-meta { display: block; margin-top: 4px; color: #8aa0b2; font-size: 11px; line-height: 1.35; }
.readiness { display: flex; align-items: center; gap: 8px; min-width: 118px; }
.readiness strong { flex: 0 0 auto; color: #3c5d74; font-size: 12px; }
.readiness-track { display: block; width: 66px; height: 6px; overflow: hidden; border-radius: 999px; background: #e9f0f5; }
.readiness-track span { display: block; height: 100%; border-radius: inherit; background: #3cb38a; }
.risk-badge { display: inline-flex; padding: 3px 7px; border: 1px solid #fecdd3; border-radius: 999px; background: #fff1f2; color: #be123c; font-size: 11px; font-weight: 650; }
.risk-normal { color: #278666; font-size: 12px; }
@media (max-width: 720px) {
  .onboarding-table { min-width: 840px; }
}
</style>
