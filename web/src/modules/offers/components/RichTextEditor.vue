<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { EditorContent, useEditor } from '@tiptap/vue-3'
import StarterKit from '@tiptap/starter-kit'
import Underline from '@tiptap/extension-underline'
import Placeholder from '@tiptap/extension-placeholder'
import { Bold, Heading1, Heading2, Italic, List, ListOrdered, Pilcrow, Redo2, Underline as UnderlineIcon, Undo2 } from '@lucide/vue'
import { Extension } from '@tiptap/core'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { normalizeRichHtml } from '../utils/richText'

function variableDecorations(doc: ProseMirrorNode): DecorationSet {
  const decorations: Decoration[] = []

  doc.descendants((node, position) => {
    if (!node.isText || !node.text) return

    for (const match of node.text.matchAll(/\{\{[^{}\n]+?\}\}/gu)) {
      decorations.push(Decoration.inline(
        position + match.index,
        position + match.index + match[0].length,
        { class: 'template-variable' },
      ))
    }
  })

  return DecorationSet.create(doc, decorations)
}

const TemplateVariableUnderline = Extension.create({
  name: 'templateVariableUnderline',
  addProseMirrorPlugins() {
    return [new Plugin({
      key: new PluginKey('templateVariableUnderline'),
      state: {
        init: (_config, state) => variableDecorations(state.doc),
        apply: (transaction, previous) => transaction.docChanged
          ? variableDecorations(transaction.doc)
          : previous,
      },
      props: {
        decorations(state) {
          return this.getState(state)
        },
      },
    })]
  },
})

const props = withDefaults(defineProps<{
  modelValue: string
  placeholder?: string
  editable?: boolean
  showToolbar?: boolean
  minHeight?: number
  variables?: Array<{ value: string; label: string }>
}>(), {
  placeholder: '开始编辑邮件正文...',
  editable: true,
  showToolbar: true,
  minHeight: 280,
  variables: () => [],
})

const emit = defineEmits<{ 'update:modelValue': [value: string] }>()
const revision = ref(0)

const editor = useEditor({
  content: normalizeRichHtml(props.modelValue),
  editable: props.editable,
  extensions: [
    StarterKit.configure({ heading: { levels: [1, 2, 3] }, underline: false }),
    Underline,
    Placeholder.configure({ placeholder: props.placeholder }),
    TemplateVariableUnderline,
  ],
  editorProps: {
    attributes: {
      class: 'rich-text-content',
      'aria-label': 'Offer 邮件正文',
    },
  },
  onUpdate: ({ editor: current }) => emit('update:modelValue', current.getHTML()),
  onTransaction: () => { revision.value += 1 },
})

const currentEditor = computed(() => {
  revision.value
  return editor.value
})

watch(() => props.modelValue, (value) => {
  if (!editor.value) return
  const next = normalizeRichHtml(value)
  if (next === editor.value.getHTML()) return
  editor.value.commands.setContent(next, { emitUpdate: false })
  revision.value += 1
})

watch(() => props.editable, (editable) => editor.value?.setEditable(editable))

function insertVariable(value: string) {
  if (!value || !editor.value) return
  editor.value.chain().focus().insertContent(value).run()
}
</script>

<template>
  <div class="rich-text-editor" :class="{ 'display-only': !editable }">
    <div v-if="showToolbar && editable" class="rich-text-toolbar" role="toolbar" aria-label="正文格式">
      <button type="button" title="正文" :class="{ active: currentEditor?.isActive('paragraph') }" @mousedown.prevent @click="currentEditor?.chain().focus().setParagraph().run()"><Pilcrow :size="16" /></button>
      <button type="button" title="一级标题" :class="{ active: currentEditor?.isActive('heading', { level: 1 }) }" @mousedown.prevent @click="currentEditor?.chain().focus().toggleHeading({ level: 1 }).run()"><Heading1 :size="16" /></button>
      <button type="button" title="二级标题" :class="{ active: currentEditor?.isActive('heading', { level: 2 }) }" @mousedown.prevent @click="currentEditor?.chain().focus().toggleHeading({ level: 2 }).run()"><Heading2 :size="16" /></button>
      <span class="toolbar-divider" />
      <button type="button" title="加粗" :class="{ active: currentEditor?.isActive('bold') }" @mousedown.prevent @click="currentEditor?.chain().focus().toggleBold().run()"><Bold :size="16" /></button>
      <button type="button" title="斜体" :class="{ active: currentEditor?.isActive('italic') }" @mousedown.prevent @click="currentEditor?.chain().focus().toggleItalic().run()"><Italic :size="16" /></button>
      <button type="button" title="下划线" :class="{ active: currentEditor?.isActive('underline') }" @mousedown.prevent @click="currentEditor?.chain().focus().toggleUnderline().run()"><UnderlineIcon :size="16" /></button>
      <span class="toolbar-divider" />
      <button type="button" title="无序列表" :class="{ active: currentEditor?.isActive('bulletList') }" @mousedown.prevent @click="currentEditor?.chain().focus().toggleBulletList().run()"><List :size="16" /></button>
      <button type="button" title="有序列表" :class="{ active: currentEditor?.isActive('orderedList') }" @mousedown.prevent @click="currentEditor?.chain().focus().toggleOrderedList().run()"><ListOrdered :size="16" /></button>
      <span class="toolbar-divider" />
      <button type="button" title="撤销" :disabled="!currentEditor?.can().chain().focus().undo().run()" @mousedown.prevent @click="currentEditor?.chain().focus().undo().run()"><Undo2 :size="16" /></button>
      <button type="button" title="重做" :disabled="!currentEditor?.can().chain().focus().redo().run()" @mousedown.prevent @click="currentEditor?.chain().focus().redo().run()"><Redo2 :size="16" /></button>
      <select v-if="variables.length" class="variable-picker" aria-label="插入模板变量" @change="insertVariable(($event.target as HTMLSelectElement).value); ($event.target as HTMLSelectElement).value = ''">
        <option value="">插入变量</option>
        <option v-for="variable in variables" :key="variable.value" :value="variable.value">{{ variable.label }}</option>
      </select>
    </div>
    <EditorContent :editor="editor" class="rich-text-surface" :style="{ minHeight: `${minHeight}px` }" />
  </div>
</template>

<style scoped>
.rich-text-editor { overflow: hidden; border: 1px solid var(--border, #dbe3ef); border-radius: 7px; background: #fff; }
.rich-text-toolbar { display: flex; align-items: center; flex-wrap: wrap; gap: 3px; padding: 7px; border-bottom: 1px solid #e5eaf0; background: #f8fafb; }
.rich-text-toolbar button { display: inline-flex; align-items: center; justify-content: center; width: 30px; height: 30px; padding: 0; border: 1px solid transparent; border-radius: 5px; background: transparent; color: #4c5b6d; cursor: pointer; }
.rich-text-toolbar button:hover:not(:disabled), .rich-text-toolbar button.active { border-color: #c8d6ce; background: #eaf3ed; color: #275b3d; }
.rich-text-toolbar button:disabled { color: #b5bdc7; cursor: default; }
.toolbar-divider { width: 1px; height: 20px; margin: 0 4px; background: #dce3e9; }
.variable-picker { min-width: 112px; height: 30px; margin-left: auto; padding: 3px 7px; border: 1px solid #d5dde5; border-radius: 5px; background: #fff; color: #405064; font-size: 12px; }
.rich-text-surface { min-width: 0; overflow: auto; }
.rich-text-editor.display-only { border: 0; border-radius: 0; background: transparent; }
.rich-text-editor.display-only .rich-text-surface { overflow: visible; }
:deep(.rich-text-content) { min-height: inherit; padding: 18px 20px; box-sizing: border-box; color: #263044; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", Arial, sans-serif; font-size: 16px; line-height: 1.85; outline: none; overflow-wrap: anywhere; }
:deep(.rich-text-content:focus) { box-shadow: inset 0 0 0 2px rgba(52, 118, 76, .18); }
:deep(.rich-text-content p) { margin: 0 0 12px; text-indent: 2em; }
:deep(.rich-text-content h1) { margin: 0 0 24px; color: #172033; font-size: 28px; line-height: 1.4; text-align: center; }
:deep(.rich-text-content h2) { margin: 24px 0 12px; padding-bottom: 6px; border-bottom: 1px solid #e1e6ec; color: #172033; font-size: 19px; line-height: 1.5; }
:deep(.rich-text-content h3) { margin: 20px 0 10px; color: #172033; font-size: 17px; line-height: 1.5; }
:deep(.rich-text-content ul), :deep(.rich-text-content ol) { margin: 0 0 14px; padding-left: 28px; }
:deep(.rich-text-content li) { margin: 0 0 7px; }
:deep(.rich-text-content p.is-editor-empty:first-child::before) { height: 0; float: left; color: #9aa5b1; content: attr(data-placeholder); pointer-events: none; }
:deep(.rich-text-content .template-variable) { text-decoration-line: underline; text-decoration-color: #4f9280; text-decoration-thickness: 1.5px; text-underline-offset: 3px; }
.rich-text-editor.display-only :deep(.rich-text-content) { padding: 0; font-size: 14px; line-height: 1.75; }
.rich-text-editor.display-only :deep(.rich-text-content h1) { margin-bottom: 18px; font-size: 22px; text-align: center; }
.rich-text-editor.display-only :deep(.rich-text-content h2) { font-size: 16px; }
</style>
