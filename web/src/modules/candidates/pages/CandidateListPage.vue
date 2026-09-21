<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import {
  createApplication,
  createCandidate,
  getAnalysisTask,
  loadCandidateTags,
  loadCandidates,
  loadJobs,
  uploadResume,
} from '../api'
import type { ApiApplication } from '../api'
import type { Job } from '../../../shared/types/recruiting'
import PageHeader from '../../../shared/components/PageHeader.vue'
import CandidateTable from '../components/CandidateTable.vue'

const router = useRouter()

function openDetail(row: Awaited<ReturnType<typeof loadCandidates>>[number]) {
  router.push({ name: 'candidate-detail', params: { id: row.entityId || row.id } })
}

const rows = ref<Awaited<ReturnType<typeof loadCandidates>>>([])
const jobs = ref<Job[]>([])
const allTags = ref<string[]>([])
const tagFilter = ref('')
const scoreSort = ref<'none' | 'desc' | 'asc'>('none')

const filteredRows = computed(() => {
  const filtered = tagFilter.value
    ? rows.value.filter((row) => (row.tags ?? []).includes(tagFilter.value))
    : [...rows.value]
  if (scoreSort.value === 'none') return filtered
  return filtered.sort((left, right) => {
    const leftScored = left.aiStatus === 'completed'
    const rightScored = right.aiStatus === 'completed'
    if (leftScored !== rightScored) return leftScored ? -1 : 1
    return scoreSort.value === 'desc' ? right.score - left.score : left.score - right.score
  })
})

const loading = ref(true)
const error = ref('')
const feedback = ref('')

const showCreateCandidate = ref(false)
const candidateResumeFile = ref<File | undefined>()
const candidateJobId = ref('')
const creatingCandidate = ref(false)

const showCreateApplication = ref(false)
const applicationForm = ref({ candidateId: '', jobId: '', source: '' })
const creatingApplication = ref(false)
let progressTimer: ReturnType<typeof setInterval> | undefined

async function refresh(silent = false) {
  if (!silent) loading.value = true
  error.value = ''
  try {
    const [candidateRows, jobRows, tagRows] = await Promise.all([loadCandidates(), loadJobs(), loadCandidateTags()])
    rows.value = candidateRows
    jobs.value = jobRows
    allTags.value = tagRows
    ensureProgressPolling()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '读取候选人失败'
  } finally {
    if (!silent) loading.value = false
  }
}

function ensureProgressPolling() {
  const active = rows.value.some((row) => row.analysisStatus === 'queued' || row.analysisStatus === 'processing')
  if (active && !progressTimer) {
    progressTimer = setInterval(() => void refresh(true), 5000)
  } else if (!active && progressTimer) {
    clearInterval(progressTimer)
    progressTimer = undefined
  }
}

async function submitCreateCandidate() {
  if (creatingCandidate.value) return
  const file = candidateResumeFile.value
  if (!file) {
    error.value = '请选择简历文件'
    return
  }
  if (!candidateJobId.value) {
    error.value = '请选择简历对应岗位'
    return
  }
  creatingCandidate.value = true
  error.value = ''
  feedback.value = ''
  let candidate: Awaited<ReturnType<typeof createCandidate>> | undefined
  try {
    candidate = await createCandidate({
      fullName: '待解析候选人',
      source: '简历导入',
    })
    const application = await createApplication({ candidateId: candidate.id, jobId: candidateJobId.value })
    const task = await queueResumeAnalysis(candidate.id, application.id, file)
    const jobTitle = jobs.value.find((job) => (job.entityId || job.id) === candidateJobId.value)?.title || '所选岗位'
    feedback.value = `简历“${file.name}”已上传并关联“${jobTitle}”，AI 正在后台根据简历和岗位进行评分。`
    showCreateCandidate.value = false
    candidateResumeFile.value = undefined
    candidateJobId.value = ''
    await refresh()
    void pollAnalysisInBackground(task.id)
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : '处理失败'
    if (candidate) {
      error.value = `候选人已创建，但简历上传或分析失败：${message}。请进入候选人详情重新上传简历。`
      showCreateCandidate.value = false
      candidateResumeFile.value = undefined
      candidateJobId.value = ''
      await refresh()
    } else {
      error.value = message || '创建候选人失败'
    }
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
  candidateResumeFile.value = (event.target as HTMLInputElement).files?.[0]
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

async function queueResumeAnalysis(candidateId: string, applicationId: string, file: File): Promise<{ id: string }> {
  const created = await uploadResume({
    candidateId,
    applicationId,
    originalFilename: file.name,
    mimeType: file.type || 'application/octet-stream',
    content: await fileToBase64(file),
    encoding: 'base64',
  })
  return created.task
}

async function pollAnalysisInBackground(taskId: string): Promise<void> {
  const deadline = Date.now() + 10 * 60 * 1000
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 3000))
    try {
      const task = await getAnalysisTask(taskId)
      if (task.status === 'completed') {
        feedback.value = 'AI 后台评分已完成，候选人列表已刷新。'
        await refresh()
        return
      }
      if (task.status === 'failed') {
        error.value = `AI 后台评分失败：${task.lastError || '请稍后重试'}`
        await refresh()
        return
      }
    } catch {
      return
    }
  }
}

onMounted(refresh)
onUnmounted(() => { if (progressTimer) clearInterval(progressTimer) })
</script>

<template>
  <PageHeader title="简历库 · AI 评分" description="跟踪候选人评估、面试和申请状态">
    <div class="inline-actions">
      <button class="btn btn-ghost" type="button" @click="refresh()">刷新</button>
      <button class="btn btn-primary" type="button" @click="showCreateCandidate = !showCreateCandidate">新建候选人</button>
      <button class="btn btn-primary" type="button" @click="showCreateApplication = !showCreateApplication">新建申请</button>
    </div>
  </PageHeader>

  <div v-if="showCreateCandidate" class="overlay" role="presentation" @click.self="showCreateCandidate = false">
    <div class="dialog candidate-dialog" role="dialog" aria-modal="true">
      <h3>上传简历自动建库</h3>
      <div class="form-grid">
        <div class="form-field" style="grid-column: 1 / -1">
          <label for="candidate-resume-file">简历文件</label>
          <input id="candidate-resume-file" type="file" accept=".pdf,.doc,.docx,.txt,.md,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/markdown" @change="selectResumeFile">
          <small class="muted">系统会从简历中解析姓名、邮箱和电话，并自动写入候选人档案。</small>
        </div>
        <div class="form-field" style="grid-column: 1 / -1">
          <label for="candidate-resume-job">对应岗位 <span class="required">*</span></label>
          <select id="candidate-resume-job" v-model="candidateJobId" aria-label="上传简历岗位">
            <option value="" disabled>请选择这份简历对应的岗位</option>
            <option v-for="job in jobs" :key="job.entityId || job.id" :value="job.entityId || job.id">{{ job.title }}</option>
          </select>
          <small class="muted">用于后续 AI 岗位匹配评分和面试安排。</small>
        </div>
      </div>
      <div class="dialog-buttons">
        <button class="btn btn-ghost" type="button" :disabled="creatingCandidate" @click="showCreateCandidate = false">取消</button>
        <button class="btn btn-primary" type="button" :disabled="creatingCandidate" @click="submitCreateCandidate">{{ creatingCandidate ? '解析中...' : '上传并解析' }}</button>
      </div>
    </div>
  </div>

  <div v-if="showCreateApplication" class="overlay" role="presentation" @click.self="showCreateApplication = false">
    <div class="dialog candidate-dialog" role="dialog" aria-modal="true">
      <h3>新建申请</h3>
      <div class="form-grid">
        <div class="form-field">
          <label>候选人</label>
          <select v-model="applicationForm.candidateId">
            <option value="">请选择候选人</option>
            <option v-for="row in rows" :key="row.entityId || row.id" :value="row.entityId || row.id">{{ row.name }}</option>
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
      <div class="dialog-buttons">
        <button class="btn btn-ghost" type="button" :disabled="creatingApplication" @click="showCreateApplication = false">取消</button>
        <button class="btn btn-primary" type="button" :disabled="creatingApplication" @click="submitCreateApplication">{{ creatingApplication ? '保存中...' : '保存申请' }}</button>
      </div>
    </div>
  </div>

  <div v-if="feedback" class="success-note">{{ feedback }}</div>
  <div v-if="error" class="error-note">{{ error }}</div>
  <div v-if="loading" class="loading-note">正在读取候选人...</div>
  <div v-else class="filter-bar">
    <template v-if="allTags.length">
      <label for="candidate-tag-filter">标签筛选</label>
      <select id="candidate-tag-filter" v-model="tagFilter">
        <option value="">全部标签</option>
        <option v-for="tag in allTags" :key="tag" :value="tag">{{ tag }}</option>
      </select>
    </template>
    <label for="candidate-score-sort">评分排序</label>
    <select id="candidate-score-sort" v-model="scoreSort" aria-label="评分排序">
      <option value="none">默认排序</option>
      <option value="desc">评分从高到低</option>
      <option value="asc">评分从低到高</option>
    </select>
  </div>
  <CandidateTable v-if="!loading" :rows="filteredRows" @open="openDetail" />
</template>

<style scoped>
.filter-bar { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
.filter-bar select { min-width: 180px; }
.muted { display: block; margin-top: 5px; font-size: 11px; }
.btn:disabled { opacity: 0.6; cursor: wait; }
.success-note { margin: 10px 0; padding: 10px 12px; background: #f0fdf4; color: #166534; border: 1px solid #bbf7d0; border-radius: 7px; font-size: 12px; }
.candidate-dialog { max-width: 720px; max-height: min(86vh, 720px); overflow-y: auto; }
</style>
