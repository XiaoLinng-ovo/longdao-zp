<script setup lang="ts">
defineProps<{ title: string }>()
</script>

<template>
  <header class="topbar">
    <div>
      <p class="eyebrow">RECRUITING OPERATIONS</p>
      <h1>{{ title }}</h1>
    </div>
    <div class="topbar-user">
      <span class="status-dot" aria-hidden="true"></span>
      <span>招聘团队</span>
      <span class="avatar" aria-hidden="true">招</span>
    </div>
  </header>
</template>
