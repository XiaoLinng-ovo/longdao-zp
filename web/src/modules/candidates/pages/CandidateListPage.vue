<script setup lang="ts">
import { listCandidates } from '../api'
import PageHeader from '../../../shared/components/PageHeader.vue'
import CandidateTable from '../components/CandidateTable.vue'

const rows = listCandidates()
</script>

<template>
  <PageHeader title="候选人" description="跟踪候选人评估、面试和申请状态" />
  <CandidateTable :rows="rows" />
</template>
