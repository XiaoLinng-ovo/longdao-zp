<script setup lang="ts">
import type { OnboardingRow } from '../api'
import { ONBOARDING_STATUS_LABEL } from '../api'
import StatusTag from '../../../shared/components/StatusTag.vue'

defineProps<{ rows: OnboardingRow[] }>()
const emit = defineEmits<{ open: [row: OnboardingRow] }>()
</script>

<template>
  <div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th>候选人</th>
          <th>岗位</th>
          <th>状态</th>
          <th>计划入职</th>
          <th>归档时间</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="row.id">
          <td><a class="row-link" href="#" @click.prevent="emit('open', row)">{{ row.candidate }}</a></td>
          <td>{{ row.job }}</td>
          <td><StatusTag :status="row.status" /></td>
          <td>{{ row.plannedStartDate || '未排期' }}</td>
          <td>{{ row.archivedAt || '—' }}</td>
          <td><button class="btn btn-ghost" type="button" @click="emit('open', row)">详情</button></td>
        </tr>
        <tr v-if="!rows.length">
          <td class="table-empty" colspan="6">暂无入职归档记录。可在「录用审批与 Offer」中将已接受 Offer 执行「入职归档」。</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.row-link { color: var(--primary); font-weight: 500 }
.row-link:hover { text-decoration: underline }
</style>
