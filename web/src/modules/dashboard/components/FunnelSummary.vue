<script setup lang="ts">
defineProps<{ steps: readonly { label: string; value: string | number }[] }>()
</script>

<template>
  <div class="funnel" aria-label="招聘漏斗">
    <div v-for="step in steps" :key="step.label" class="funnel-step">
      <strong>{{ step.value }}</strong>
      <span>{{ step.label }}</span>
    </div>
  </div>
</template>
