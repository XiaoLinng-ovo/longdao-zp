<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { loadLiveInterviewSession, correctTranscriptRoles, type LiveInterviewView } from '../api'
const props = defineProps<{ sessionId: string }>()
const emit = defineEmits<{ changed: [] }>()
const view = ref<LiveInterviewView | null>(null)
const loading = ref(false), saving = ref(false), opened = ref(false)
const error = ref(''), message = ref('')
const selected = ref<string[]>([]), onlyUncertain = ref(false), speaker = ref('')
let revision = 0
const speakers = computed(() => [...new Set(view.value?.segments.map(row => row.speakerId) ?? [])])
const uncertain = computed(() => new Set(view.value?.completionReview?.unresolvedIds ?? []))
const rows = computed(() => (view.value?.segments ?? []).filter(row => (!speaker.value || row.speakerId === speaker.value) && (!onlyUncertain.value || uncertain.value.has(row.id) || row.role === 'unknown')))
async function load() {
  const current = ++revision
  loading.value = true; error.value = ''
  try { const next = await loadLiveInterviewSession(props.sessionId); if (current === revision) { view.value = next; selected.value = [] } }
  catch (cause) { if (current === revision) error.value = cause instanceof Error ? cause.message : '读取转写失败' }
  finally { if (current === revision) loading.value = false }
}
async function correct(role: 'candidate' | 'interviewer') {
  const versionId = view.value?.completionReview?.versionId
  if (saving.value || !versionId || !selected.value.length) return
  const current = revision
  saving.value = true; error.value = ''; message.value = ''
  try {
    const next = await correctTranscriptRoles(props.sessionId, versionId, selected.value, role)
    if (current !== revision) return
    view.value = next; selected.value = []; message.value = '说话人已校正，请点击重新评分。'; emit('changed')
  } catch (cause) { if (current === revision) error.value = cause instanceof Error ? cause.message : '校正失败' }
  finally { if (current === revision) saving.value = false }
}
function toggle() { opened.value = !opened.value; if (opened.value && !view.value) void load() }
watch(() => props.sessionId, () => { revision++; view.value = null; opened.value = false; selected.value = []; loading.value = false; saving.value = false; error.value = ''; message.value = '' })
</script>
<template>
  <section class="role-correction" aria-label="说话人校正">
    <button class="btn btn-ghost" type="button" :aria-expanded="opened" @click="toggle">说话人校正</button>
    <template v-if="opened">
      <p v-if="error" class="error-note" role="alert">{{ error }} <button class="btn btn-ghost" type="button" :disabled="loading || saving" @click="load">重试读取</button></p>
      <p v-if="message" role="status">{{ message }}</p>
      <p v-if="loading" role="status">正在读取转写...</p>
      <template v-else-if="view">
        <div class="role-toolbar">
          <label>说话人 <select v-model="speaker" :disabled="saving" @change="selected = []"><option value="">全部</option><option v-for="id in speakers" :key="id" :value="id">{{ id }}</option></select></label>
          <label><input v-model="onlyUncertain" type="checkbox" :disabled="saving" @change="selected = []" />仅看不确定片段</label>
          <button class="btn btn-ghost" type="button" :disabled="saving || rows.length > 1000" @click="selected = rows.map(row => row.id)">选择当前片段</button>
          <button class="btn btn-ghost" type="button" :disabled="saving" @click="selected = []">清空选择</button>
        </div>
        <div class="role-toolbar">
          <span>已选 {{ selected.length }} 段</span>
          <button class="btn btn-ghost" type="button" :disabled="saving || !selected.length || !view.completionReview?.versionId" @click="correct('interviewer')">设为面试官</button>
          <button class="btn btn-ghost" type="button" :disabled="saving || !selected.length || !view.completionReview?.versionId" @click="correct('candidate')">设为候选人</button>
        </div>
        <div class="role-turns">
          <label v-for="row in rows" :key="row.id" class="role-turn">
            <input v-model="selected" type="checkbox" :value="row.id" :disabled="saving" />
            <span><strong>{{ row.role === 'candidate' ? '候选人' : row.role === 'interviewer' ? '面试官' : '角色不确定' }}</strong> · {{ Math.floor(row.startMs / 60000) }}:{{ String(Math.floor(row.startMs / 1000) % 60).padStart(2, '0') }} · {{ row.speakerId }}<p>{{ row.text }}</p></span>
          </label>
          <p v-if="!rows.length">暂无匹配片段</p>
        </div>
        <a :href="'/interviews/' + view.session.interviewId + '/live'">打开完整录音与转写</a>
      </template>
    </template>
  </section>
</template>
<style scoped>
.role-correction { padding: 14px 0; border-bottom: 1px solid #dce4df; }
.role-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin: 12px 0; font-size: 13px; }
.role-toolbar label { display: flex; align-items: center; gap: 6px; min-width: 0; }
.role-toolbar select { max-width: 220px; min-width: 0; }
.role-turns { max-height: 360px; overflow: auto; }
.role-turn { display: flex; gap: 10px; padding: 12px 0; border-top: 1px solid #edf2f7; font-size: 12px; }
.role-turn > input { flex-shrink: 0; align-self: flex-start; }
.role-turn > span { min-width: 0; overflow-wrap: anywhere; }.role-turn p { margin: 5px 0; white-space: pre-wrap; line-height: 1.7; }
</style>
