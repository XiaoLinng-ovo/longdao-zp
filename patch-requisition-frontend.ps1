import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const fs = require('fs')
const path = require('path')

function read(file) { return fs.readFileSync(file, 'utf8') }
function write(file, content) { fs.writeFileSync(file, content, 'utf8') }

const reqFile = path.resolve('web/src/modules/requisitions/pages/RequisitionListPage.vue')
let req = read(reqFile)
req = req.replace("const form = ref({ title: '', departmentId: '', headcount: 1, employmentType: 'full_time', workMode: 'hybrid', location: '', salaryRangeMin: '', salaryRangeMax: '', justification: '' })", "const form = ref({ title: '', departmentId: '', hiringManagerId: '', headcount: 1, employmentType: 'full_time', workMode: 'hybrid', location: '', salaryRangeMin: '', salaryRangeMax: '', justification: '' })")
req = req.replace(`const payload = {
    title: form.value.title,
    departmentId: form.value.departmentId,
    headcount: Number(form.value.headcount),
    employmentType: form.value.employmentType,
    workMode: form.value.workMode,
    location: form.value.location || undefined,
    justification: form.value.justification,
    salaryRange: {
      ...(form.value.salaryRangeMin ? { min: { amount: Number(form.value.salaryRangeMin), currency: 'CNY' } } : {}),
      ...(form.value.salaryRangeMax ? { max: { amount: Number(form.value.salaryRangeMax), currency: 'CNY' } } : {}),
    },
  }`, `const payload = {
    title: form.value.title.trim(),
    departmentId: form.value.departmentId.trim(),
    hiringManagerId: form.value.hiringManagerId.trim() || undefined,
    headcount: Number(form.value.headcount),
    employmentType: form.value.employmentType,
    workMode: form.value.workMode,
    location: form.value.location.trim() || undefined,
    justification: form.value.justification.trim(),
    salaryRange: {
      ...(form.value.salaryRangeMin ? { min: { amount: Number(form.value.salaryRangeMin), currency: 'CNY' } } : {}),
      ...(form.value.salaryRangeMax ? { max: { amount: Number(form.value.salaryRangeMax), currency: 'CNY' } } : {}),
    },
  }`)
req = req.replace(`form.value = { title: '', departmentId: '', headcount: 1, employmentType: 'full_time', workMode: 'hybrid', location: '', salaryRangeMin: '', salaryRangeMax: '', justification: '' }`, "form.value = { title: '', departmentId: '', hiringManagerId: '', headcount: 1, employmentType: 'full_time', workMode: 'hybrid', location: '', salaryRangeMin: '', salaryRangeMax: '', justification: '' }")
req = req.replace(`<div class="form-field"><label>部门 <span class="required">*</span></label><input v-model="form.departmentId" placeholder="例如：技术中心" /></div>
      <div class="form-field"><label>招聘人数 <span class="required">*</span></label><input v-model.number="form.headcount" type="number" min="1" /></div>`, `<div class="form-field"><label>部门 <span class="required">*</span></label><input v-model="form.departmentId" placeholder="例如：技术中心" /></div>
      <div class="form-field"><label>招聘负责人</label><input v-model="form.hiringManagerId" placeholder="例如：张三" /></div>
      <div class="form-field"><label>招聘人数 <span class="required">*</span></label><input v-model.number="form.headcount" type="number" min="1" /></div>`)
req = req.replace(`<div class="form-field" style="grid-column: 1 / -1"><label>招聘理由 <span class="required">*</span></label><input v-model="form.justification" placeholder="说明招聘背景、业务影响和到岗时间" /></div>`, `<div class="form-field" style="grid-column: 1 / -1"><label>招聘理由 <span class="required">*</span></label><textarea v-model="form.justification" rows="3" placeholder="说明招聘背景、业务影响和到岗时间"></textarea></div>`)
write(reqFile, req)

const detailFile = path.resolve('web/src/modules/requisitions/pages/RequisitionDetailPage.vue')
let detail = read(detailFile)
detail = detail.replace(`    <div class="detail-item"><span>工作地点</span><strong>{{ request.location || '未设置' }}</strong></div>
    <div class="detail-item"><span>审批人</span><strong>{{ approvalInfo.approver }}</strong></div>`, `    <div class="detail-item"><span>工作地点</span><strong>{{ request.location || '未设置' }}</strong></div>
    <div class="detail-item"><span>招聘负责人</span><strong>{{ request.requesterId || '待指定' }}</strong></div>
    <div class="detail-item"><span>预算范围</span><strong>{{ request.salaryRange ? \`\${request.salaryRange.min?.amount || 0} - \${request.salaryRange.max?.amount || '∞'} \${request.salaryRange.min?.currency || 'CNY'}\` : '未设置' }}</strong></div>
    <div class="detail-item"><span>审批人</span><strong>{{ approvalInfo.approver }}</strong></div>`)
detail = detail.replace(`      <div v-if="conversionMessage" class="detail-item hint" style="grid-column: 1 / -1"><span>转化提示</span><strong>{{ conversionMessage }}</strong></div>
    </div>

    <div v-if="approvalInfo.history.length" class="error-note" style="margin-top:14px">`, `      <div v-if="conversionMessage" class="detail-item hint" style="grid-column: 1 / -1"><span>转化提示</span><strong>{{ conversionMessage }}</strong></div>
      <div v-if="request.requesterId" class="detail-item"><span>当前操作账户</span><strong>{{ request.requesterId }}</strong></div>
    </div>

    <div v-if="approvalInfo.history.length" class="error-note" style="margin-top:14px">`)
write(detailFile, detail)

console.log('patched requisition pages')
