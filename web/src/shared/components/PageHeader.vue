<script setup lang="ts">
defineProps<{ title: string; description?: string }>()
</script>

<template>
  <div class="page-header">
    <div>
      <h2>{{ title }}</h2>
      <p v-if="description">{{ description }}</p>
      <slot name="meta" />
    </div>
    <slot />
  </div>
</template>
