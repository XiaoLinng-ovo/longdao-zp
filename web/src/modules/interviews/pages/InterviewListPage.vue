<script setup lang="ts">
import { listInterviews } from '../api'
import PageHeader from '../../../shared/components/PageHeader.vue'
import InterviewTable from '../components/InterviewTable.vue'

const rows = listInterviews()
</script>

<template>
  <PageHeader title="面试管理" description="安排面试并收集面试官反馈" />
  <InterviewTable :rows="rows" />
</template>
