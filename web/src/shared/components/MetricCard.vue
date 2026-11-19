<script setup lang="ts">
import type { Metric } from '../types/recruiting'

defineProps<{ metric: Metric }>()
</script>

<template>
  <article class="metric-card" :class="`tone-${metric.tone ?? 'teal'}`">
    <div class="metric-topline"><span>{{ metric.label }}</span><span class="metric-icon" aria-hidden="true">{{ metric.tone === 'blue' ? '✦' : metric.tone === 'amber' ? '◒' : metric.tone === 'red' ? '✓' : '▤' }}</span></div>
    <strong>{{ metric.value }}</strong>
    <small v-if="metric.trend">{{ metric.trend }}</small>
  </article>
</template>
