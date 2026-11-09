// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import RichTextEditor from './RichTextEditor.vue'

let app: App | undefined
let root: HTMLDivElement | undefined

async function flush() {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

afterEach(() => {
  app?.unmount()
  app = undefined
  root?.remove()
})

describe('RichTextEditor template variables', () => {
  it('underlines only template variables without changing their text', async () => {
    root = document.createElement('div')
    document.body.appendChild(root)
    app = createApp(RichTextEditor, {
      modelValue: '<p>{{候选人姓名}} 和 {{岗位名称}}</p><p>这是一段普通正文。</p>',
    })
    app.mount(root)
    await flush()

    const content = root.querySelector('.rich-text-content')
    const variables = content?.querySelectorAll('.template-variable')
    expect(variables).toHaveLength(2)
    expect(Array.from(variables ?? []).map((element) => element.textContent)).toEqual([
      '{{候选人姓名}}',
      '{{岗位名称}}',
    ])
    expect(content?.querySelector('p:last-child .template-variable')).toBeNull()
    expect(content?.textContent).toContain('这是一段普通正文。')
  })
})
