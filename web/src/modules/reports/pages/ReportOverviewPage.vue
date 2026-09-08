<script setup lang="ts">
import { listReports } from '../api'
import PageHeader from '../../../shared/components/PageHeader.vue'
import ReportMetricGrid from '../components/ReportMetricGrid.vue'

const rows = listReports()
</script>

<template>
  <PageHeader title="招聘报表" description="从漏斗、渠道与效率维度查看招聘表现" />
  <ReportMetricGrid :rows="rows.slice(0, 4)" />
  <section class="section">
    <h3 class="section-title">分析摘要</h3>
    <div class="table-wrap">
      <table>
        <thead><tr><th>指标</th><th>结果</th><th>说明</th></tr></thead>
        <tbody>
          <tr v-for="row in rows.slice(4)" :key="row.label"><td>{{ row.label }}</td><td><strong>{{ row.value }}</strong></td><td>{{ row.detail }}</td></tr>
          <tr v-if="rows.length <= 4"><td colspan="3" class="table-empty">暂无摘要</td></tr>
        </tbody>
      </table>
    </div>
  </section>
</template>
