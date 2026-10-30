<script setup lang="ts">
import type { Status } from '../types/recruiting'
import { STATUS_LABEL } from '../utils/labels'

defineProps<{ status: Status | string }>()
</script>

<template>
  <span class="status-tag" :class="`status-${status}`">
    <span class="status-bullet" aria-hidden="true"></span>
    {{ STATUS_LABEL[status] ?? status }}
  </span>
</template>
