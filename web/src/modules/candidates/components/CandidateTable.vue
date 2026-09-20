<script setup lang="ts">
import type { Candidate } from '../../../shared/types/recruiting'
import StatusTag from '../../../shared/components/StatusTag.vue'
defineProps<{ rows: readonly Candidate[] }>()
const emit = defineEmits<{ open: [row: Candidate] }>()
</script>

<template>
  <div class="table-wrap"><table><thead><tr><th>候选人</th><th>应聘岗位</th><th>标签</th><th>综合评分</th><th>AI 分析</th><th>申请状态</th><th>更新时间</th><th class="op-col">操作</th></tr></thead>
    <tbody>
      <tr v-for="row in rows" :key="row.id">
        <td>
          <button class="name-link" type="button" @click="emit('open', row)"><strong>{{ row.name }}</strong></button>
        </td>
        <td>{{ row.job }}</td>
        <td><span class="tag-list">{{ (row.tags || []).join('、') || '—' }}</span></td>
        <td><strong>{{ row.score }}</strong>/100</td>
        <td>
          <div class="analysis-progress">
            <div class="progress-head">
              <StatusTag :status="row.analysisStatus || row.aiStatus" />
              <span>{{ row.analysisProgress ?? (row.aiStatus === 'completed' ? 100 : 0) }}%</span>
            </div>
            <div class="progress-track">
              <span
                class="progress-value"
                :class="{ failed: row.analysisStatus === 'failed', completed: row.analysisStatus === 'completed' || row.aiStatus === 'completed' }"
                :style="{ width: `${row.analysisProgress ?? (row.aiStatus === 'completed' ? 100 : 0)}%` }"
              ></span>
            </div>
            <small v-if="row.analysisError" class="progress-error" :title="row.analysisError">{{ row.analysisError }}</small>
          </div>
        </td>
        <td><StatusTag :status="row.applicationStatus" /></td>
        <td>{{ row.updatedAt }}</td>
        <td><button class="btn btn-ghost btn-sm" type="button" @click="emit('open', row)">详情</button></td>
      </tr>
      <tr v-if="!rows.length"><td colspan="8" class="table-empty">暂无数据</td></tr>
    </tbody>
  </table></div>
</template>

<style scoped>
.tag-list { font-size: 12px; color: #334155; }
.analysis-progress { min-width: 120px; }
.progress-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 6px; color: var(--muted); font-size: 11px; }
.progress-track { height: 6px; overflow: hidden; border-radius: 999px; background: #e2e8f0; }
.progress-value { display: block; height: 100%; border-radius: inherit; background: #d97706; transition: width .25s ease; }
.progress-value.completed { background: #16a34a; }
.progress-value.failed { background: #dc2626; }
.progress-error { display: block; max-width: 180px; margin-top: 5px; overflow: hidden; color: #b91c1c; font-size: 10.5px; text-overflow: ellipsis; white-space: nowrap; }
.name-link { border: 0; background: transparent; padding: 0; color: var(--primary); cursor: pointer; }
.name-link:hover { text-decoration: underline; }
.muted { display: block; margin-top: 5px; font-size: 11px; color: var(--muted); }
.op-col { width: 80px; }
.btn-sm { padding: 4px 8px; font-size: 11.5px; }
</style>
