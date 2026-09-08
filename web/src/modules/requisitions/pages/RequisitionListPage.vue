<script setup lang="ts">
import { computed, ref } from 'vue'
import { listRequisitions } from '../api'
import PageHeader from '../../../shared/components/PageHeader.vue'
import RequisitionTable from '../components/RequisitionTable.vue'
const filter = ref('all')
const rows = computed(() => listRequisitions().filter((row) => filter.value === 'all' || row.status === filter.value))
</script>
<template>
  <PageHeader title="招聘需求" description="统一管理部门招聘编制与审批进度">
    <select v-model="filter" class="filter" aria-label="按状态筛选">
      <option value="all">全部状态</option>
      <option value="pending">待处理</option>
      <option value="approved">已通过</option>
      <option value="draft">草稿</option>
    </select>
  </PageHeader>
  <RequisitionTable :rows="rows" />
</template>
