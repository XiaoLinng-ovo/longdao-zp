<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { analyzeResumeForApplication, createApplication, getCandidate, loadApplications, uploadResume, type ApiApplication, type ApiCandidateDetail } from '../api'
import type { Candidate, Job } from '../../../shared/types/recruiting'
import { describeApiFailure } from '../../../shared/utils/errorMessage'
import { normalizeSearchText } from '../../../shared/utils/search'
import StatusTag from '../../../shared/components/StatusTag.vue'

const props = defineProps<{ candidates: readonly Candidate[]; jobs: readonly Job[]; initialCandidateId?: string; initialApplicationId?: string; canArrange?: boolean }>()
const emit = defineEmits<{ close: []; changed: []; created: [payload: { application: ApiApplication; taskId?: string; resumeName?: string }]; view: [application: ApiApplication]; arrange: [applicationId: string] }>()
const candidateId = ref(props.initialCandidateId || '')
const jobId = ref('')
const source = ref('')
const query = ref('')
const detail = ref<ApiCandidateDetail>()
const loadingDetail = ref(false)
const saving = ref(false)
const error = ref('')
const resumeMode = ref<'existing' | 'upload'>('existing')
const resumeId = ref('')
const resumeFile = ref<File>()
const createdApplication = ref<ApiApplication>()
const duplicate = ref<ApiApplication>()
let detailVersion = 0

const candidateOptions = computed(() => props.candidates.filter((row) =>
  (row.entityId || row.id) === candidateId.value || !query.value.trim()
  || [row.name, row.email, row.phone, row.id].map(normalizeSearchText).join(' ').includes(normalizeSearchText(query.value.trim()))))
const availableResumes = computed(() => [...(detail.value?.resumes || [])]
  .filter((resume) => resume.scanStatus !== 'infected')
  .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)))
const existingApplication = computed(() => detail.value?.applications.find((application) => application.jobId === jobId.value))
const currentDuplicate = computed(() => {
  const existing = duplicate.value || existingApplication.value
  return existing?.id === createdApplication.value?.id ? undefined : existing
})
const canContinue = computed(() => {
  const application = currentDuplicate.value
  return application && ['pending_analysis', 'analysis_queued', 'human_review'].includes(application.status)
    && !application.resumeReview && !detail.value?.analysisResults.some((result) => result.applicationId === application.id)
    && !detail.value?.analysisTasks.some((task) => task.applicationId === application.id && ['queued', 'processing'].includes(task.status))
})
const readyForAnalysis = computed(() => !!candidateId.value && !!jobId.value && !!detail.value && !loadingDetail.value
  && (resumeMode.value === 'existing' ? !!resumeId.value : !!resumeFile.value))
function jobTitle(id: string) { return props.jobs.find((job) => (job.entityId || job.id) === id)?.title || id }
function close() { if (!saving.value) emit('close') }

watch(candidateId, async (id) => {
  const version = ++detailVersion
  detail.value = undefined
  resumeId.value = ''
  resumeFile.value = undefined
  createdApplication.value = undefined
  duplicate.value = undefined
  error.value = ''
  loadingDetail.value = !!id
  if (!id) return
  try {
    const loaded = await getCandidate(id)
    if (version !== detailVersion) return
    detail.value = loaded
    resumeId.value = availableResumes.value[0]?.id || ''
    resumeMode.value = resumeId.value ? 'existing' : 'upload'
    const target = loaded.applications.find((application) => application.id === props.initialApplicationId)
    if (target) {
      jobId.value = target.jobId
      // Let the job watcher clear old selection before attaching the existing application.
      await nextTick()
      if (version !== detailVersion) return
      if (['pending_analysis', 'analysis_queued', 'human_review'].includes(target.status)
        && !loaded.analysisTasks.some((task) => task.applicationId === target.id && ['queued', 'processing'].includes(task.status))) {
        createdApplication.value = target
      }
    }
  } catch (cause) {
    if (version === detailVersion) error.value = cause instanceof Error ? cause.message : '读取候选人档案失败，请重新选择后重试'
  } finally {
    if (version === detailVersion) loadingDetail.value = false
  }
}, { immediate: true })
watch(jobId, () => { duplicate.value = undefined; createdApplication.value = undefined; error.value = '' })

function selectFile(event: Event) { resumeFile.value = (event.target as HTMLInputElement).files?.[0] }
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result.slice(reader.result.indexOf(',') + 1)) : reject(new Error('读取文件失败'))
    reader.onerror = () => reject(reader.error || new Error('读取文件失败'))
    reader.readAsDataURL(file)
  })
}
async function submit(withAnalysis = true) {
  if (saving.value) return
  error.value = ''
  if (!candidateId.value || !jobId.value) { error.value = '请选择候选人和应聘岗位'; return }
  if (withAnalysis && !readyForAnalysis.value) { error.value = '请选择已有简历或上传新简历'; return }
  if (withAnalysis && resumeMode.value === 'upload' && (resumeFile.value?.size || 0) > 10 * 1024 * 1024) { error.value = '简历文件不能超过 10 MB'; return }
  if (withAnalysis && resumeMode.value === 'upload' && !/\.(pdf|doc|docx|txt|md)$/i.test(resumeFile.value?.name || '')) { error.value = '请选择 PDF、Word、TXT 或 Markdown 简历'; return }
  saving.value = true
  try {
    if (!createdApplication.value) {
      // Recheck against the server rather than relying on the displayed snapshot.
      const existing = (await loadApplications(candidateId.value)).find((application) => application.jobId === jobId.value)
      if (existing) { duplicate.value = existing; error.value = '此岗位已有应聘申请，请查看原申请或继续未完成的分析，无需重复创建。'; return }
      createdApplication.value = await createApplication({ candidateId: candidateId.value, jobId: jobId.value, source: source.value.trim() || undefined })
      emit('changed')
    }
    const application = createdApplication.value
    if (!withAnalysis) { emit('created', { application }); return }
    let taskId: string
    let resumeName: string | undefined
    if (resumeMode.value === 'existing') {
      const task = await analyzeResumeForApplication(candidateId.value, resumeId.value, application.id)
      taskId = task.id
      resumeName = availableResumes.value.find((resume) => resume.id === resumeId.value)?.originalFilename
    } else {
      const file = resumeFile.value!
      const result = await uploadResume({ candidateId: candidateId.value, applicationId: application.id, originalFilename: file.name, mimeType: file.type || 'application/octet-stream', content: await fileToBase64(file), encoding: 'base64' })
      taskId = result.task.id
      resumeName = file.name
    }
    emit('created', { application, taskId, resumeName })
  } catch (cause) {
    const failure = describeApiFailure(cause, '处理失败')
    const message = failure.message
    if (failure.code === 'APPLICATION_ALREADY_EXISTS') {
      try {
        duplicate.value = (await loadApplications(candidateId.value)).find((application) => application.jobId === jobId.value)
      } catch { /* Preserve the original conflict when the follow-up read fails. */ }
    }
    error.value = createdApplication.value ? `申请已创建，但分析未启动：${message}。可以直接点击“重试分析”，不会再次创建申请。` : message
  } finally {
    saving.value = false
  }
}
function continueApplication() {
  if (!canContinue.value) return
  createdApplication.value = currentDuplicate.value
  duplicate.value = undefined
  error.value = ''
}
</script>

<template>
  <div class="overlay application-overlay" role="presentation" @click.self="close">
    <section class="dialog application-dialog" role="dialog" aria-modal="true" aria-labelledby="application-dialog-title">
      <header class="application-head">
        <div><span class="eyebrow">EXISTING CANDIDATE · NEW APPLICATION</span><h3 id="application-dialog-title">{{ createdApplication ? '岗位申请 · 简历解析' : '新建应聘申请' }}</h3></div>
        <button class="btn btn-ghost close-button" type="button" :disabled="saving" @click="close">关闭</button>
      </header>
      <div class="application-body">
        <p class="intro">已有候选人应聘其他岗位，直接复用档案，无需重复建人。每个岗位单独分析、评分与筛选，原申请和面试记录保持不变。若原岗位已通过简历筛选，请直接“安排面试”，无需重新创建申请。</p>
        <div class="step-strip"><span>1 选择已有候选人</span><span>2 选择岗位与简历</span><span>{{ createdApplication ? '3 解析此岗位申请' : '3 创建申请并分析' }}</span></div>
        <div v-if="error" class="error-note" role="alert">{{ error }}</div>
        <fieldset :disabled="saving" class="application-fields">
          <div class="form-field"><label for="application-search">查找候选人</label><input id="application-search" v-model="query" type="search" placeholder="搜索姓名、手机号、邮箱或编号" /><small class="muted">使用全部可访问档案，不受列表岗位或人才库筛选影响。</small></div>
          <div class="form-grid">
            <div class="form-field"><label for="application-candidate">已有候选人</label><select id="application-candidate" v-model="candidateId"><option value="">请选择候选人</option><option v-for="row in candidateOptions" :key="row.entityId || row.id" :value="row.entityId || row.id">{{ row.name }} · {{ row.phone || row.email || row.id }}</option></select></div>
            <div class="form-field"><label for="application-job">应聘岗位</label><select id="application-job" v-model="jobId"><option value="">请选择岗位</option><option v-for="job in jobs" :key="job.entityId || job.id" :value="job.entityId || job.id">{{ job.title }}{{ detail?.applications.some((item) => item.jobId === (job.entityId || job.id)) ? '（已有申请）' : '' }}</option></select></div>
          </div>
          <p v-if="loadingDetail" role="status" class="muted">正在读取候选人简历及岗位记录...</p>
          <div v-if="detail" class="candidate-card">
            <strong>{{ detail.fullName }}</strong><span>{{ detail.phone || '无手机号' }} · {{ detail.email || '无邮箱' }}</span>
            <div class="existing-applications"><small>已有 {{ detail.applications.length }} 个岗位申请</small><button v-for="application in detail.applications" :key="application.id" class="application-chip" type="button" @click="emit('view', application)">{{ jobTitle(application.jobId) }} <StatusTag :status="application.status" /></button><small v-if="!detail.applications.length">暂无岗位记录</small></div>
          </div>
          <div v-if="currentDuplicate" class="duplicate-note">
            <strong>该候选人已申请此岗位，无需重复创建。</strong>
            <div class="inline-actions"><button v-if="canArrange && currentDuplicate.status === 'interviewing'" class="btn btn-primary" type="button" @click="emit('arrange', currentDuplicate.id)">使用已有申请安排面试</button><button class="btn btn-ghost" type="button" @click="emit('view', currentDuplicate)">查看原申请</button><button v-if="canContinue" class="btn btn-primary" type="button" @click="continueApplication">继续完成此申请</button></div>
          </div>
          <div v-if="createdApplication" class="saved-note">正在处理已有申请。后续操作只补充此申请的分析，不会重复创建。</div>
          <div class="resume-section">
            <div class="section-label">用于此岗位评分的简历</div>
            <div class="resume-modes"><label><input v-model="resumeMode" type="radio" value="existing" /> 复用已有简历</label><label><input v-model="resumeMode" type="radio" value="upload" /> 上传新版本</label></div>
            <div v-if="resumeMode === 'existing'" class="form-field"><label for="application-resume">简历版本（默认最新）</label><select id="application-resume" v-model="resumeId"><option value="">请选择简历</option><option v-for="resume in availableResumes" :key="resume.id" :value="resume.id">{{ resume.originalFilename }} · {{ new Date(resume.createdAt).toLocaleString('zh-CN') }}</option></select><small v-if="!availableResumes.length" class="muted">暂无可用简历，请上传新版本；也可以先仅创建申请。</small></div>
            <div v-else class="form-field"><label for="application-resume-file">上传简历</label><input id="application-resume-file" type="file" accept=".pdf,.doc,.docx,.txt,.md" @change="selectFile" /><small class="muted">支持 PDF、Word、TXT、Markdown，最多 10 MB。新文件只用于当前岗位分析。</small></div>
            <small class="muted">复用的是简历文件，不是原岗位分数。AI 将按所选岗位重新评分，低于 80 分建议淘汰，是否进入初试由人工确认。</small>
          </div>
          <div class="form-field"><label for="application-source">本次应聘来源</label><input id="application-source" v-model="source" placeholder="可选，如内推、人才库激活、转岗推荐" /></div>
        </fieldset>
      </div>
      <footer class="application-footer">
        <button class="btn btn-ghost" type="button" :disabled="saving" @click="close">取消</button>
        <div class="inline-actions"><button v-if="!createdApplication" class="btn btn-ghost" type="button" :disabled="saving || !candidateId || !jobId || !!currentDuplicate || loadingDetail" @click="submit(false)">仅创建申请</button><button class="btn btn-primary" type="button" :disabled="saving || !readyForAnalysis || !!currentDuplicate" @click="submit(true)">{{ saving ? '处理中...' : createdApplication ? (createdApplication.id === initialApplicationId ? '解析此申请' : '重试分析') : '创建申请并分析' }}</button></div>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.application-overlay { position: fixed; inset: 0; z-index: 110; display: grid; place-items: center; padding: 16px; background: rgba(15, 23, 42, .4); }
.application-dialog { display: flex; flex-direction: column; width: min(760px, 100%); max-width: 760px; max-height: calc(100dvh - 32px); overflow: hidden; padding: 0; box-sizing: border-box; background: white; border-radius: 18px; box-shadow: 0 24px 70px rgba(15, 23, 42, .22); }
.application-head { display: flex; justify-content: space-between; align-items: center; flex-shrink: 0; gap: 12px; padding: 20px 24px; background: #f0f9ff; border-bottom: 1px solid #dbeafe; }
.application-head h3 { margin: 5px 0 0; color: #18364d; font-size: 21px; }.eyebrow { color: #487c96; font-size: 10px; letter-spacing: .09em; }
.close-button { flex-shrink: 0; color: #dc2626; border-color: #dc2626; background: white; }.close-button:hover { background: #fef2f2; }
.application-body { min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 20px 24px; }.intro { margin: 0 0 14px; color: #64748b; font-size: 13px; line-height: 1.7; }
.step-strip { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 18px; }.step-strip span { border-radius: 8px; background: #eff6ff; color: #1d4ed8; padding: 7px 9px; font-size: 12px; }
.application-fields { border: 0; padding: 0; margin: 0; min-width: 0; }.form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }.form-field { margin-bottom: 14px; min-width: 0; }.form-field > label { display: block; margin-bottom: 7px; font-size: 13px; font-weight: 600; }
.form-field input:not([type=radio]), .form-field select { width: 100%; min-height: 40px; padding: 8px 10px; border: 1px solid #cbd5e1; border-radius: 8px; box-sizing: border-box; background: #fff; }
.muted { display: block; margin-top: 6px; color: #64748b; font-size: 12px; line-height: 1.6; }.candidate-card { padding: 14px; margin: 2px 0 16px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; }.candidate-card > span { display: block; margin-top: 5px; color: #64748b; font-size: 12px; }.existing-applications { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 12px; }
.application-chip { display: inline-flex; align-items: center; gap: 7px; padding: 6px 9px; background: white; border: 1px solid #cbd5e1; border-radius: 8px; color: #334155; cursor: pointer; }.duplicate-note, .saved-note { margin-bottom: 14px; padding: 12px; background: #fffbeb; color: #92400e; border: 1px solid #fde68a; border-radius: 9px; font-size: 13px; }.duplicate-note .inline-actions { margin-top: 9px; }.saved-note { background: #f0fdf4; color: #166534; border-color: #bbf7d0; }
.resume-section { margin: 16px 0; padding: 15px; border: 1px solid #dbeafe; border-radius: 12px; }.section-label { font-weight: 650; font-size: 13px; }.resume-modes { display: flex; flex-wrap: wrap; gap: 18px; margin: 12px 0; font-size: 13px; }.resume-section .form-field { margin-bottom: 0; }
.application-footer { display: flex; flex-shrink: 0; justify-content: space-between; gap: 12px; padding: 16px 24px; border-top: 1px solid #e2e8f0; background: #f8fafc; }.inline-actions { display: flex; gap: 8px; flex-wrap: wrap; }button:disabled { opacity: .55; cursor: not-allowed; }
@media (max-width: 560px) { .form-grid { grid-template-columns: 1fr; gap: 0; }.application-head, .application-body, .application-footer { padding: 16px; }.application-footer { flex-wrap: wrap; } }
</style>
