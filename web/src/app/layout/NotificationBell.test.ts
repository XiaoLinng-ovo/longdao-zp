// @vitest-environment jsdom
import { createApp, nextTick, reactive, type App } from 'vue'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import NotificationBell from './NotificationBell.vue'
import { authSession } from '../../modules/auth/session'
import { loadNotifications, readNotifications, type NotificationInbox } from '../../modules/dashboard/api/notifications'
vi.mock('../../modules/auth/session', async () => { const {reactive} = await import('vue'); return {authSession:reactive({user:{id:'a',workspaceId:'org'}})} })
vi.mock('../../modules/dashboard/api/notifications', () => ({loadNotifications:vi.fn(),readNotifications:vi.fn()}))
const {push} = vi.hoisted(() => ({push:vi.fn()}))
vi.mock('vue-router', () => ({useRouter:() => ({push}),useRoute:() => ({fullPath:'/'})}))
const inbox = (): NotificationInbox => ({items:[{id:'n',taskKey:'sheet',kind:'todo',title:'评分待处理',description:'测试岗位',path:'/interviews/test',state:'active',readAt:null,createdAt:'2026-11-26T00:00:00Z'}],unreadCount:1,nextBefore:null})
let app: App, root: HTMLDivElement
async function flush() { for(let i=0;i<12;i++){await Promise.resolve();await nextTick()} }
beforeEach(() => {
  vi.useFakeTimers(); vi.resetAllMocks(); authSession.user = {id:'a',workspaceId:'org'} as never
  vi.mocked(loadNotifications).mockResolvedValue(inbox()); vi.mocked(readNotifications).mockResolvedValue()
  HTMLDialogElement.prototype.showModal = function(){this.open=true}
  HTMLDialogElement.prototype.close = function(){this.open=false}
  root=document.createElement('div');document.body.appendChild(root);app=createApp(NotificationBell);app.mount(root)
})
afterEach(() => { app.unmount(); root.remove(); vi.useRealTimers() })
it('shows unread count, reads messages without completing their task, and follows the task link',async()=>{
  await flush(); expect(root.querySelector('.notification-badge')?.textContent).toBe('1')
  root.querySelector<HTMLButtonElement>('.notification-trigger')!.click();await flush()
  root.querySelector<HTMLButtonElement>('.notification-message')!.click();await flush()
  expect(readNotifications).toHaveBeenCalledWith(['n']);expect(push).toHaveBeenCalledWith('/interviews/test')
  expect(root.querySelector('dialog')?.open).toBe(false)
})
it('polls while visible and removes its timer when unmounted',async()=>{
  await flush();vi.mocked(loadNotifications).mockClear();await vi.advanceTimersByTimeAsync(30_000)
  expect(loadNotifications).toHaveBeenCalledTimes(1)
  app.unmount();vi.mocked(loadNotifications).mockClear();await vi.advanceTimersByTimeAsync(60_000)
  expect(loadNotifications).not.toHaveBeenCalled()
})
it('discards stale results when switching accounts or enterprises',async()=>{
  await flush();let finish!: (value:NotificationInbox)=>void
  vi.mocked(loadNotifications).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve}))
  root.querySelector<HTMLButtonElement>('.notification-trigger')!.click();await flush()
  vi.mocked(loadNotifications).mockResolvedValue({items:[],unreadCount:0,nextBefore:null})
  authSession.user={id:'b',workspaceId:'other'} as never;await flush();finish(inbox());await flush()
  expect(root.textContent).not.toContain('评分待处理');expect(root.querySelector('.notification-badge')).toBeNull()
})
it('does not follow a cancelled or ended notification',async()=>{
  vi.mocked(loadNotifications).mockResolvedValue({...inbox(),items:inbox().items.map(item=>({...item,state:'cancelled'}))})
  root.querySelector<HTMLButtonElement>('.notification-trigger')!.click();await flush()
  root.querySelector<HTMLButtonElement>('.notification-message')!.click();await flush()
  expect(push).not.toHaveBeenCalled();expect(readNotifications).toHaveBeenCalledWith(['n'])
})
