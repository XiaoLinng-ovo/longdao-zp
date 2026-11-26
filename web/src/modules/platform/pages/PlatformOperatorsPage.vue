<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ChevronLeft, ChevronRight, RefreshCw, Search } from '@lucide/vue'
import { authSession } from '../../auth/session'
import { describeApiFailure } from '../../../shared/utils/errorMessage'
import { listPlatformOperators, type OperatorDirectory, type OperatorRole } from '../api/operators'

const allowed = computed(() => authSession.user?.isSystemAdmin === true)
const directory = ref<OperatorDirectory>({ items: [], total: 0, page: 1, pageSize: 20, recentAudit: [] })
const query = ref('')
const filter = ref('')
const page = ref(1)
const loading = ref(false)
const error = ref('')
const pages = computed(() => Math.max(1, Math.ceil(directory.value.total / 20)))
const roleName = (value: OperatorRole) => value === 'admin' ? '历史管理员（已失效）' : value === 'viewer' ? '历史只读身份（已失效）' : '无历史授权'
async function load(reset = false) {
  if (!allowed.value || loading.value) return
  if (reset) page.value = 1
  loading.value = true
  error.value = ''
  try { directory.value = await listPlatformOperators({ q: query.value, platformRole: filter.value, page: page.value }) }
  catch (cause) { error.value = describeApiFailure(cause, '读取历史平台授权失败').message }
  finally { loading.value = false }
}
async function turn(delta: number) { page.value += delta; await load() }
onMounted(() => load())
</script>

<template>
  <main class="operators-page">
    <header class="page-heading"><div><h1>历史平台授权</h1><span class="identity">系统管理员</span></div>
      <button v-if="allowed" class="icon-button" type="button" title="刷新授权列表" aria-label="刷新授权列表" :disabled="loading" @click="load()"><RefreshCw :size="17" /></button>
    </header>
    <p v-if="!allowed" class="error-note" role="alert">仅系统管理员可以查看历史平台授权。</p>
    <template v-else>
      <p class="notice" role="status">旧授权已停用，不再产生平台访问权限。</p>
      <form class="filters" @submit.prevent="load(true)">
        <label class="search"><Search :size="16" /><input v-model="query" aria-label="搜索账号" maxlength="120" placeholder="姓名、邮箱或账号编号" :disabled="loading" /></label>
        <select v-model="filter" aria-label="历史授权身份筛选" :disabled="loading" @change="load(true)"><option value="">全部身份</option><option value="admin">历史管理员</option><option value="viewer">历史只读身份</option><option value="none">无历史授权</option></select>
        <button type="submit" :disabled="loading"><Search :size="15" />查询</button>
        <span class="total">{{ directory.total }} 个账号</span>
      </form>
      <p v-if="error" class="error-note" role="alert">{{ error }} <button type="button" @click="load()"><RefreshCw :size="14" />重试</button></p>
      <div class="table-wrap" :aria-busy="loading">
        <table><thead><tr><th>账号</th><th>账号编号</th><th>状态</th><th>平台运营身份</th></tr></thead>
          <tbody><tr v-for="account in directory.items" :key="account.id"><td><strong>{{ account.displayName }}</strong><small>{{ account.email }}</small></td><td class="account-code">{{ account.userNo }}</td><td><span :class="['status', { disabled: !account.isActive }]">{{ account.isActive ? '启用' : '停用' }}</span></td><td>{{ roleName(account.platformRole) }}</td></tr>
            <tr v-if="!directory.items.length"><td colspan="4" class="empty">{{ loading ? '正在读取账号...' : error ? '账号列表暂不可用' : '没有符合条件的账号' }}</td></tr>
          </tbody>
        </table>
      </div>
      <nav class="pagination" aria-label="账号分页"><span>第 {{ page }} / {{ pages }} 页</span><div><button type="button" class="icon-button" title="上一页" aria-label="上一页" :disabled="page <= 1 || loading" @click="turn(-1)"><ChevronLeft :size="16" /></button><button type="button" class="icon-button" title="下一页" aria-label="下一页" :disabled="page >= pages || loading" @click="turn(1)"><ChevronRight :size="16" /></button></div></nav>
      <section class="audit-section"><h2>最近授权记录</h2><div class="table-wrap"><table><thead><tr><th>时间</th><th>操作人</th><th>目标账号</th><th>权限变更</th><th>原因</th></tr></thead><tbody><tr v-for="audit in directory.recentAudit" :key="audit.id"><td>{{ new Date(audit.createdAt).toLocaleString('zh-CN') }}</td><td>{{ audit.actorName }}</td><td>{{ audit.targetEmail }}</td><td>{{ roleName(audit.beforeRole) }} → {{ roleName(audit.afterRole) }}</td><td>{{ audit.reason }}</td></tr><tr v-if="!directory.recentAudit.length"><td colspan="5" class="empty">暂无授权记录</td></tr></tbody></table></div></section>
    </template>
  </main>
</template>

<style scoped>
.operators-page { padding: 24px; color: #293d35; }
.page-heading, .page-heading > div, .filters, .pagination, .pagination > div, button { display: flex; align-items: center; gap: 10px; }
.page-heading, .pagination { justify-content: space-between; }
h1 { margin: 0; font-size: 22px; } h2 { margin: 0; font-size: 16px; }
.identity { color: #606b78; background: #edf0f5; border-radius: 4px; padding: 4px 8px; font-size: 12px; }
.filters { flex-wrap: wrap; margin: 22px 0 16px; }
.search { display: flex; align-items: center; gap: 8px; flex: 1 1 260px; min-width: 0; max-width: 440px; border: 1px solid #d5ded9; border-radius: 5px; padding: 0 10px; background: white; }
.search input { width: 100%; border: 0; padding: 0; min-width: 0; outline: none; }
input, select, textarea, button { font: inherit; font-size: 13px; color: inherit; }
input, select, button { min-height: 36px; }
select, textarea, button { border: 1px solid #d5ded9; background: white; border-radius: 5px; padding: 6px 10px; }
button { justify-content: center; cursor: pointer; } button:disabled { opacity: .5; cursor: not-allowed; }
.icon-button { width: 36px; height: 36px; flex: 0 0 36px; padding: 0; }
.total, .pagination { color: #65776e; font-size: 12px; }
.table-wrap { overflow-x: auto; border-top: 1px solid #dce5df; border-bottom: 1px solid #dce5df; background: #fff; }
table { width: 100%; border-collapse: collapse; text-align: left; font-size: 13px; }
th { color: #64766b; background: #f3f6f4; font-weight: 600; }
th, td { padding: 12px; border-bottom: 1px solid #e7ece9; overflow-wrap: anywhere; }
td { min-width: 100px; } td:first-child { min-width: 210px; }
td strong, td small { display: block; } td small { color: #6a7a72; margin-top: 5px; }
.account-code { font-family: monospace; white-space: nowrap; }
.status { color: #236f55; } .status.disabled { color: #a74b56; }
.actions { width: 120px; white-space: nowrap; }
.text-button { border: 0; padding: 0; background: transparent; color: #246e56; }
.empty { padding: 34px; text-align: center; color: #728178; }
.pagination { padding: 12px 0; } .audit-section { margin-top: 24px; } .audit-section h2 { margin-bottom: 12px; }
.notice { color: #236f55; background: #eaf6ee; padding: 10px 12px; border-left: 3px solid #328264; }
.error-note { color: #a53e4b; font-size: 13px; overflow-wrap: anywhere; }
@media (max-width: 600px) { .operators-page { padding: 16px; } .search { max-width: none; } }
</style>
