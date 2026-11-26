<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Users } from '@lucide/vue'
import { apiClient } from '../../../shared/api'
import { authSession } from '../../auth/session'
import { describeApiFailure } from '../../../shared/utils/errorMessage'
import { type ApiInterviewDetail, type InterviewerOption, type InterviewSheetType } from '../api'
import { STAGE_SHEET_TYPES, SHEET_TYPE_LABEL } from '../api/question-sheets'
const props = defineProps<{ interview: ApiInterviewDetail }>()
const emit = defineEmits<{(event: 'saved'): void}>()
const admin = computed(() => ['owner','admin'].includes(authSession.workspaces.find(workspace => workspace.id === authSession.user?.workspaceId)?.role ?? ''))
const dialog = ref<HTMLDialogElement>(), members = ref<InterviewerOption[]>([]), ids = ref<string[]>([]), lead = ref('')
const owners = ref<Partial<Record<InterviewSheetType,string>>>({}), search = ref(''), error = ref(''), loading = ref(false), saving = ref(false)
const sheets = computed(() => STAGE_SHEET_TYPES[props.interview.stage ?? (props.interview.round >= 2 ? 'final' : 'initial')])
const selected = computed(() => members.value.filter(person => ids.value.includes(person.id)))
const filtered = computed(() => members.value.filter(person => (person.displayName + ' ' + (person.email ?? '')).toLocaleLowerCase().includes(search.value.trim().toLocaleLowerCase())))
watch(ids, values => {
  if (!values.includes(lead.value)) lead.value = values[0] ?? ''
  for (const type of sheets.value) if (!values.includes(owners.value[type] ?? '')) owners.value[type] = lead.value
})
async function open() {
  dialog.value?.showModal(); loading.value = true; error.value = ''; search.value = ''
  try {
    members.value = (await apiClient.getJson<InterviewerOption[]>('/interviewer-options')).data
    const participants = props.interview.participants.filter(person => person.role === 'interviewer')
    ids.value = participants.map(person => person.userId).filter(id => members.value.some(person => person.id === id))
    lead.value = participants.find(person => person.lead)?.userId ?? ids.value[0] ?? ''
    owners.value = Object.fromEntries(sheets.value.map(type => [type,participants.find(person => person.sheetTypes?.includes(type))?.userId ?? lead.value]))
  } catch (cause) { error.value = describeApiFailure(cause,'读取企业成员失败').message }
  finally { loading.value = false }
}
async function save() {
  if (saving.value || loading.value) return
  if (!ids.value.length || !ids.value.includes(lead.value) || sheets.value.some(type => !ids.value.includes(owners.value[type] ?? ''))) { error.value = '请至少选择一名面试官，并指定负责人和每张表的评分人'; return }
  saving.value = true; error.value = ''
  try {
    await apiClient.patchJson('/interviews/' + props.interview.id + '/responsibilities',{participants:[
      ...props.interview.participants.filter(person => person.role !== 'interviewer'),
      ...selected.value.map(person => ({userId:person.id,name:person.displayName,role:'interviewer',required:true,lead:person.id === lead.value,sheetTypes:sheets.value.filter(type => owners.value[type] === person.id)})),
    ]})
    dialog.value?.close(); emit('saved')
  } catch (cause) { error.value = describeApiFailure(cause,'保存面试分工失败').message }
  finally { saving.value = false }
}
</script>
<template>
  <button v-if="admin && interview.status !== 'cancelled'" class="btn btn-ghost" type="button" @click="open"><Users :size="16" />分配面试职责</button>
  <dialog ref="dialog" class="responsibility-dialog" aria-labelledby="responsibility-title" @cancel="saving && $event.preventDefault()">
    <h2 id="responsibility-title">面试职责</h2>
    <p v-if="error" class="error-note" role="alert">{{ error }}</p>
    <p v-if="loading">正在加载成员...</p>
    <template v-else>
      <label class="form-field">面试官（{{ ids.length }}）<input v-model="search" type="search" placeholder="搜索成员姓名或邮箱" /></label>
      <div class="responsibility-members"><label v-for="person in filtered" :key="person.id"><input v-model="ids" type="checkbox" :value="person.id" :disabled="saving" /><span>{{ person.displayName }}<small>{{ person.email }}</small></span></label></div>
      <label class="form-field">面试负责人<select v-model="lead" :disabled="saving"><option value="" disabled>请选择</option><option v-for="person in selected" :key="person.id" :value="person.id">{{ person.displayName }}</option></select></label>
      <label v-for="type in sheets" :key="type" class="form-field">{{ SHEET_TYPE_LABEL[type] }}评分人<select v-model="owners[type]" :disabled="saving"><option value="" disabled>请选择</option><option v-for="person in selected" :key="person.id" :value="person.id">{{ person.displayName }}</option></select></label>
    </template>
    <footer><button class="btn btn-ghost" type="button" :disabled="saving" @click="dialog?.close()">取消</button><button class="btn btn-primary" type="button" :disabled="loading || saving" @click="save">{{ saving ? '保存中...' : '保存分工' }}</button></footer>
  </dialog>
</template>
<style scoped>
.responsibility-dialog { box-sizing: border-box; width: min(480px,calc(100vw - 28px)); max-height: calc(100dvh - 40px); overflow: auto; border: 1px solid #d8e3e8; border-radius: 8px; padding: 20px; color: #294753; }
.responsibility-dialog::backdrop { background: #17252e60; } h2 { margin: 0 0 18px; font-size: 17px; }
.form-field { display: grid; gap: 7px; margin-top: 14px; font-size: 13px; } input[type="search"], select { width: 100%; box-sizing: border-box; padding: 9px; border: 1px solid #cddce3; border-radius: 4px; background: white; color: inherit; }
.responsibility-members { margin-top: 8px; max-height: 180px; overflow: auto; border-block: 1px solid #e3ebee; }
.responsibility-members label { display: flex; gap: 10px; align-items: center; min-height: 38px; padding: 6px; font-size: 13px; }
.responsibility-members span { display: grid; gap: 3px; min-width: 0; overflow-wrap: anywhere; } small { color: #728791; font-size: 11px; } footer { display: flex; justify-content: flex-end; gap: 8px; margin-top: 20px; }
</style>
