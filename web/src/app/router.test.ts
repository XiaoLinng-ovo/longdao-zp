// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest'
import { createAppRouter, installAuthGuard, navigationItems, getNavigationItemsForRole } from './router'
import { authSession, logoutCurrentUser } from '../modules/auth/session'
import { runtimeFeatures } from '../shared/config/runtime-features'

const expectedRoutes = [
  {
    path: '/',
    title: '招聘工作台',
    navLabel: '招聘工作台',
    icon: '◈',
  },
  {
    path: '/jobs',
    title: '岗位管理',
    navLabel: '岗位管理',
    icon: '②',
  },
  {
    path: '/candidates',
    title: '简历库 · AI 评分',
    navLabel: '简历库 · AI 评分',
    icon: '③',
  },
  {
    path: '/interviews',
    title: '面试中心',
    navLabel: '面试中心',
    icon: '④',
  },
  {
    path: '/offers',
    title: 'Offer 管理',
    navLabel: 'Offer 管理',
    icon: '⑥',
  },
  {
    path: '/onboarding',
    title: '入职归档',
    navLabel: '入职归档',
    icon: '⑦',
  },
  {path: '/enterprise/members',title:'企业成员',navLabel:'企业成员',icon:'♙'},
  {path: '/enterprise/ai',title:'AI 模型配置',navLabel:'AI 模型配置',icon:'✦'},
  {path:'/enterprise/billing-sandbox',title:'支付流程测试',navLabel:'支付流程测试',icon:'◇'},
  {path:'/enterprise/payments',title:'套餐订购与续费',navLabel:'套餐订购与续费',icon:'◇'},
  {path:'/platform/payments',title:'支付与商品管理',navLabel:'支付与商品管理',icon:'¥'},
  {
    path: '/administration',
    title: '系统配置',
    navLabel: '系统配置',
    icon: '⚙',
  },
  { path: '/platform/customers', title: '企业客户管理', navLabel: '企业客户管理', icon: '▧' },
  { path: '/platform/users', title: '用户管理', navLabel: '用户管理', icon: '◎' },
  { path: '/administration/platform-operators', title: '历史平台授权', navLabel: '历史平台授权', icon: '◎' },
  {
    path: '/workspaces',
    title: '企业工作空间',
    navLabel: '企业工作空间',
    icon: '⌂',
  },
  {
    path: '/enterprise/departments',
    title: '部门管理',
    navLabel: '部门管理',
    icon: '⌘',
  },
] as const

describe('application router', () => {
  beforeEach(() => {
    authSession.ready = true
    authSession.user = null
    authSession.loading = false
    authSession.workspaces = []
    authSession.error = ''
  })
  it('exposes every recruiting route with navigation metadata', () => {
    const router = createAppRouter()
    const routeByPath = new Map(router.getRoutes().map((route) => [route.path, route]))

    expect(navigationItems).toHaveLength(expectedRoutes.length)
    expect(navigationItems.some((item) => item.path === '/requisitions')).toBe(false)
    expect(routeByPath.has('/enterprise/approval-settings')).toBe(false)

    for (const expected of expectedRoutes) {
      const route = routeByPath.get(expected.path)

      expect(route).toBeDefined()
      expect(route?.meta).toMatchObject({
        title: expected.title,
        navLabel: expected.navLabel,
        icon: expected.icon,
      })
      expect(route?.components?.default).toBeTypeOf('function')
    }
  })

  it('hides demand management for all roles while retaining its routes for restoration', () => {
    for (const role of ['admin', 'hr_admin', 'recruiter', 'hiring_manager', 'interviewer'] as const) {
      expect(getNavigationItemsForRole(role).some((item) => item.path === '/requisitions')).toBe(false)
    }
    expect(createAppRouter().getRoutes().some((route) => route.path === '/requisitions/:id')).toBe(true)
  })

  it('redirects unknown paths to the dashboard', async () => {
    const router = createAppRouter()

    await router.push('/this-route-does-not-exist')

    expect(router.currentRoute.value.path).toBe('/')
  })

  it('marks administration as admin-only and hides it for non-admin navigation', () => {
    const router = createAppRouter()
    const adminRoute = router.getRoutes().find((route) => route.name === 'administration')
    expect(adminRoute?.meta.systemAdminOnly).toBe(true)
    expect(getNavigationItemsForRole('recruiter').some((item) => item.name === 'administration')).toBe(false)
    expect(getNavigationItemsForRole('admin').some((item) => item.name === 'administration')).toBe(false)
    expect(getNavigationItemsForRole('recruiter', undefined, 'admin').some((item) => item.name === 'administration')).toBe(false)
    expect(getNavigationItemsForRole('recruiter', undefined, undefined, true).some((item) => item.name === 'administration')).toBe(true)
    expect(getNavigationItemsForRole('recruiter', 'owner').some((item) => item.name === 'enterprise-approval-settings')).toBe(false)
    expect(getNavigationItemsForRole('recruiter', 'member').some((item) => item.name === 'enterprise-approval-settings')).toBe(false)
  })

  it('rejects ordinary members managing departments even with a legacy admin business role', async () => {
    Object.assign(authSession, {
      ready: true,
      loading: false,
      user: { id: 'u2', name: '企业成员', email: 'member@example.com', role: 'recruiter', departmentId: 'd1', workspaceId: 'w1' },
      workspaces: [{ id: 'w1', name: '测试企业', kind: 'test', status: 'active', role: 'member', createdAt: '2026-09-30T00:00:00Z' }],
    })
    const router = createAppRouter()
    installAuthGuard(router)

    expect(getNavigationItemsForRole('recruiter', 'member').some((item) => item.name === 'enterprise-departments')).toBe(false)
    await router.push('/enterprise/departments')

    expect(router.currentRoute.value.name).toBe('forbidden')
    authSession.user = { id: 'admin', name: '系统管理员', email: 'admin@example.com', role: 'admin', departmentId: '', workspaceId: 'w1' }
    await router.push('/enterprise/departments')
    expect(router.currentRoute.value.name).toBe('forbidden')
  })

  it('allows a logged-out user to reach login through the auth guard', async () => {
    authSession.user = { id: 'u1', name: '招聘专员', email: 'recruiter@example.com', role: 'recruiter', departmentId: 'd1' }
    authSession.method = 'development-bootstrap'
    authSession.sessionId = 'development-bootstrap'
    authSession.workspaces = []
    await logoutCurrentUser()

    const router = createAppRouter()
    installAuthGuard(router)
    await router.push('/login')

    expect(authSession.user).toBeNull()
    expect(router.currentRoute.value.name).toBe('login')
  })

  it('exposes the forgot-password page as a hidden authentication route', () => {
    const route = createAppRouter().getRoutes().find((item) => item.name === 'forgot-password')

    expect(route?.path).toBe('/forgot-password')
    expect(route?.components?.default).toBeTypeOf('function')
    expect(route?.meta).toMatchObject({
      title: '找回密码',
      hideInNav: true,
      hideShell: true,
    })
  })

  it('allows a logged-out user to reach forgot password', async () => {
    const router = createAppRouter()
    installAuthGuard(router)

    await router.push('/forgot-password')

    expect(router.currentRoute.value.name).toBe('forgot-password')
  })

  it('redirects an authenticated user away from forgot password', async () => {
    authSession.user = { id: 'u1', name: '招聘专员', email: 'recruiter@example.com', role: 'recruiter', departmentId: 'd1', workspaceId: 'w1' }
    const router = createAppRouter()
    installAuthGuard(router)

    await router.push('/forgot-password')

    expect(router.currentRoute.value.name).toBe('dashboard')
  })

  it('redirects unauthenticated users to login and preserves the destination', async () => {
    const router = createAppRouter()
    installAuthGuard(router)

    await router.push('/jobs')

    expect(router.currentRoute.value.name).toBe('login')
    expect(router.currentRoute.value.query.redirect).toBe('/jobs')
  })

  it('preserves the business destination while an authenticated user selects an enterprise', async () => {
    authSession.user = { id: 'u1', name: '企业用户', email: 'member@example.test', role: 'recruiter', departmentId: '' }
    const router = createAppRouter()
    installAuthGuard(router)
    await router.push('/jobs?status=active')
    expect(router.currentRoute.value.name).toBe('workspaces')
    expect(router.currentRoute.value.query.redirect).toBe('/jobs?status=active')
    authSession.user.workspaceId = 'w1'
    await router.push('/jobs?status=active')
    expect(router.currentRoute.value.fullPath).toBe('/jobs?status=active')
    await router.push('/interviews')
    expect(router.currentRoute.value.name).toBe('interviews')
  })

  it('does not misroute an unknown session to login or enterprise creation during a network failure', async () => {
    authSession.error = '暂时无法确认登录状态，请检查网络后重试。'
    const router = createAppRouter()
    installAuthGuard(router)
    await router.push('/jobs')
    expect(router.currentRoute.value.name).toBeUndefined()
    expect(router.currentRoute.value.path).toBe('/')
  })

  it('shows a dedicated forbidden page when an authenticated user lacks access', async () => {
    authSession.user = { id: 'u1', name: '招聘专员', email: 'recruiter@example.com', role: 'recruiter', departmentId: 'd1', workspaceId: 'w1' }
    const router = createAppRouter()
    installAuthGuard(router)

    await router.push('/administration')

    expect(router.currentRoute.value.name).toBe('forbidden')
    expect(router.currentRoute.value.query.from).toBe('/administration')
  })
})


describe('enterprise approval settings access', () => {
  beforeEach(() => {
    authSession.ready = true
    authSession.loading = false
  })

  it('redirects an enterprise owner away from disabled recruitment approval settings', async () => {
    authSession.user = { id: 'u1', name: '企业所有者', email: 'owner@example.com', role: 'recruiter', departmentId: 'd1', workspaceId: 'w1' }
    authSession.workspaces = [{ id: 'w1', name: '测试企业', kind: 'test', status: 'active', role: 'owner', createdAt: '2026-09-30T00:00:00Z' }]
    const router = createAppRouter()
    installAuthGuard(router)

    await router.push('/enterprise/approval-settings')

    expect(router.currentRoute.value.name).toBe('dashboard')
  })

  it('redirects members without opening disabled recruitment approval settings', async () => {
    authSession.user = { id: 'u2', name: '企业成员', email: 'member@example.com', role: 'recruiter', departmentId: 'd1', workspaceId: 'w1' }
    authSession.workspaces = [{ id: 'w1', name: '测试企业', kind: 'test', status: 'active', role: 'member', createdAt: '2026-09-30T00:00:00Z' }]
    const router = createAppRouter()
    installAuthGuard(router)

    await router.push('/enterprise/approval-settings')

    expect(router.currentRoute.value.name).toBe('dashboard')
  })
})

describe('removed enterprise approval settings compatibility', () => {
  it('redirects the removed approval settings bookmark to the dashboard', async () => {
    Object.assign(authSession, {
      ready: true,
      loading: false,
      user: { id: 'u1', name: '企业用户', email: 'member@example.com', role: 'recruiter', departmentId: '', workspaceId: 'w1' },
      workspaces: [{ id: 'w1', name: '测试企业', kind: 'test', status: 'active', role: 'member', createdAt: '2026-09-30T00:00:00Z' }],
    })
    const router = createAppRouter()
    installAuthGuard(router)

    await router.push('/enterprise/approval-settings')

    expect(router.currentRoute.value.name).toBe('dashboard')
    expect(router.currentRoute.value.query).toEqual({})
  })
})


describe('adding saved accounts', () => {
  it('allows an authenticated user to open the add-account login page without logging out', async () => {
    Object.assign(authSession, { ready: true, loading: false, user: { id: 'admin', name: '管理员', email: 'admin@example.com', role: 'admin', departmentId: 'hr', workspaceId: 'w1' }, workspaces: [] })
    const router = createAppRouter()
    installAuthGuard(router)
    await router.push('/login?addAccount=1')
    expect(router.currentRoute.value.name).toBe('login')
    expect(authSession.user?.id).toBe('admin')
    await router.push('/login')
    expect(router.currentRoute.value.name).toBe('dashboard')
  })
})


describe('invitation redirects', () => {
  beforeEach(() => { authSession.ready=true;authSession.loading=false;authSession.user=null;authSession.workspaces=[] })
  it('preserves the entire invitation URL while requesting login', async () => {
    const router=createAppRouter();installAuthGuard(router)
    await router.push('/workspaces?invite=ABCDEF123456ABCDEF123456')
    expect(router.currentRoute.value.name).toBe('invitation-join')
    expect(router.currentRoute.value.query.invite).toBe('ABCDEF123456ABCDEF123456')
  })
  it('returns signed-in users to their invitation instead of dropping it', async () => {
    authSession.user={id:'u1',name:'测试',email:'test@example.invalid',role:'recruiter',departmentId:'',workspaceId:'w1'}
    const router=createAppRouter();installAuthGuard(router)
    await router.push({name:'login',query:{redirect:'/workspaces?invite=ABCDEF123456ABCDEF123456'}})
    expect(router.currentRoute.value.name).toBe('invitation-join')
    expect(router.currentRoute.value.query.invite).toBe('ABCDEF123456ABCDEF123456')
  })
  it('rejects external redirects and lookalike workspace routes', async () => {
    authSession.user={id:'u1',name:'测试',email:'test@example.invalid',role:'recruiter',departmentId:'',workspaceId:'w1'}
    for(const redirect of ['https://example.invalid/workspaces','/workspaces-untrusted']) {
      const router=createAppRouter();installAuthGuard(router)
      await router.push({name:'register',query:{redirect}})
      expect(router.currentRoute.value.name).toBe('dashboard')
    }
  })
})


describe('recruitment requests disabled: UI route boundary', () => {
  beforeEach(() => {
    Object.assign(authSession, { ready: true, loading: false, user: null, workspaces: [] })
  })

  it.each(['admin', 'hr_admin', 'recruiter', 'hiring_manager', 'approver', 'interviewer'] as const)(
    'keeps Offer management accessible and request pages closed for %s', async (role) => {
      authSession.user = { id: 'u1', name: '测试', email: 'test@example.invalid', role, departmentId: '', workspaceId: 'w1' }
      authSession.workspaces = [{ id: 'w1', name: '企业', kind: 'production', status: 'active', role: 'owner', createdAt: '2026-10-12' }]
      const router = createAppRouter()
      installAuthGuard(router)
      for (const path of ['/requisitions', '/requisitions/legacy-id?edit=1']) {
        await router.push(path)
        expect(router.currentRoute.value.name).toBe('jobs')
        expect(router.currentRoute.value.query).toEqual({ notice: 'recruitment-requests-disabled' })
      }
      await router.push('/enterprise/approval-settings')
      expect(router.currentRoute.value.name).toBe('dashboard')
      for (const path of ['/offers', '/offers/offer-id']) {
        await router.push(path)
        expect(router.currentRoute.value.path).toBe(path)
      }
      expect(getNavigationItemsForRole(role, 'owner').some((item) => item.path === '/offers')).toBe(true)
      expect(getNavigationItemsForRole(role, 'owner').some((item) => item.requiresRecruitmentRequests)).toBe(false)
    },
  )

  it('requires login and workspace selection before applying the feature redirect', async () => {
    const router = createAppRouter()
    installAuthGuard(router)
    await router.push('/requisitions/legacy-id')
    expect(router.currentRoute.value.name).toBe('login')
    expect(router.currentRoute.value.query.redirect).toBe('/requisitions/legacy-id')
    authSession.user = { id: 'u1', name: '测试', email: 'test@example.invalid', role: 'recruiter', departmentId: '' }
    await router.push('/requisitions/legacy-id')
    expect(router.currentRoute.value.name).toBe('workspaces')
  })
})

describe('已隐藏功能的入口边界', () => {
  beforeEach(() => {
    runtimeFeatures.recruitmentReportsEnabled = false
    Object.assign(authSession, {
      ready: true,
      loading: false,
      user: { id: 'u1', name: '测试', email: 'test@example.invalid', role: 'recruiter', departmentId: '', workspaceId: 'w1' },
      workspaces: [{ id: 'w1', name: '企业', kind: 'production', status: 'active', role: 'owner', createdAt: '2026-10-12' }],
    })
  })

  it('不在导航中展示已隐藏的数据看板，直接访问也回到工作台', async () => {
    expect(navigationItems.some(item => item.path === '/reports')).toBe(false)
    const router = createAppRouter()
    installAuthGuard(router)
    await router.push('/reports')
    expect(router.currentRoute.value.name).toBe('dashboard')
    expect(router.currentRoute.value.query).toEqual({ notice: 'recruitment-reports-disabled' })
  })
  it('管理员开启报表后普通企业成员可见入口并正常访问', async () => {
    runtimeFeatures.recruitmentReportsEnabled = true
    runtimeFeatures.loaded = true
    runtimeFeatures.sessionKey = `${authSession.sessionId}:u1`
    try {
      authSession.workspaces[0]!.role = 'member'
      expect(getNavigationItemsForRole('recruiter', 'member').some(item => item.path === '/reports')).toBe(true)
      const router = createAppRouter()
      installAuthGuard(router)
      await router.push('/reports')
      expect(router.currentRoute.value.path).toBe('/reports')
    } finally { runtimeFeatures.recruitmentReportsEnabled = false; runtimeFeatures.loaded = false }
  })
})


describe('平台统一 AI 配置权限边界',()=>{
  it.each(['owner','admin','member'] as const)('企业角色 %s 可以访问企业 AI 配置但不能访问平台配置',async(workspaceRole)=>{
    Object.assign(authSession,{ready:true,loading:false,user:{id:'u1',name:'测试',email:'test@example.invalid',role:'admin',departmentId:'',workspaceId:'w1'},workspaces:[{id:'w1',name:'企业',kind:'test',status:'active',role:workspaceRole,createdAt:'2026-10-12'}]})
    const router=createAppRouter();installAuthGuard(router);await router.push('/enterprise/ai')
    expect(router.currentRoute.value.name).toBe(workspaceRole === 'member' ? 'forbidden' : 'enterprise-ai')
    expect(getNavigationItemsForRole('admin',workspaceRole).some(item=>item.path==='/enterprise/ai')).toBe(workspaceRole !== 'member')
    await router.push('/administration?module=ai')
    expect(router.currentRoute.value.name).toBe('forbidden')
  })
  it('仅允许绑定的系统管理员进入统一配置页',async()=>{
    Object.assign(authSession, { user: { id:'p',name:'系统管理员',email:'p@example.invalid',role:'recruiter',departmentId:'',isSystemAdmin:true }, workspaces: [] })
    const router=createAppRouter();installAuthGuard(router);await router.push('/administration?module=ai')
    expect(router.currentRoute.value.name).toBe('administration')
    expect(getNavigationItemsForRole('recruiter',undefined,undefined,true).some(item=>item.name==='administration')).toBe(true)
  })
})

describe('platform operations route boundary', () => {
  beforeEach(() => { authSession.ready=true; authSession.loading=false; authSession.workspaces=[] })
  it.each(['admin','viewer'] as const)('does not accept a legacy %s grant as system administration', async platformRole => {
    authSession.user={id:'p',name:'用户',email:'p@example.invalid',role:'recruiter',departmentId:'',platformRole}
    const router=createAppRouter(); installAuthGuard(router); await router.push('/platform/customers')
    expect(router.currentRoute.value.name).toBe('forbidden')
    expect(getNavigationItemsForRole('recruiter', undefined, platformRole).some(item=>item.platformOnly)).toBe(false)
    await router.push('/login')
    expect(router.currentRoute.value.path).toBe('/workspaces')
  })
  it('allows only the bound system administrator to manage platform and configuration', async () => {
    authSession.user={id:'system',name:'系统管理员',email:'system@example.invalid',role:'recruiter',departmentId:'',isSystemAdmin:true}
    const router=createAppRouter(); installAuthGuard(router)
    for (const target of ['/platform/customers','/platform/users','/administration']) {
      await router.push(target)
      expect(router.currentRoute.value.path).toBe(target)
    }
    expect(getNavigationItemsForRole('recruiter',undefined,null,true).some(item=>item.platformOnly)).toBe(true)
  })
  it('does not promote an enterprise owner to system administration', async () => {
    authSession.user={id:'u',name:'企业',email:'u@example.invalid',role:'admin',departmentId:'',workspaceId:'w'}
    authSession.workspaces=[{id:'w',name:'企业',kind:'test',status:'active',role:'owner',createdAt:'2026-10-12'}]
    expect(getNavigationItemsForRole('admin','owner').some(item=>item.platformOnly)).toBe(false)
    const router=createAppRouter(); installAuthGuard(router); await router.push('/platform/customers')
    expect(router.currentRoute.value.name).toBe('forbidden')
  })
})

describe('legacy enterprise AI bookmark compatibility', () => {
  it.each(['owner', 'member'] as const)('redirects %s through enterprise authorization without a platform grant', async (role) => {
    Object.assign(authSession, {ready:true, loading:false, user:{id:'u',name:'企业用户',email:'u@example.invalid',role:'recruiter',departmentId:'',workspaceId:'w'},workspaces:[{id:'w',name:'企业',kind:'test',status:'active',role,createdAt:'2026-10-12'}]})
    const router=createAppRouter(); installAuthGuard(router); await router.push('/administration?module=ai')
    expect(router.currentRoute.value.name).toBe('forbidden')
  })
})

describe('retired enterprise AI usage display', () => {
  it('has no page component or navigation entry, including for system administrators', () => {
    const route = createAppRouter().getRoutes().find(route => route.name === 'enterprise-ai-usage')
    expect(route?.redirect).toEqual({ name: 'dashboard' })
    expect(route?.components?.default).toBeUndefined()
    expect(navigationItems.some(item => item.path === '/enterprise/ai-usage')).toBe(false)
    for (const role of ['owner', 'admin', 'member'] as const) {
      for (const system of [false, true]) {
        expect(getNavigationItemsForRole('admin', role, 'admin', system).some(item => item.path === '/enterprise/ai-usage')).toBe(false)
      }
    }
  })

  it.each(['owner', 'admin', 'member'] as const)('redirects legacy bookmarks for %s to the dashboard', async role => {
    Object.assign(authSession, { ready: true, loading: false, user: { id: 'u1', name: '用户', email: 'test@example.invalid', role: 'recruiter', departmentId: '', workspaceId: 'w1' }, workspaces: [{ id: 'w1', name: '企业', kind: 'test', status: 'active', role, createdAt: '2026-10-12' }] })
    const router = createAppRouter()
    installAuthGuard(router)
    await router.push('/enterprise/ai-usage?state=settled#history')
    expect(router.currentRoute.value.name).toBe('dashboard')
    expect(router.currentRoute.value.matched.some(route => route.name === 'enterprise-ai-usage')).toBe(false)
  })

  it('keeps authentication required for legacy bookmarks', async () => {
    Object.assign(authSession, { ready: true, loading: false, user: null, workspaces: [] })
    const router = createAppRouter()
    installAuthGuard(router)
    await router.push('/enterprise/ai-usage')
    expect(router.currentRoute.value.name).toBe('login')
  })
})

describe('enterprise payment membership and system payment administration', () => {
  it('hides checkout navigation without an active enterprise membership', () => {
    expect(getNavigationItemsForRole('recruiter').some(item => item.billingOnly)).toBe(false)
    expect(getNavigationItemsForRole('recruiter', 'member', null, false, false).some(item => item.billingOnly)).toBe(false)
    expect(getNavigationItemsForRole('recruiter', 'member', null, false, true).some(item => item.name === 'enterprise-payments')).toBe(false)
    expect(getNavigationItemsForRole('recruiter', null, null, true).some(item => item.billingOnly)).toBe(false)
  })
  it.each(['owner', 'admin', 'member'] as const)('%s can access shared checkout and orders', async role => {
    Object.assign(authSession, { ready: true, loading: false, user: { id: 'u', name: '用户', email: 'u@example.invalid', role: 'recruiter', departmentId: '', workspaceId: 'w1' }, workspaces: [{ id: 'w1', name: '企业', kind: 'test', status: 'active', role, createdAt: '2026-10-12' }] })
    const router = createAppRouter()
    installAuthGuard(router)
    await router.push('/enterprise/payments')
    expect(router.currentRoute.value.name).toBe(role === 'member' ? 'forbidden' : 'enterprise-payments')
    await router.push('/enterprise/payments/order')
    expect(router.currentRoute.value.name).toBe(role === 'member' ? 'forbidden' : 'enterprise-payment-order')
    expect(getNavigationItemsForRole('recruiter', role).some(item => item.name === 'enterprise-payments')).toBe(role !== 'member')
    await router.push('/enterprise/payments?workspace=outside')
    expect(router.currentRoute.value.name).toBe('forbidden')
  })
  it('allows expired enterprise administrators to renew but rejects archived membership', async () => {
    Object.assign(authSession, { ready: true, loading: false, user: { id: 'u', name: '用户', email: 'u@example.invalid', role: 'recruiter', departmentId: '' }, workspaces: [{ id: 'w1', name: '企业', kind: 'test', status: 'active', role: 'owner', serviceAvailable: false, createdAt: '2026-10-12' }] })
    const router = createAppRouter()
    installAuthGuard(router)
    await router.push('/enterprise/payments?workspace=w1')
    expect(router.currentRoute.value.name).toBe('enterprise-payments')
    authSession.workspaces[0]!.status = 'archived'
    await router.push('/enterprise/payments/order?workspace=w1')
    expect(router.currentRoute.value.name).toBe('forbidden')
  })
  it('only the system administrator can access payment management, independent of platform grants', async () => {
    Object.assign(authSession, { ready: true, loading: false, user: { id: 'u', name: '用户', email: 'u@example.invalid', role: 'admin', departmentId: '', platformRole: 'admin' }, workspaces: [] })
    const router = createAppRouter()
    installAuthGuard(router)
    await router.push('/platform/payments')
    expect(router.currentRoute.value.name).toBe('forbidden')
    expect(getNavigationItemsForRole('admin', null, 'admin').some(item => item.name === 'platform-payments')).toBe(false)
    authSession.user!.isSystemAdmin = true
    authSession.user!.platformRole = undefined
    await router.push('/platform/payments')
    expect(router.currentRoute.value.name).toBe('platform-payments')
    expect(getNavigationItemsForRole('recruiter', null, null, true).some(item => item.name === 'platform-payments')).toBe(true)
  })
})

describe('user profile route', () => {
  it('allows an authenticated user without an active workspace to view and edit their profile', async () => {
    Object.assign(authSession, {
      ready: true,
      loading: false,
      user: { id: 'u1', name: '未选空间用户', email: 'user@example.invalid', role: 'recruiter', departmentId: '' },
      workspaces: [],
    })
    const router = createAppRouter()
    installAuthGuard(router)
    await router.push('/profile')
    expect(router.currentRoute.value.name).toBe('profile')
  })
})
