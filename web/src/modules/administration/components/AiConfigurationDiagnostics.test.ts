// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import Panel from './AiConfigurationDiagnostics.vue'
import { diagnoseAi, importLegacyAi, previewLegacyAi, probeAiGeneration, type AiDiagnosis } from '../api/ai-maintenance'

vi.mock('../api/ai-maintenance',()=>({diagnoseAi:vi.fn(),importLegacyAi:vi.fn(),previewLegacyAi:vi.fn(),probeAiGeneration:vi.fn()}))
const candidate={sourceOrganizationId:'source',sourceName:'管理员企业',sourceDigest:'a'.repeat(64),targetDigest:'b'.repeat(64),model:'model-a',baseUrlHost:'https://provider.example',updatedAt:null,platformExists:false,affectedOrganizationCount:9,decryptable:true,errorCode:null,canMigrate:true}
const missing: AiDiagnosis={platform:{configured:false,model:'',updatedAt:null},source:'platform',effective:false,decryptable:false,errorCode:'PLATFORM_AI_NOT_CONFIGURED',candidates:[candidate]}
let app:App,root:HTMLDivElement
async function flush(){for(let i=0;i<12;i++){await Promise.resolve();await nextTick()}}
async function mount(){root=document.createElement('div');document.body.appendChild(root);app=createApp(Panel);app.mount(root);await flush()}
const button=(text:string)=>[...root.querySelectorAll('button')].find(item=>item.textContent?.includes(text))!
beforeEach(()=>{vi.resetAllMocks();vi.mocked(diagnoseAi).mockResolvedValue(structuredClone(missing))})
afterEach(()=>{app?.unmount();root?.remove()})
describe('AI configuration diagnostics',()=>{
  it('explains the difference between saved legacy records and effective platform configuration',async()=>{
    await mount();expect(root.textContent).toContain('平台统一配置缺失');expect(root.textContent).toContain('管理员企业')
    expect(root.textContent).toContain('真实生成');expect(root.textContent).toContain('未验证')
    expect(button('验证已保存').disabled).toBe(true)
    expect(probeAiGeneration).not.toHaveBeenCalled()
  })
  it('requires explicit scope confirmation before import and refreshes after success',async()=>{
    await mount();button('核对迁移').click();await flush()
    expect(root.textContent).toContain('9 个企业');expect(button('验证并迁移配置').disabled).toBe(true)
    expect(importLegacyAi).not.toHaveBeenCalled()
    const checkbox=root.querySelector<HTMLInputElement>('input[type=checkbox]')!;checkbox.checked=true;checkbox.dispatchEvent(new Event('change',{bubbles:true}));await flush()
    vi.mocked(importLegacyAi).mockResolvedValue({migrated:true})
    vi.mocked(diagnoseAi).mockResolvedValue({...missing,platform:{configured:true,model:'model-a',updatedAt:null},effective:true,errorCode:null})
    root.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));await flush()
    expect(importLegacyAi).toHaveBeenCalledWith(candidate);expect(root.textContent).toContain('原企业配置及授权范围保持不变')
    expect(root.querySelector('form')).toBeNull()
  })
  it('never treats configuration parsing as proof of generation',async()=>{
    vi.mocked(diagnoseAi).mockResolvedValue({...missing,platform:{configured:true,model:'model-a',updatedAt:null},effective:true,errorCode:null})
    await mount();expect(root.textContent).toContain('未验证')
    vi.mocked(probeAiGeneration).mockResolvedValue({ok:false,code:'AI_PROVIDER_HTTP_ERROR',model:'model-a',latencyMs:12})
    button('验证已保存').click();await flush();expect(root.textContent).toContain('模型服务返回错误')
    expect(root.textContent).not.toContain('通过 · model-a')
  })
  it('invalidates confirmation when the destination changes and requires an updated preview',async()=>{
    await mount();button('核对迁移').click();await flush()
    const input=root.querySelector<HTMLInputElement>('#migration-base-url')!
    input.value='https://provider.example/v1';input.dispatchEvent(new Event('input',{bubbles:true}));await flush()
    expect(button('验证并迁移配置').disabled).toBe(true)
    vi.mocked(previewLegacyAi).mockResolvedValue({...candidate,baseUrl:'https://provider.example/v1'})
    button('更新迁移预览').click();await flush()
    expect(previewLegacyAi).toHaveBeenCalledWith('source','https://provider.example/v1')
    expect(button('验证并迁移配置').disabled).toBe(true)
    expect(importLegacyAi).not.toHaveBeenCalled()
  })
  it('displays API errors without leaving an endless loading state',async()=>{
    vi.mocked(diagnoseAi).mockRejectedValue(new Error('系统管理员权限不足'))
    await mount();expect(root.querySelector('[role=alert]')?.textContent).toContain('权限不足')
    expect(root.textContent).not.toContain('正在核对')
  })
})
