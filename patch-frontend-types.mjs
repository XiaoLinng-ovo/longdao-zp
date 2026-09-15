import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const fs = require('fs')
const path = require('path')
const ROOT = process.cwd()

function read(file) { return fs.readFileSync(file, 'utf8') }
function write(file, content) { fs.writeFileSync(file, content, 'utf8') }

function replaceOne(source, search, replacement) {
  if (!source.includes(search)) throw new Error('missing search: ' + JSON.stringify(search.slice(0, 120)))
  return source.replace(search, replacement)
}

const workflowPath = path.join(ROOT, 'web/src/modules/requisitions/workflow.ts')
let workflow = read(workflowPath)
workflow = replaceOne(workflow, `export const REQ_ACTION_LABEL: Record<RequisitionAction, string> = {
  submit: '提交审批',
  resubmit: '重新提交',
  approve: '审批通过',
  reject: '驳回',
  withdraw: '撤回',
  close: '关闭',
  cancel: '取消',
}`, `export const REQ_ACTION_LABEL: Record<RequisitionAction, string> = {
  submit: '提交审批',
  resubmit: '重新提交',
  approve: '审批通过',
  reject: '驳回',
  withdraw: '撤回',
  close: '关闭',
  cancel: '取消',
  convert: '转换为岗位',
}`)
write(workflowPath, workflow)

const detailPath = path.join(ROOT, 'web/src/modules/requisitions/pages/RequisitionDetailPage.vue')
let detail = read(detailPath)
detail = replaceOne(detail, `<StatusTag :status="approvalInfo.status" />`, `<StatusTag :status="approvalInfo.status as string" />`)
write(detailPath, detail)

const jobListPath = path.join(ROOT, 'web/src/modules/jobs/pages/JobListPage.vue')
let jobList = read(jobListPath)
jobList = replaceOne(jobList, "import { createJob, jobAction, loadJobs, type JobAction, type JobView } from '../api'", "import { apiClient } from '../../../shared/api'\nimport { createJob, jobAction, loadJobs, type JobAction, type JobView } from '../api'")
write(jobListPath, jobList)

const jobDetailPath = path.join(ROOT, 'web/src/modules/jobs/pages/JobDetailPage.vue')
let jobDetail = read(jobDetailPath)
jobDetail = replaceOne(jobDetail, "import { createJob, getJob, jobAction, loadJobs, updateJob, type ApiJob, type JobAction, type JobView, type UpdateJobInput } from '../api'", "import { apiClient } from '../../../shared/api'\nimport { createJob, createJd, createSpec, getJob, jobAction, jobStatusLabel, loadJobs, updateJob, type ApiJob, type CreateSpecInput, type JobAction, type JobRequirement, type JobView, type UpdateJobInput } from '../api'")
const duplicateBlock = `async function submitSpec() {
  if (acting.value || !job.value) return
  if (!specForm.value.title.trim() || !specForm.value.summary.trim()) {
    error.value = '请填写说明书标题与摘要'
    return
  }
  const payload: CreateSpecInput = {
    title: specForm.value.title.trim(),
    summary: specForm.value.summary.trim(),
    responsibilities: splitList(specForm.value.responsibilitiesText),
    requirements: specForm.value.requirements.filter((item) => item.label.trim()),
    skills: splitList(specForm.value.skillsText),
  }
  acting.value = true
  clearFlags()
  try {
    job.value = await createSpec(job.value.id, payload)
    specConfirmed.value = Boolean(job.value.spec?.confirmed)
    feedback.value = '岗位说明书已创建（未确认）'
    showSpec.value = false
  } catch (cause) {
    error.value = describeApiFailure(cause, '创建岗位说明书失败').message
  } finally {
    acting.value = false
  }
}`
jobDetail = replaceOne(jobDetail, duplicateBlock, '')
jobDetail = replaceOne(jobDetail, `async function submitJd() {
  if (acting.value || !job.value) return
  if (!jdForm.value.content.trim()) {
    error.value = '请填写 JD 内容'
    return
  }
  acting.value = true
  clearFlags()
  try {
    job.value = await createJd(job.value.id, { language: jdForm.value.language, content: jdForm.value.content.trim(), generatedBy: jdForm.value.generatedBy })
    jdConfirmed.value = Boolean(job.value.jd?.confirmed)
    feedback.value = 'JD 已创建（未确认）'
    showJd.value = false
  } catch (cause) {
    error.value = describeApiFailure(cause, '创建 JD 失败').message
  } finally {
    acting.value = false
  }
}`, '')
jobDetail = replaceOne(jobDetail, `async function runAction(action: JobAction) {
  if (acting.value || !job.value) return
  const value = reason.value.trim()
  if (JOB_REASON_REQUIRED.includes(action) && !value) return
  pendingAction.value = null
  acting.value = true
  clearFlags()
  try {
    job.value = await jobAction(job.value.id, action, value || undefined)
    specConfirmed.value = Boolean(job.value.spec?.confirmed)
    jdConfirmed.value = Boolean(job.value.jd?.confirmed)
    feedback.value = \`\${JOB_ACTION_LABEL[action]}成功，当前状态 \${jobStatusLabel(job.value.status)}\`
  } catch (cause) {
    error.value = describeApiFailure(cause, '岗位操作失败').message
  } finally {
    acting.value = false
  }
}`, '')
jobDetail = replaceOne(jobDetail, `function requirementText(item: JobRequirement): string {
  const parts = [item.label, item.description].filter(Boolean)
  return parts.join('：')
}`, '')
const duplicateHelpers = `function resetSpecForm() {
  const spec = job.value?.spec
  specForm.value = {
    title: spec?.title || job.value?.title || '',
    summary: spec?.summary || '',
    responsibilitiesText: (spec?.responsibilities || []).join('，'),
    skillsText: (spec?.skills || []).join('，'),
    requirements: (spec?.requirements || []).map((item) => ({ label: item.label, description: item.description, required: item.required ?? true, weight: item.weight })),
  }
  if (!specForm.value.requirements.length) specForm.value.requirements.push({ label: '', description: '', required: true })
}

function addRequirement() { specForm.value.requirements.push({ label: '', description: '', required: true }) }
function removeRequirement(index: number) { specForm.value.requirements.splice(index, 1) }`
jobDetail = replaceOne(jobDetail, duplicateHelpers, '')
jobDetail = replaceOne(jobDetail, `function openSpecForm() { resetSpecForm(); showSpec.value = true }
function openJdForm() { showJd.value = true }`, '')
jobDetail = replaceOne(jobDetail, `function applyDocQuery() {
  const doc = route.query.doc
  if (doc === 'spec') openSpecForm()
  else if (doc === 'jd') openJdForm()
}`, `function openSpecForm() {
  resetSpecForm()
  showSpec.value = true
}

function openJdForm() {
  showJd.value = true
}

function applyDocQuery() {
  const doc = route.query.doc
  if (doc === 'spec') openSpecForm()
  else if (doc === 'jd') openJdForm()
}`)
write(jobDetailPath, jobDetail)

console.log('patched workflow and frontend files')
