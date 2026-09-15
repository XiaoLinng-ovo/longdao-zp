import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const fs = require('fs');
const p = 'web/src/modules/jobs/pages/JobDetailPage.vue';
let s = fs.readFileSync(p, 'utf8');

function mustReplace(search, replacement) {
  if (!s.includes(search)) { throw new Error('MISSING: ' + JSON.stringify(search.slice(0, 100))); }
  s = s.replace(search, replacement);
}

mustReplace(
  "import { createJob, getJob, jobAction, loadJobs, updateJob, type ApiJob, type JobAction, type JobView, type UpdateJobInput } from '../api'",
  "import { apiClient } from '../../../shared/api'\nimport { createJob, createJd, createSpec, getJob, jobAction, jobStatusLabel, loadJobs, updateJob, type ApiJob, type CreateSpecInput, type JobAction, type JobRequirement, type JobView, type UpdateJobInput } from '../api'"
);

const blocks = [
  `function resetSpecForm() {
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
function removeRequirement(index: number) { specForm.value.requirements.splice(index, 1) }

function openSpecForm() { resetSpecForm(); showSpec.value = true }
function openJdForm() { showJd.value = true }`,
  `function requirementText(item: JobRequirement): string {
  const parts = [item.label, item.description].filter(Boolean)
  return parts.join('：')
}

function resetSpecForm() {
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
function removeRequirement(index: number) { specForm.value.requirements.splice(index, 1) }

function openSpecForm() { resetSpecForm(); showSpec.value = true }
function openJdForm() { showJd.value = true }`
];

for (const b of blocks) {
  const first = s.indexOf(b);
  const second = s.indexOf(b, first + b.length);
  if (first === -1) { console.log('SKIP BLOCK (absent):', JSON.stringify(b.slice(0, 60))); continue; }
  if (second === -1) { console.log('SINGLE OCCURRENCE, skip'); continue; }
  const replacement = `function requirementText(item: JobRequirement): string {
  const parts = [item.label, item.description].filter(Boolean)
  return parts.join('：')
}

function openSpecForm() {
  resetSpecForm()
  showSpec.value = true
}

function openJdForm() {
  showJd.value = true
}`;
  s = s.slice(0, second) + replacement + s.slice(second + b.length);
  console.log('REPLACED SECOND BLOCK');
}

mustReplace(`:disabled="acting"
        @click="confirm(action)"`, `:disabled="acting === action || (action === 'publish' && publishDisabled)"
        @click="confirm(action)"`);

fs.writeFileSync(p, s, 'utf8');
console.log('DONE');
