import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const fs = require('fs');
function rd(p){ return fs.readFileSync(p,'utf8'); }
function wr(p,c){ fs.writeFileSync(p,c,'utf8'); }

// 1) Administration API -> real backend readiness/health checks
const admApi = `import { apiClient } from '../../../shared/api'

export interface AdminCheckRow {
  category: string
  owner: string
  status: 'configured' | 'active' | 'paused' | 'failed'
  detail: string
}

interface ReadyPayload {
  status: string
  checks: Record<string, string>
}

interface HealthPayload {
  status: string
  service: string
  version: string
  uptimeSeconds: number
}

export async function listAdminChecks(): Promise<AdminCheckRow[]> {
  const [ready, health] = await Promise.all([
    apiClient.getJson<ReadyPayload>('/ready'),
    apiClient.getJson<HealthPayload>('/health'),
  ])
  const checks = ready.data.checks || {}
  const configState = ready.data.status === 'ready' ? 'configured' : 'failed'
  return [
    { category: '服务就绪', owner: '系统管理员', status: configState, detail: ready.data.status === 'ready' ? 'API 就绪检查通过' : 'API 就绪检查未通过' },
    { category: '配置检查', owner: '系统管理员', status: 'configured', detail: checks.configuration || '—' },
    { category: '服务健康', owner: '系统管理员', status: health.data.status === 'ok' ? 'active' : 'failed', detail: health.data.service || '—' },
    { category: '服务版本', owner: '系统管理员', status: 'configured', detail: health.data.version || '—' },
    { category: '运行时长', owner: '系统管理员', status: 'configured', detail: \`\${Math.floor(health.data.uptimeSeconds || 0)} 秒\` },
    { category: '审批与模型服务', owner: '系统管理员', status: 'paused', detail: '尚未接入后端配置源，当前为占位展示' },
    { category: '文件与审计', owner: '系统管理员', status: 'paused', detail: '尚未接入 MinIO/审计数据源，当前为占位展示' },
  ]
}
`;
wr('web/src/modules/administration/api/index.ts', admApi);

// 2) Report statusStats empty-state section
const repPage = 'web/src/modules/reports/pages/ReportOverviewPage.vue';
let rp = rd(repPage);
const marker = `  <section class="section"><h3 class="section-title">渠道数据</h3>`;
const block = `  <section class="section"><h3 class="section-title">各阶段状态分布</h3><div class="table-wrap"><table><thead><tr><th>实体</th><th>状态</th><th>数量</th></tr></thead><tbody><tr v-for="row in report.statusStats" :key="row.entity+row.status"><td>{{ row.entity }}</td><td><StatusTag :status="row.status" /></td><td>{{ row.count }}</td></tr><tr v-if="!report.statusStats.length"><td colspan="3" class="table-empty">暂无状态分布数据</td></tr></tbody></table></div></section>
  <section class="section"><h3 class="section-title">渠道数据</h3>`;
if (!rp.includes(marker)) throw new Error('report statusStats marker missing');
rp = rp.replace(marker, block);
rp = rp.replace("import ReportMetricGrid from '../components/ReportMetricGrid.vue'", "import ReportMetricGrid from '../components/ReportMetricGrid.vue'\nimport StatusTag from '../../../shared/components/StatusTag.vue'");
wr(repPage, rp);

// 3) Interview empty-state guidance
const it = 'web/src/modules/interviews/components/InterviewTable.vue';
let t = rd(it);
t = t.replace(`<tr v-if="!rows.length">
          <td class="table-empty" colspan="8">暂无面试记录</td>
        </tr>`, `<tr v-if="!rows.length">
          <td class="table-empty" colspan="8">暂无面试记录，请先点击右上角「安排面试」发起面试</td>
        </tr>`);
wr(it, t);

console.log('done');
