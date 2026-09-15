import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const fs = require('fs');
function rd(p){ return fs.readFileSync(p,'utf8'); }
function wr(p,c){ fs.writeFileSync(p,c,'utf8'); }
const p = 'web/src/modules/administration/pages/AdministrationPage.vue';
let s = rd(p);
s = s.replace(`<script setup lang="ts">
import { listAdminChecks } from '../api'
import PageHeader from '../../../shared/components/PageHeader.vue'
import StatusTag from '../../../shared/components/StatusTag.vue'
import SecurityNotice from '../components/SecurityNotice.vue'

const rows = listAdminChecks()
</script>`, `<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { listAdminChecks, type AdminCheckRow } from '../api'
import PageHeader from '../../../shared/components/PageHeader.vue'
import StatusTag from '../../../shared/components/StatusTag.vue'
import SecurityNotice from '../components/SecurityNotice.vue'

const rows = ref<AdminCheckRow[]>([])
const loading = ref(true)
const error = ref('')
async function refresh() {
  loading.value = true
  error.value = ''
  try {
    rows.value = await listAdminChecks()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '读取系统配置失败'
  } finally {
    loading.value = false
  }
}
onMounted(refresh)
</script>`);
s = s.replace(`<PageHeader title="管理后台" description="查看招聘团队、流程与系统服务配置" />
  <div class="table-wrap">`, `<PageHeader title="管理后台" description="查看招聘团队、流程与系统服务配置">
    <button class="btn btn-ghost" type="button" :disabled="loading" @click="refresh">刷新</button>
  </PageHeader>
  <div v-if="loading" class="loading-note">正在读取系统配置...</div>
  <div v-else-if="error" class="error-note" role="alert">{{ error }} <button class="btn btn-ghost" type="button" @click="refresh">重试</button></div>
  <div v-else class="table-wrap">`);
wr(p, s);
console.log('done');
