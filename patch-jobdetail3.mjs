import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const fs = require('fs');
function rd(p){ return fs.readFileSync(p,'utf8'); }
function wr(p,c){ fs.writeFileSync(p,c,'utf8'); }
let s = rd('web/src/modules/jobs/pages/JobDetailPage.vue');
s = s.replace("import { createJob, createJd, createSpec, getJob, jobAction, jobStatusLabel, loadJobs, updateJob, type ApiJob, type CreateSpecInput, type JobAction, type JobRequirement, type JobView, type UpdateJobInput } from '../api'", "import { createJob, createJd, createSpec, getJob, jobAction, loadJobs, updateJob, type ApiJob, type CreateSpecInput, type JobAction, type JobRequirement, type JobView, type UpdateJobInput } from '../api'");
s = s.replace("import { JOB_ACTION_HINT, JOB_ACTION_LABEL, JOB_REASON_REQUIRED, JOB_STATUS_LABEL, editableFieldsForStatus, jobActionsFor, jobPublishHint, validateJobForm } from '../workflow'", "import { JOB_ACTION_HINT, JOB_ACTION_LABEL, JOB_REASON_REQUIRED, JOB_STATUS_LABEL, editableFieldsForStatus, jobActionsFor, jobPublishHint, jobStatusLabel, validateJobForm } from '../workflow'");
s = s.replace(`:disabled="acting === action || (action === 'publish' && publishDisabled)"`, `:disabled="acting || (action === 'publish' && publishDisabled)"`);
s = s.replace(`{{ acting === action ? '处理中...' : JOB_ACTION_LABEL[action] }}`, `{{ acting ? '处理中...' : JOB_ACTION_LABEL[action] }}`);
wr('web/src/modules/jobs/pages/JobDetailPage.vue', s);
console.log('fixed job detail imports and boolean bindings');
