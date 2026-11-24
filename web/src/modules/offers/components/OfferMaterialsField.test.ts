// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, h, nextTick, ref, type App } from 'vue'
import OfferMaterialsField from './OfferMaterialsField.vue'

let app: App
let root: HTMLDivElement
afterEach(() => { app?.unmount(); root?.remove() })

describe('saved offer materials', () => {
  it('shows every saved custom entry and edits only the selected entry', async () => {
    const materials = ref(['id_card', 'bank_card:Bank A', 'bank_card:Bank B', 'other:Certificate', 'other:Transcript'])
    root = document.createElement('div'); document.body.appendChild(root)
    app = createApp({ render: () => h(OfferMaterialsField, { modelValue: materials.value, 'onUpdate:modelValue': value => { materials.value = value } }) })
    app.mount(root)
    const fields = [...root.querySelectorAll<HTMLInputElement>('input:not([type=checkbox])')]
    expect(fields.map(field => field.value)).toEqual(['Bank A', 'Bank B', 'Certificate', 'Transcript'])
    fields[3]!.value = 'Updated transcript'
    fields[3]!.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    expect(materials.value).toEqual(['id_card', 'bank_card:Bank A', 'bank_card:Bank B', 'other:Certificate', 'other:Updated transcript'])
    expect(root.querySelector<HTMLInputElement>('[aria-label="其他入职材料 1"]')?.value).toBe('Certificate')
  })
})
