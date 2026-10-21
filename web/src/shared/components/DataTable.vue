<script setup lang="ts">
defineProps<{
  columns: readonly { key: string; label: string }[]
  rows: readonly Record<string, unknown>[]
  loading?: boolean
}>()
</script>

<template>
  <div class="table-wrap">
    <table>
      <thead>
        <tr><th v-for="column in columns" :key="column.key">{{ column.label }}</th></tr>
      </thead>
      <tbody v-if="!loading">
        <tr v-for="(row, index) in rows" :key="String(row.id ?? index)">
          <td v-for="column in columns" :key="column.key">
            <slot :name="`cell-${column.key}`" :row="row" :value="row[column.key]">{{ row[column.key] }}</slot>
          </td>
        </tr>
        <tr v-if="!rows.length"><td :colspan="columns.length" class="table-empty">暂无数据</td></tr>
      </tbody>
      <tbody v-else>
        <tr><td :colspan="columns.length" class="table-empty">加载中...</td></tr>
      </tbody>
    </table>
  </div>
</template>
