<script setup lang="ts">
import type { Metric } from '../types/recruiting'

defineProps<{ metric: Metric }>()
</script>

<template>
  <article class="metric-card" :class="`tone-${metric.tone ?? 'teal'}`">
    <span>{{ metric.label }}</span>
    <strong>{{ metric.value }}</strong>
    <small v-if="metric.trend">{{ metric.trend }}</small>
  </article>
</template>
