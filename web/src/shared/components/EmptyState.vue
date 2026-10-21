<script setup lang="ts">
withDefaults(defineProps<{
  title?: string
  description?: string
  loading?: boolean
}>(), {
  title: '暂无数据',
  description: '当前没有可展示的记录',
})
</script>

<template>
  <div class="empty-state" role="status">
    <strong>{{ loading ? '正在加载...' : title }}</strong>
    <p>{{ loading ? '请稍候' : description }}</p>
  </div>
</template>
