<script setup lang="ts">
import ApiFeedback from './ApiFeedback.vue'

defineProps<{
  feedback: string
  error: string
}>()

const emit = defineEmits<{ 'clear-feedback': []; 'clear-error': [] }>()
</script>

<template>
  <ApiFeedback v-if="feedback" tone="success" dismissible :message="feedback" @dismiss="emit('clear-feedback')" />
  <ApiFeedback v-else-if="error" tone="error" dismissible :message="error" @dismiss="emit('clear-error')" />
</template>