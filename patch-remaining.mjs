import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const fs = require('fs');

function rd(p){ return fs.readFileSync(p,'utf8'); }
function wr(p,c){ fs.writeFileSync(p,c,'utf8'); }

// Requisition detail: boolean disabled bindings
let d = rd('web/src/modules/requisitions/pages/RequisitionDetailPage.vue');
d = d.replace(`:disabled="acting" @click="openEdit"`, `:disabled="!!acting" @click="openEdit"`);
d = d.replace(`class="btn btn-primary" type="button" :disabled="acting" @click="openConvert"`, `class="btn btn-primary" type="button" :disabled="!!acting" @click="openConvert"`);
// workflow REQ_ACTION_HINT add convert
d = d.replace(`  close: '关闭需求并归档当前编制申请。',
  cancel: '取消需求后流程终止，仅草稿/待审批/已驳回可取消。',
}`, `  close: '关闭需求并归档当前编制申请。',
  cancel: '取消需求后流程终止，仅草稿/待审批/已驳回可取消。',
  convert: '将已通过需求转换为招聘岗位，进入岗位管理。',
}`);
wr('web/src/modules/requisitions/pages/RequisitionDetailPage.vue', d);

// workflow.ts convert hint
let w = rd('web/src/modules/requisitions/workflow.ts');
w = w.replace(`  close: '关闭需求并归档当前编制申请。',
  cancel: '取消需求后流程终止，仅草稿/待审批/已驳回可取消。',
}`, `  close: '关闭需求并归档当前编制申请。',
  cancel: '取消需求后流程终止，仅草稿/待审批/已驳回可取消。',
  convert: '将已通过需求转换为招聘岗位，进入岗位管理。',
}`);
wr('web/src/modules/requisitions/workflow.ts', w);

// Requisition list actionDescription guard
let l = rd('web/src/modules/requisitions/pages/RequisitionListPage.vue');
const oldDesc = `const actionDescription = computed(() => ({ submit: '草稿提交后进入审批', resubmit: '驳回后可重新提交', approve: '全部审批通过后状态变为已通过', reject: '驳回需填写原因', withdraw: '撤回后进入已撤回', close: '关闭后归档该需求', cancel: '取消草稿/待审批/已驳回需求', convert: '将已通过需求转换为岗位' }[actingAction.value] || ''))`;
const newDesc = `const actionDescription = computed(() => {
  const map: Record<RequisitionAction, string> = { submit: '草稿提交后进入审批', resubmit: '驳回后可重新提交', approve: '全部审批通过后状态变为已通过', reject: '驳回需填写原因', withdraw: '撤回后进入已撤回', close: '关闭后归档该需求', cancel: '取消草稿/待审批/已驳回需求', convert: '将已通过需求转换为岗位' }
  return actingAction.value ? (map[actingAction.value] || '') : ''
})`;
if (!l.includes(oldDesc)) throw new Error('requisition list desc not found');
l = l.replace(oldDesc, newDesc);
wr('web/src/modules/requisitions/pages/RequisitionListPage.vue', l);

// Job list apiClient import
let jl = rd('web/src/modules/jobs/pages/JobListPage.vue');
jl = jl.replace("import { createJob, jobAction, loadJobs, type JobAction, type JobView } from '../api'", "import { apiClient } from '../../../shared/api'\nimport { createJob, jobAction, loadJobs, type JobAction, type JobView } from '../api'");
wr('web/src/modules/jobs/pages/JobListPage.vue', jl);

console.log('patched remaining frontend files');
