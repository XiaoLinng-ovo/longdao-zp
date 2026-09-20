<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import {
  createApplication,
  createCandidate,
  getAnalysisResult,
  loadApplications,
  loadCandidateTags,
  loadCandidates,
  loadJobs,
  processAnalysisTask,
  reviewAnalysisResult,
  uploadResume,
} from '../api'
import type { ApiAnalysisResult, ApiApplication } from '../api'
import type { Job } from '../../../shared/types/recruiting'
import { humanReviewStatusLabel, recommendationLabel } from '../labels'
import { isApiClientError } from '../../../shared/api'
import PageHeader from '../../../shared/components/PageHeader.vue'
import CandidateTable from '../components/CandidateTable.vue'

const router = useRouter()

function openDetail(row: Awaited<ReturnType<typeof loadCandidates>>[number]) {
  router.push({ name: 'candidate-detail', params: { id: row.entityId || row.id } })
}

const rows = ref<Awaited<ReturnType<typeof loadCandidates>>>([])
const jobs = ref<Job[]>([])
const applications = ref<ApiApplication[]>([])
const allTags = ref<string[]>([])
const tagFilter = ref('')

const filteredRows = computed(() => {
  if (!tagFilter.value) return rows.value
  return rows.value.filter((row) => (row.tags ?? []).includes(tagFilter.value))
})

const loading = ref(true)
const error = ref('')
const feedback = ref('')

const showCreateCandidate = ref(false)
const candidateForm = ref({ fullName: '', email: '', phone: '', source: '', tags: '' })
const creatingCandidate = ref(false)

const showCreateApplication = ref(false)
const applicationForm = ref({ candidateId: '', jobId: '', source: '' })
const creatingApplication = ref(false)

const resumeCandidateId = ref('')
const resumeApplicationId = ref('')
const resumeFile = ref<File | undefined>()
const uploading = ref(false)

const lastResult = ref<ApiAnalysisResult | undefined>()
const reviewing = ref(false)
const reviewComment = ref('')

async function refresh() {
  loading.value = true
  error.value = ''
  try {
    const [candidateRows, jobRows, tagRows] = await Promise.all([loadCandidates(), loadJobs(), loadCandidateTags()])
    rows.value = candidateRows
    jobs.value = jobRows
    allTags.value = tagRows
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '读取候选人失败'
  } finally {
    loading.value = false
  }
}

async function loadCandidateApplications(candidateId: string) {
  applications.value = []
  resumeApplicationId.value = ''
  if (!candidateId) return
  try {
    applications.value = await loadApplications(candidateId)
  } catch {
    applications.value = []
  }
}

async function submitCreateCandidate() {
  if (creatingCandidate.value) return
  if (!candidateForm.value.fullName.trim()) {
    error.value = '请填写候选人姓名'
    return
  }
  creatingCandidate.value = true
  error.value = ''
  try {
    await createCandidate({
      fullName: candidateForm.value.fullName.trim(),
      email: candidateForm.value.email.trim() || undefined,
      phone: candidateForm.value.phone.trim() || undefined,
      source: candidateForm.value.source.trim() || undefined,
      tags: candidateForm.value.tags.split(/[，,、\s]+/).map((tag) => tag.trim()).filter(Boolean),
    })
    showCreateCandidate.value = false
    candidateForm.value = { fullName: '', email: '', phone: '', source: '', tags: '' }
    await refresh()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '创建候选人失败'
  } finally {
    creatingCandidate.value = false
  }
}

async function submitCreateApplication() {
  if (creatingApplication.value) return
  if (!applicationForm.value.candidateId || !applicationForm.value.jobId) {
    error.value = '请选择候选人和岗位'
    return
  }
  creatingApplication.value = true
  error.value = ''
  try {
    await createApplication({
      candidateId: applicationForm.value.candidateId,
      jobId: applicationForm.value.jobId,
      source: applicationForm.value.source.trim() || undefined,
    })
    showCreateApplication.value = false
    applicationForm.value = { candidateId: '', jobId: '', source: '' }
    await refresh()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '创建申请失败'
  } finally {
    creatingApplication.value = false
  }
}

function selectResumeFile(event: Event) {
  resumeFile.value = (event.target as HTMLInputElement).files?.[0]
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result !== 'string') { reject(new Error('读取文件失败')); return }
      const dataUrl = reader.result
      const comma = dataUrl.indexOf(',')
      resolve(comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl)
    }
    reader.onerror = () => reject(reader.error ?? new Error('读取文件失败'))
    reader.readAsDataURL(file)
  })
}

function isNotFound(cause: unknown): boolean {
  return isApiClientError(cause) && (cause.status === 404 || cause.code === 'NOT_FOUND')
}

async function pollForResult(taskId: string): Promise<ApiAnalysisResult> {
  const deadline = Date.now() + 8000
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      return await getAnalysisResult(taskId)
    } catch (cause) {
      lastError = cause
      if (!isNotFound(cause)) throw cause
    }
    await new Promise((resolve) => setTimeout(resolve, 700))
  }
  throw lastError instanceof Error ? lastError : new Error('分析结果尚未就绪')
}

async function submitResume() {
  const file = resumeFile.value
  if (!resumeCandidateId.value || !file) {
    error.value = '请选择候选人和简历文件'
    return
  }
  uploading.value = true
  error.value = ''
  feedback.value = ''
  lastResult.value = undefined
  try {
    const created = await uploadResume({
      candidateId: resumeCandidateId.value,
      applicationId: resumeApplicationId.value || undefined,
      originalFilename: file.name,
      mimeType: file.type || 'application/octet-stream',
      content: await fileToBase64(file),
      encoding: 'base64',
    })
    await processAnalysisTask(created.task.id)
    let result: ApiAnalysisResult
    try {
      result = await getAnalysisResult(created.task.id)
    } catch (cause) {
      if (!isNotFound(cause)) throw cause
      result = await pollForResult(created.task.id)
    }
    lastResult.value = result
    feedback.value = '简历已上传并完成规则分析（AI 结果仅供人工复核参考，不会自动变更申请状态）。'
    resumeFile.value = undefined
    const input = document.querySelector<HTMLInputElement>('#resume-file')
    if (input) input.value = ''
    await refresh()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '上传简历失败'
  } finally {
    uploading.value = false
  }
}

async function submitReview(status: 'accepted' | 'needs_correction') {
  if (reviewing.value || !lastResult.value) return
  const comment = reviewComment.value.trim() || undefined
  if (status === 'needs_correction' && !comment) {
    error.value = '请填写退回修正说明'
    return
  }
  reviewing.value = true
  error.value = ''
  try {
    lastResult.value = await reviewAnalysisResult(lastResult.value.id, { status, comment })
    reviewComment.value = ''
    feedback.value = status === 'accepted' ? '已人工确认分析结果。' : '已退回修正，等待修正后重新复核。'
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '复核失败'
  } finally {
    reviewing.value = false
  }
}

const score = computed(() => lastResult.value?.result.assessment?.score)
const recommendation = computed(() => lastResult.value?.result.assessment?.recommendation)

onMounted(refresh)
</script>

<template>
  <PageHeader title="简历库 · AI 评分" description="跟踪候选人评估、面试和申请状态">
    <div class="inline-actions">
      <button class="btn btn-ghost" type="button" @click="refresh">刷新</button>
      <button class="btn btn-primary" type="button" @click="showCreateCandidate = !showCreateCandidate">新建候选人</button>
      <button class="btn btn-primary" type="button" @click="showCreateApplication = !showCreateApplication">新建申请</button>
    </div>
  </PageHeader>

  <section v-if="showCreateCandidate" class="form-panel">
    <div class="section-title">新建候选人</div>
    <div class="form-grid">
      <div class="form-field"><label>姓名</label><input v-model="candidateForm.fullName" placeholder="候选人姓名" /></div>
      <div class="form-field"><label>邮箱</label><input v-model="candidateForm.email" placeholder="name@example.com" /></div>
      <div class="form-field"><label>电话</label><input v-model="candidateForm.phone" placeholder="手机号" /></div>
      <div class="form-field"><label>来源</label><input v-model="candidateForm.source" placeholder="例如：内部推荐、猎头、招聘网站" /></div>
      <div class="form-field"><label>标签（逗号分隔）</label><input v-model="candidateForm.tags" placeholder="例如：后端、高潜、内推" /></div>
    </div>
    <div class="inline-actions" style="margin-top: 14px">
      <button class="btn btn-primary" type="button" :disabled="creatingCandidate" @click="submitCreateCandidate">{{ creatingCandidate ? '保存中...' : '保存候选人' }}</button>
      <button class="btn btn-ghost" type="button" :disabled="creatingCandidate" @click="showCreateCandidate = false">取消</button>
    </div>
  </section>

  <section v-if="showCreateApplication" class="form-panel">
    <div class="section-title">新建申请</div>
    <div class="form-grid">
      <div class="form-field">
        <label>候选人</label>
        <select v-model="applicationForm.candidateId">
          <option value="">请选择候选人</option>
          <option v-for="row in rows" :key="row.entityId || row.id" :value="row.entityId || row.id">{{ row.name }}（{{ row.id }}）</option>
        </select>
      </div>
      <div class="form-field">
        <label>岗位</label>
        <select v-model="applicationForm.jobId">
          <option value="">请选择岗位</option>
          <option v-for="job in jobs" :key="job.entityId || job.id" :value="job.entityId || job.id">{{ job.title }}</option>
        </select>
      </div>
      <div class="form-field"><label>来源</label><input v-model="applicationForm.source" placeholder="可选" /></div>
    </div>
    <div class="inline-actions" style="margin-top: 14px">
      <button class="btn btn-primary" type="button" :disabled="creatingApplication" @click="submitCreateApplication">{{ creatingApplication ? '保存中...' : '保存申请' }}</button>
      <button class="btn btn-ghost" type="button" :disabled="creatingApplication" @click="showCreateApplication = false">取消</button>
    </div>
  </section>

  <section class="form-panel">
    <div class="section-title">上传简历并分析</div>
    <div class="form-grid">
      <div class="form-field">
        <label for="resume-candidate">候选人</label>
        <select id="resume-candidate" v-model="resumeCandidateId" @change="loadCandidateApplications(resumeCandidateId)">
          <option value="">请选择候选人</option>
          <option v-for="row in rows" :key="row.entityId || row.id" :value="row.entityId || row.id">{{ row.name }}（{{ row.id }}）</option>
        </select>
      </div>
      <div class="form-field">
        <label for="resume-application">关联申请（可选）</label>
        <select id="resume-application" v-model="resumeApplicationId" :disabled="!applications.length">
          <option value="">不关联申请</option>
          <option v-for="app in applications" :key="app.id" :value="app.id">{{ app.id }}</option>
        </select>
      </div>
      <div class="form-field">
        <label for="resume-file">简历文件</label>
        <input id="resume-file" type="file" accept=".pdf,.doc,.docx,.txt,.md,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/markdown" @change="selectResumeFile">
        <small class="muted">文件将以二进制 base64 入库；AI 结构化解析当前对纯文本最稳定。</small>
      </div>
      <div class="form-field form-actions">
        <button class="btn btn-primary" type="button" :disabled="uploading" @click="submitResume">{{ uploading ? '处理中...' : '上传并分析' }}</button>
      </div>
    </div>
  </section>

  <section v-if="lastResult" class="review-panel">
    <div class="section-title">最近分析结果（人工复核）</div>
    <div class="review-metrics">
      <div class="review-metric"><span>综合评分</span><strong>{{ score != null ? score : '—' }}</strong></div>
      <div class="review-metric"><span>推荐结论</span><strong class="review-recommendation">{{ recommendationLabel(recommendation) }}</strong></div>
      <div class="review-metric"><span>复核状态</span><strong>{{ humanReviewStatusLabel(lastResult.humanReviewStatus) }}</strong></div>
    </div>
    <div class="form-field review-comment">
      <label for="review-comment">复核说明</label>
      <input id="review-comment" v-model="reviewComment" placeholder="确认通过或退回修正时填写说明" />
    </div>
    <div class="inline-actions">
      <button class="btn btn-primary" type="button" :disabled="reviewing" @click="submitReview('accepted')">确认通过</button>
      <button class="btn btn-danger" type="button" :disabled="reviewing" @click="submitReview('needs_correction')">退回修正</button>
    </div>
  </section>

  <div v-if="feedback" class="success-note">{{ feedback }}</div>
  <div v-if="error" class="error-note">{{ error }}</div>
  <div v-if="loading" class="loading-note">正在读取候选人...</div>
  <div v-else-if="allTags.length" class="filter-bar">
    <label for="candidate-tag-filter">标签筛选</label>
    <select id="candidate-tag-filter" v-model="tagFilter">
      <option value="">全部标签</option>
      <option v-for="tag in allTags" :key="tag" :value="tag">{{ tag }}</option>
    </select>
  </div>
  <CandidateTable v-if="!loading" :rows="filteredRows" @open="openDetail" />
</template>

<style scoped>
.filter-bar { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
.filter-bar select { min-width: 180px; }
.muted { display: block; margin-top: 5px; font-size: 11px; }
.form-actions { display: flex; align-items: flex-end; }
.form-actions button:disabled { opacity: 0.6; cursor: wait; }
.success-note { margin: 10px 0; padding: 10px 12px; background: #f0fdf4; color: #166534; border: 1px solid #bbf7d0; border-radius: 7px; font-size: 12px; }
.review-panel { background: #fff; border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow); padding: 18px; margin-bottom: 16px; }
.review-metrics { display: flex; gap: 16px; margin-bottom: 12px; }
.review-metric { flex: 1; padding: 12px 14px; background: #f8fafc; border: 1px solid #edf2f7; border-radius: 8px; }
.review-metric span { display: block; font-size: 11px; color: var(--muted); }
.review-metric strong { display: block; margin-top: 6px; font-size: 20px; color: #1e293b; }
.review-recommendation { font-size: 16px !important; }
.review-comment { margin-bottom: 12px; }
</style>
