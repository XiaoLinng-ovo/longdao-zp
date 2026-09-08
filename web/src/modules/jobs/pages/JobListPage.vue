<script setup lang="ts">
import { listJobs } from '../api'
import PageHeader from '../../../shared/components/PageHeader.vue'
import JobTable from '../components/JobTable.vue'

const rows = listJobs()
</script>

<template>
  <PageHeader title="岗位管理" description="维护职位说明与发布渠道" />
  <JobTable :rows="rows" />
</template>
