<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { listAiPromptSkills, createAiPromptSkill, updateAiPromptSkill, deleteAiPromptSkill, type AdminAiPromptSkill, type AiPromptSkillTarget } from '../api'
const props = withDefaults(defineProps<{ refreshKey?: boolean }>(), { refreshKey: false })
const loading = ref(false)
const aiSkills = ref<AdminAiPromptSkill[]>([])
const documentSkills = computed(() => aiSkills.value.filter((skill) => skill.targetType !== 'resume_score'))
const aiSkillDraft = ref({ name: '', targetType: 'both' as AiPromptSkillTarget, content: '' })
const editingAiSkillId = ref<string | null>(null)
const savingAiSkill = ref(false)
const deletingAiSkillId = ref<string | null>(null)
const aiSkillsError = ref('')

const busy = computed(() => loading.value || savingAiSkill.value || !!deletingAiSkillId.value)
async function load() {
  loading.value = true
  aiSkillsError.value = ''
  try { aiSkills.value = await listAiPromptSkills() }
  catch (cause) { aiSkillsError.value = cause instanceof Error ? cause.message : '读取 Skill 失败' }
  finally { loading.value = false }
}
onMounted(() => { if (!props.refreshKey) void load() })
watch(() => props.refreshKey, value => { if (!value) void load() })
function resetAiSkillDraft() {
  aiSkillDraft.value = { name: '', targetType: 'both', content: '' }
  editingAiSkillId.value = null
}

function editAiSkill(skill: AdminAiPromptSkill) {
  editingAiSkillId.value = skill.id
  aiSkillDraft.value = { name: skill.name, targetType: skill.targetType, content: skill.content }
  aiSkillsError.value = ''
}

async function saveAiSkill() {
  if (busy.value) return
  const name = aiSkillDraft.value.name.trim()
  const content = aiSkillDraft.value.content.trim()
  if (!name || !content) { aiSkillsError.value = '请输入 Skill 名称和内容'; return }
  if (name.length > 80 || content.length > 8000) { aiSkillsError.value = 'Skill 名称不能超过 80 个字符，内容不能超过 8000 个字符'; return }
  savingAiSkill.value = true
  aiSkillsError.value = ''
  try {
    const saved = editingAiSkillId.value
      ? await updateAiPromptSkill(editingAiSkillId.value, { name, targetType: aiSkillDraft.value.targetType, content })
      : await createAiPromptSkill({ name, targetType: aiSkillDraft.value.targetType, content })
    aiSkills.value = editingAiSkillId.value
      ? aiSkills.value.map((item) => item.id === saved.id ? saved : item)
      : [saved, ...aiSkills.value]
    resetAiSkillDraft()
  } catch (cause) { aiSkillsError.value = cause instanceof Error ? cause.message : '保存 Skill 失败' }
  finally { savingAiSkill.value = false }
}

async function toggleAiSkill(skill: AdminAiPromptSkill) {
  if (busy.value) return
  savingAiSkill.value = true
  aiSkillsError.value = ''
  try {
    const saved = await updateAiPromptSkill(skill.id, { isActive: !skill.isActive })
    aiSkills.value = aiSkills.value.map((item) => item.id === saved.id ? saved : item)
  } catch (cause) { aiSkillsError.value = cause instanceof Error ? cause.message : '更新 Skill 状态失败' }
  finally { savingAiSkill.value = false }
}

async function removeAiSkill(skill: AdminAiPromptSkill) {
  if (busy.value) return
  deletingAiSkillId.value = skill.id
  aiSkillsError.value = ''
  try {
    await deleteAiPromptSkill(skill.id)
    aiSkills.value = aiSkills.value.filter((item) => item.id !== skill.id)
    if (editingAiSkillId.value === skill.id) resetAiSkillDraft()
  } catch (cause) { aiSkillsError.value = cause instanceof Error ? cause.message : '删除 Skill 失败' }
  finally { deletingAiSkillId.value = null }
}
</script>
<template>
    <section class="ai-skills-panel" aria-labelledby="document-skills-heading">
      <div class="section-heading">
        <div>
          <h3 id="document-skills-heading" class="section-title">岗位文档生成 Skill</h3>
        </div>
        <button v-if="editingAiSkillId" class="btn btn-ghost" type="button" :disabled="busy" @click="resetAiSkillDraft">新建 Skill</button>
      </div>

      <button class="btn btn-ghost" type="button" :disabled="busy" @click="load">刷新文档 Skill</button>
      <div v-if="aiSkillsError" class="error-note" role="alert">{{ aiSkillsError }}</div>

      <div class="ai-skill-editor" :aria-busy="busy">
        <div class="form-grid ai-skill-editor-grid">
          <div class="form-field">
            <label for="ai-skill-name">Skill 名称</label>
            <input id="ai-skill-name" :disabled="busy" v-model="aiSkillDraft.name" maxlength="80" placeholder="例如：专业简洁型 JD" />
          </div>
          <div class="form-field">
            <label for="ai-skill-target">适用范围</label>
            <select id="ai-skill-target" :disabled="busy" v-model="aiSkillDraft.targetType">
              <option value="both">岗位说明书和 JD</option>
              <option value="job_spec">仅岗位说明书</option>
              <option value="jd">仅 JD</option>
            </select>
          </div>
        </div>
        <div class="form-field">
          <div class="content-heading"><label for="ai-skill-content">Skill 内容</label><span id="ai-skill-count" class="character-count">{{ aiSkillDraft.content.length }}/8000</span></div>
          <textarea id="ai-skill-content" aria-describedby="ai-skill-count" v-model="aiSkillDraft.content" rows="5" maxlength="8000" :disabled="busy" placeholder="例如：使用专业、清晰、可执行的语言；职责按重要性排序；避免空泛形容词；尽量补充可衡量的结果指标。"></textarea>
        </div>
        <div class="inline-actions">
          <button class="btn btn-primary" type="button" :disabled="busy" @click="saveAiSkill">{{ savingAiSkill ? '保存中...' : (editingAiSkillId ? '保存修改' : '创建 Skill') }}</button>
          <button v-if="editingAiSkillId" class="btn btn-ghost" type="button" :disabled="savingAiSkill" @click="resetAiSkillDraft">取消编辑</button>
        </div>
      </div>

      <div class="table-wrap ai-skills-table">
        <table>
          <thead><tr><th>名称</th><th>适用范围</th><th>状态</th><th>内容</th><th class="col-actions">操作</th></tr></thead>
          <tbody>
            <tr v-for="skill in documentSkills" :key="skill.id">
              <td><strong>{{ skill.name }}</strong></td>
              <td>{{ skill.targetType === 'both' ? '岗位说明书和 JD' : skill.targetType === 'job_spec' ? '仅岗位说明书' : '仅 JD' }}</td>
              <td><span :class="skill.isActive ? 'skill-status active' : 'skill-status'">{{ skill.isActive ? '启用' : '停用' }}</span></td>
              <td><span class="skill-content-preview">{{ skill.content }}</span></td>
              <td class="row-actions">
                <button class="btn btn-ghost btn-sm" type="button" :disabled="busy" @click="editAiSkill(skill)">编辑</button>
                <button class="btn btn-ghost btn-sm" type="button" :disabled="savingAiSkill" @click="toggleAiSkill(skill)">{{ skill.isActive ? '停用' : '启用' }}</button>
                <button class="btn btn-danger btn-sm" type="button" :disabled="busy" @click="removeAiSkill(skill)">{{ deletingAiSkillId === skill.id ? '删除中...' : '删除' }}</button>
              </td>
            </tr>
            <tr v-if="!documentSkills.length"><td colspan="5" class="table-empty">暂无 Skill，请先创建一个可复用的生成规则。</td></tr>
          </tbody>
        </table>
      </div>
    </section>

</template>
<style scoped>
.section-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.row-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.ai-skills-panel { margin-top: 18px; padding-top: 18px; border-top: 1px solid #e5eef2; }
.ai-skill-editor { margin-top: 12px; }
.ai-skill-editor-grid { grid-template-columns: minmax(0, 1.4fr) minmax(220px, .8fr); }
.ai-skill-editor textarea { width: 100%; min-height: 116px; resize: vertical; }
.ai-skills-table { margin-top: 14px; }
.skill-status { display: inline-flex; padding: 3px 8px; border-radius: 999px; background: #f1f5f9; color: #64748b; font-size: 12px; }
.skill-status.active { background: #dcfce7; color: #166534; }
.skill-content-preview { display: -webkit-box; overflow: hidden; max-width: 360px; color: #64748b; line-height: 1.5; -webkit-box-orient: vertical; -webkit-line-clamp: 3; }

.ai-skill-editor { display: grid; gap: 14px; }
.ai-skill-editor-grid { display: grid; gap: 16px; }
.ai-skill-editor .form-field { min-width: 0; }
.content-heading { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
.character-count { font-size: 12px; color: #64748b; font-variant-numeric: tabular-nums; flex-shrink: 0; }
.ai-skills-table { overflow-x: auto; }
.ai-skills-table table { min-width: 640px; }
@media (max-width: 760px) { .ai-skill-editor-grid { grid-template-columns: minmax(0, 1fr); } }
</style>
