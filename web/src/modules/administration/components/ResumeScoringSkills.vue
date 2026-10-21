<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { listAiPromptSkills, createAiPromptSkill, updateAiPromptSkill, deleteAiPromptSkill, type AdminAiPromptSkill } from '../api'
import { loadJobs, type JobView } from '../../jobs/api'

const props = withDefaults(defineProps<{ refreshKey?: boolean }>(), { refreshKey: false })
const skills = ref<AdminAiPromptSkill[]>([])
const jobs = ref<JobView[]>([])
const loading = ref(false)
const saving = ref(false)
const deletingId = ref<string | null>(null)
const confirmingId = ref<string | null>(null)
const editingId = ref<string | null>(null)
const error = ref('')
const message = ref('')
const search = ref('')
const draft = ref({ name: '', content: '', jobIds: [] as string[] })
const busy = computed(() => loading.value || saving.value || !!deletingId.value)
const visibleJobs = computed(() => jobs.value.filter((job) => `${job.title} ${job.department} ${job.id}`.toLowerCase().includes(search.value.trim().toLowerCase())))
const jobOwners = computed(() => new Map(skills.value.flatMap((skill) => (skill.jobIds ?? []).map((id) => [id, skill] as const))))
const rulesTemplate = `总分 100 分，必须依据简历事实评分，证据不足标记待核实，不得编造。
1. 核心岗位能力：40 分。结合岗位要求，评估相关技能的实际应用、深度及可验证成果。
2. 相关项目与工作经验：30 分。评估岗位相关性、个人职责、项目复杂度与量化结果。
3. 业务与行业匹配：20 分。评估与该岗位业务场景相关的经验，不以单个关键词判断。
4. 岗位相关教育与资格：10 分。仅评估与工作要求相关的专业知识与证书。
每个维度给出得分、扣分原因和简历证据，说明总分计算。缺失信息列为待核实事项。
不得以姓名、性别、年龄、婚育或其他与岗位能力无关的个人属性加减分。最终录用决定由人工作出。`

async function load() {
  loading.value = true
  error.value = ''
  try {
    const [allSkills, allJobs] = await Promise.all([listAiPromptSkills(), loadJobs()])
    skills.value = (allSkills ?? []).filter((skill) => skill.targetType === 'resume_score')
    jobs.value = allJobs ?? []
  } catch (cause) { error.value = cause instanceof Error ? cause.message : '读取评分 Skill 或岗位列表失败' }
  finally { loading.value = false }
}
function reset() {
  editingId.value = null
  confirmingId.value = null
  draft.value = { name: '', content: '', jobIds: [] }
  search.value = ''
}
function edit(skill: AdminAiPromptSkill) {
  editingId.value = skill.id
  draft.value = { name: skill.name, content: skill.content, jobIds: [...(skill.jobIds ?? [])] }
  error.value = ''
  message.value = ''
  confirmingId.value = null
}
function ownerLabel(jobId: string) {
  const owner = jobOwners.value.get(jobId)
  return owner && owner.id !== editingId.value ? owner.name : ''
}
function jobLabel(id: string) {
  const job = jobs.value.find((item) => item.entityId === id)
  return job ? `${job.title} · ${job.department}（${job.id}）` : id
}
function upsert(skill: AdminAiPromptSkill) {
  const exists = skills.value.some((item) => item.id === skill.id)
  skills.value = exists ? skills.value.map((item) => item.id === skill.id ? skill : item) : [skill, ...skills.value]
}
async function save() {
  if (busy.value) return
  const name = draft.value.name.trim()
  const content = draft.value.content.trim()
  if (!name || !content) { error.value = '请输入评分 Skill 名称和评分规则'; return }
  if (name.length > 80 || content.length > 8000) { error.value = '名称最多 80 字，评分规则最多 8000 字'; return }
  saving.value = true
  error.value = ''
  message.value = ''
  try {
    const input = { name, content, targetType: 'resume_score' as const, jobIds: [...draft.value.jobIds] }
    const saved = editingId.value ? await updateAiPromptSkill(editingId.value, input) : await createAiPromptSkill(input)
    upsert(saved)
    reset()
    message.value = `已保存评分 Skill「${saved.name}」。规则用于后续分析；已有简历需重新解析后生效。`
  } catch (cause) { error.value = cause instanceof Error ? cause.message : '保存评分 Skill 失败' }
  finally { saving.value = false }
}
async function toggle(skill: AdminAiPromptSkill) {
  if (busy.value) return
  saving.value = true
  error.value = ''
  message.value = ''
  try {
    const saved = await updateAiPromptSkill(skill.id, { isActive: !skill.isActive })
    upsert(saved)
    message.value = saved.isActive ? '已启用，关联岗位的后续分析将使用此规则。' : '已停用，关联岗位的后续分析将使用默认规则。'
  } catch (cause) { error.value = cause instanceof Error ? cause.message : '更新评分 Skill 状态失败' }
  finally { saving.value = false }
}
async function remove(skill: AdminAiPromptSkill) {
  if (busy.value) return
  deletingId.value = skill.id
  error.value = ''
  message.value = ''
  try {
    await deleteAiPromptSkill(skill.id)
    skills.value = skills.value.filter((item) => item.id !== skill.id)
    if (editingId.value === skill.id) reset()
    confirmingId.value = null
    message.value = '已删除评分 Skill 并解除岗位关联；历史评分及其规则快照保留。'
  } catch (cause) { error.value = cause instanceof Error ? cause.message : '删除评分 Skill 失败' }
  finally { deletingId.value = null }
}
onMounted(() => { if (!props.refreshKey) void load() })
watch(() => props.refreshKey, (value) => { if (!value) void load() })
</script>

<template>
  <section class="scoring-skills-panel" aria-labelledby="resume-scoring-skills-heading">
    <div class="section-heading">
      <div><h3 id="resume-scoring-skills-heading" class="section-title">简历 AI 评分 Skill</h3>
        <p class="muted">为不同岗位保存专属评分维度、权重与扣分规则，上传简历或重新解析时自动匹配。</p></div>
      <button class="btn btn-ghost" type="button" :disabled="busy" @click="load">刷新评分 Skill</button>
    </div>
    <p class="scoring-tip">一套规则可关联多个岗位，每个岗位只绑定一套规则。未关联或停用时使用默认规则；修改不影响历史评分。专属规则需要已配置 AI 模型的 Worker 执行，不会静默替换为默认评分。</p>
    <p v-if="error" class="error-note" role="alert">{{ error }}</p>
    <p v-if="message" class="success-note" role="status">{{ message }}</p>
    <div class="form-panel scoring-editor" :aria-busy="busy">
      <div class="form-field">
        <label for="resume-scoring-skill-name">评分 Skill 名称</label>
        <input id="resume-scoring-skill-name" v-model="draft.name" :disabled="busy" maxlength="80" placeholder="例如：后端工程师 · 项目与技术能力优先" />
      </div>
      <div class="form-field">
        <label for="resume-scoring-job-search">适用岗位（可多选，已选 {{ draft.jobIds.length }} 个）</label>
        <input id="resume-scoring-job-search" v-model="search" :disabled="busy" type="search" placeholder="按岗位名称、部门或编号搜索" />
        <div class="scoring-job-list">
          <label v-for="job in visibleJobs" :key="job.entityId" class="scoring-job-option" :class="{ unavailable: !!ownerLabel(job.entityId) }">
            <input v-model="draft.jobIds" type="checkbox" :value="job.entityId" :disabled="busy || !!ownerLabel(job.entityId)" />
            <span>{{ job.title }}<small>{{ job.department }} · {{ job.id }}</small></span>
            <small v-if="ownerLabel(job.entityId)">已绑定：{{ ownerLabel(job.entityId) }}</small>
          </label>
          <p v-if="loading" class="muted">正在读取岗位...</p>
          <p v-else-if="!visibleJobs.length" class="muted">{{ jobs.length ? '没有匹配的岗位' : '暂无岗位，请先创建岗位；也可先保存未关联的 Skill。' }}</p>
        </div>
        <small class="muted">不选岗位时仅保存为可复用规则，不会参与评分。更换规则前，请先在原 Skill 中解除岗位关联（停用不会解除关联）。</small>
      </div>
      <div class="form-field">
        <div class="rule-heading"><label for="resume-scoring-skill-content">评分规则</label>
          <button class="btn btn-ghost btn-sm" type="button" :disabled="busy || !!draft.content.trim()" @click="draft.content = rulesTemplate">填入评分模板</button></div>
        <textarea id="resume-scoring-skill-content" v-model="draft.content" :disabled="busy" rows="8" maxlength="8000" placeholder="写明评分维度、各维度权重、评分标准、扣分条件及证据要求；例如技术能力 40 分、项目经验 30 分、业务匹配 20 分、专业知识 10 分。"></textarea>
        <small class="muted">{{ draft.content.length }} / 8000 字 · 总分统一为 100 分；AI 会给出评分依据，最终得分仍按 AI 40% + 人工 60% 计算，招聘决定由人工确认。</small>
      </div>
      <div class="inline-actions">
        <button class="btn btn-primary" type="button" :disabled="busy" @click="save">{{ saving ? '保存中...' : editingId ? '保存评分 Skill' : '创建评分 Skill' }}</button>
        <button v-if="editingId" class="btn btn-ghost" type="button" :disabled="busy" @click="reset">取消编辑</button>
      </div>
    </div>
    <div class="table-wrap scoring-skills-table">
      <table><thead><tr><th>评分 Skill</th><th>适用岗位</th><th>状态</th><th>评分规则</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="skill in skills" :key="skill.id">
            <td><strong>{{ skill.name }}</strong></td>
            <td><ul v-if="skill.jobIds?.length" class="bound-jobs"><li v-for="id in skill.jobIds" :key="id">{{ jobLabel(id) }}</li></ul><span v-else class="muted">未关联岗位</span></td>
            <td><span class="skill-status" :class="{ active: skill.isActive }">{{ skill.isActive ? '启用' : '停用' }}</span></td>
            <td><details><summary>查看评分规则</summary><pre>{{ skill.content }}</pre></details></td>
            <td>
              <div v-if="confirmingId === skill.id" class="delete-confirm"><small>删除后关联岗位将恢复默认规则，确认删除？</small>
                <div class="inline-actions"><button class="btn btn-danger btn-sm" type="button" :disabled="busy" @click="remove(skill)">确认删除</button><button class="btn btn-ghost btn-sm" type="button" :disabled="busy" @click="confirmingId = null">取消</button></div></div>
              <div v-else class="inline-actions"><button class="btn btn-ghost btn-sm" type="button" :disabled="busy" @click="edit(skill)">编辑</button>
                <button class="btn btn-ghost btn-sm" type="button" :disabled="busy" @click="toggle(skill)">{{ skill.isActive ? '停用' : '启用' }}</button>
                <button class="btn btn-danger btn-sm" type="button" :disabled="busy" @click="confirmingId = skill.id">删除</button></div>
            </td>
          </tr>
          <tr v-if="!skills.length"><td colspan="5" class="table-empty">{{ loading ? '正在读取评分 Skill...' : '暂无评分 Skill，可先填入模板并为岗位创建专属规则。' }}</td></tr>
        </tbody>
      </table>
    </div>
  </section>
</template>

<style scoped>
.scoring-skills-panel { margin-top: 24px; padding-top: 22px; border-top: 1px solid #e5eef2; }
.scoring-tip { background: #eff6ff; border: 1px solid #dbeafe; border-radius: 10px; padding: 12px 16px; color: #475569; font-size: 12px; line-height: 1.8; }
.scoring-editor { display: grid; gap: 16px; margin-top: 14px; }
.scoring-editor textarea { width: 100%; resize: vertical; min-height: 168px; }
.scoring-job-list { max-height: 225px; overflow-y: auto; margin: 8px 0; border: 1px solid #e2e8f0; border-radius: 8px; padding: 6px 12px; }
.scoring-job-option { display: flex; align-items: center; gap: 10px; padding: 9px 0; cursor: pointer; }
.scoring-job-option input { width: 16px; height: 16px; flex-shrink: 0; }
.scoring-job-option span { flex: 1; color: #334155; }.scoring-job-option span small { display: block; margin-top: 3px; color: #64748b; }
.scoring-job-option.unavailable { opacity: .6; cursor: not-allowed; }
.rule-heading { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.scoring-skills-table { margin-top: 18px; }.scoring-skills-table table { min-width: 850px; }
.bound-jobs { padding-left: 16px; margin: 0; line-height: 1.8; }
.skill-status { border-radius: 20px; padding: 4px 10px; background: #f1f5f9; color: #64748b; font-size: 12px; }.skill-status.active { background: #ecfdf5; color: #047857; }
details summary { color: #2563eb; cursor: pointer; }pre { white-space: pre-wrap; overflow-wrap: anywhere; max-width: 380px; max-height: 300px; overflow-y: auto; font-family: inherit; line-height: 1.7; }
.success-note { color: #047857; background: #ecfdf5; padding: 10px 14px; border-radius: 8px; }
.delete-confirm { max-width: 220px; color: #b45309; }.delete-confirm .inline-actions { margin-top: 8px; }
@media (max-width: 760px) { .scoring-job-option { flex-wrap: wrap; }.rule-heading { flex-wrap: wrap; } }
</style>
