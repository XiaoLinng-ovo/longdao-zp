<script setup lang="ts">
import type { Report } from '../../../shared/types/recruiting'
import MetricCard from '../../../shared/components/MetricCard.vue'
defineProps<{ rows: readonly Report[] }>()
</script>

<template><div class="metric-grid"><MetricCard v-for="row in rows" :key="row.label" :metric="{ label: row.label, value: row.value, trend: row.detail, tone: 'teal' }" /></div></template>
