// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const layoutCss = readFileSync('src/shared/styles/layout.css', 'utf-8')

function navigationRules(): CSSStyleRule[] {
  const style = document.createElement('style')
  style.textContent = layoutCss
  document.head.appendChild(style)
  const rules = Array.from(style.sheet!.cssRules)
    .filter((rule): rule is CSSStyleRule => 'selectorText' in rule)
  style.remove()
  return rules
}

describe('sidebar navigation spacing and stable hit areas', () => {
  it('leaves more space between administration options and increases their height', () => {
    const rules = navigationRules()
    const submenu = rules.filter((rule) => rule.selectorText === '.nav-submenu').at(-1)!
    const item = rules.filter((rule) => rule.selectorText === '.nav-subitem').at(-1)!

    expect(submenu.style.getPropertyValue('gap')).toBe('10px')
    expect(item.style.getPropertyValue('min-height')).toBe('40px')
    expect(item.style.getPropertyValue('padding')).toBe('9px 10px')
  })

  it('keeps hover and press motion while keeping submenu hit areas fixed', () => {
    const rules = navigationRules()
    for (const [selector, transform] of [
      ['.nav-item:hover', 'translateY(-1px)'],
      ['.nav-item:active', 'translateY(1px) scale(.985)'],
      ['.nav-subitem:hover .nav-subitem-content', 'translateX(1px)'],
      ['.nav-subitem:active .nav-subitem-content', 'translateX(1px) scale(.985)'],
    ]) {
      const rule = rules.filter((item) => item.selectorText === selector).at(-1)
      expect(rule?.style.getPropertyValue('transform'), selector).toBe(transform)
    }

    const submenuHitArea = rules.find((item) => item.selectorText === '.nav-subitem::before')
    expect(submenuHitArea?.style.getPropertyValue('top')).toBe('-5px')
    expect(submenuHitArea?.style.getPropertyValue('bottom')).toBe('-5px')

    for (const selector of ['.nav-subitem:hover', '.nav-subitem:active']) {
      const rule = rules.filter((item) => item.selectorText === selector).at(-1)
      expect(rule, selector).toBeDefined()
      for (const property of ['transform', 'translate', 'scale', 'padding', 'margin', 'height', 'min-height', 'border-width']) {
        expect(rule!.style.getPropertyValue(property), `${selector}: ${property}`).toBe('')
      }
    }
  })
})
