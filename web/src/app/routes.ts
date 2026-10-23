import type { RouteRecordRaw } from 'vue-router'
import type { AuthRole } from '../modules/auth/api'

export interface RouteMeta {
  title: string
  navLabel: string
  icon: string
  group: string
  crumb: string
  hideInNav?: boolean
  hideShell?: boolean
  adminOnly?: boolean
  workspaceAdminOnly?: boolean
  platformOnly?: boolean
  platformAdminOnly?: boolean
  billingOnly?: boolean
  requiresRecruitmentRequests?: boolean
  roles?: AuthRole[]
}

export type AppRouteRecord = RouteRecordRaw & {
  meta: RouteMeta
}

export const appRoutes: AppRouteRecord[] = [
  {
    path: '/',
    name: 'dashboard',
    component: () => import('../modules/dashboard/pages/DashboardPage.vue'),
    meta: {
      title: '招聘工作台', navLabel: '招聘工作台', icon: '◈', group: '总览', crumb: '首页 / 招聘工作台',
    },
  },
  {
    path: '/requisitions',
    name: 'requisitions',
    component: () => import('../modules/requisitions/pages/RequisitionListPage.vue'),
    meta: {
      title: '需求管理 · 审批', navLabel: '需求管理', icon: '①', group: '招聘需求', crumb: '招聘需求 / 审批管理',
      requiresRecruitmentRequests: true,
    },
  },
  {
    path: '/requisitions/:id',
    name: 'requisition-detail',
    component: () => import('../modules/requisitions/pages/RequisitionDetailPage.vue'),
    meta: {
      title: '需求详情', navLabel: '需求详情', icon: '①', group: '招聘需求', crumb: '招聘需求 / 需求详情',
      requiresRecruitmentRequests: true,
    },
  },
  {
    path: '/jobs',
    name: 'jobs',
    component: () => import('../modules/jobs/pages/JobListPage.vue'),
    meta: {
      title: '岗位管理', navLabel: '岗位管理', icon: '②', group: '岗位招聘', crumb: '岗位招聘 / 岗位说明书与 JD',
    },
  },
  {
    path: '/jobs/:id',
    name: 'job-detail',
    component: () => import('../modules/jobs/pages/JobDetailPage.vue'),
    meta: {
      title: '岗位详情', navLabel: '岗位详情', icon: '②', group: '岗位招聘', crumb: '岗位招聘 / 岗位详情',
    },
  },
  {
    path: '/candidates',
    name: 'candidates',
    component: () => import('../modules/candidates/pages/CandidateListPage.vue'),
    meta: {
      title: '简历库 · AI 评分', navLabel: '简历库 · AI 评分', icon: '③', group: '候选人', crumb: '候选人 / 简历库 · AI 评分',
    },
  },
  {
    path: '/candidates/:id',
    name: 'candidate-detail',
    component: () => import('../modules/candidates/pages/CandidateDetailPage.vue'),
    meta: {
      title: '候选人详情', navLabel: '候选人详情', icon: '③', group: '候选人', crumb: '候选人 / 候选人详情',
    },
  },
  {
    path: '/interviews',
    name: 'interviews',
    component: () => import('../modules/interviews/pages/InterviewListPage.vue'),
    meta: {
      title: '面试中心', navLabel: '面试中心', icon: '④', group: '面试', crumb: '面试 / 面试表与安排',
    },
  },
  {
    path: '/interviews/:id/live',
    name: 'interview-live',
    component: () => import('../modules/interviews/pages/LiveInterviewPage.vue'),
    meta: {
      title: 'AI 面试室', navLabel: 'AI 面试室', icon: '④', group: '面试', crumb: '面试 / AI 面试室',
    },
  },
  {
    path: '/interviews/:id',
    name: 'interview-detail',
    component: () => import('../modules/interviews/pages/InterviewDetailPage.vue'),
    meta: {
      title: '面试详情', navLabel: '面试详情', icon: '④', group: '面试', crumb: '面试 / 面试详情',
    },
  },
  {
    path: '/offers',
    name: 'offers',
    component: () => import('../modules/offers/pages/OfferListPage.vue'),
    meta: {
      title: '录用审批与 Offer', navLabel: '录用审批与 Offer', icon: '⑥', group: '录用', crumb: '录用 / 定薪审批与 Offer',
    },
  },
  {
    path: '/offers/:id',
    name: 'offer-detail',
    component: () => import('../modules/offers/pages/OfferDetailPage.vue'),
    meta: {
      title: 'Offer 详情', navLabel: 'Offer 详情', icon: '⑥', group: '录用', crumb: '录用 / Offer 详情',
    },
  },
  {
    path: '/login',
    name: 'login',
    component: () => import('../modules/auth/pages/LoginPage.vue'),
    meta: {
      title: '登录', navLabel: '登录', icon: '🔒', group: '系统', crumb: '系统 / 登录',
      hideInNav: true,
      hideShell: true,
    },
  },
  {
    path: '/register',
    name: 'register',
    component: () => import('../modules/auth/pages/RegisterPage.vue'),
    meta: {
      title: '注册企业账号', navLabel: '注册企业账号', icon: '🔒', group: '系统', crumb: '系统 / 注册企业账号',
      hideInNav: true,
      hideShell: true,
    },
  },
  {
    path: '/workspaces',
    name: 'workspaces',
    component: () => import('../modules/auth/pages/WorkspacePage.vue'),
    meta: {
      title: '企业工作空间', navLabel: '企业工作空间', icon: '⌂', group: '系统', crumb: '系统 / 企业工作空间',
      hideInNav: false,
      hideShell: false,
    },
  },
  {
    path: '/onboarding',
    name: 'onboarding',
    component: () => import('../modules/onboarding/pages/OnboardingListPage.vue'),
    meta: {
      title: '入职归档', navLabel: '入职归档', icon: '⑦', group: '录用', crumb: '录用 / 入职归档',
    },
  },
  {
    path: '/reports',
    name: 'reports',
    component: () => import('../modules/reports/pages/ReportOverviewPage.vue'),
    meta: {
      title: '招聘数据看板', navLabel: '招聘数据看板', icon: '▦', group: '洞察', crumb: '洞察 / 数据看板',
    },
  },
  {
    path: '/forbidden',
    name: 'forbidden',
    component: () => import('../shared/components/ForbiddenPage.vue'),
    meta: {
      title: '无权限', navLabel: '无权限', icon: '⛔', group: '系统', crumb: '系统 / 无权限',
      hideInNav: true,
      hideShell: true,
    },
  },
  {
    path: '/enterprise/ai',
    name: 'enterprise-ai',
    component: () => import('../modules/administration/pages/AdministrationPage.vue'),
    props: { enterpriseAiOnly: true },
    meta: { title: '企业 AI 配置', navLabel: '企业 AI 配置', icon: '✦', group: '系统', crumb: '系统 / 企业 AI 配置', workspaceAdminOnly: true },
  },
  {
    path: '/enterprise/ai-usage',
    name: 'enterprise-ai-usage',
    component: () => import('../modules/platform/pages/EnterpriseAiUsagePage.vue'),
    meta: { title: '企业 AI 用量', navLabel: '企业 AI 用量', icon: '▤', group: '系统', crumb: '系统 / 企业 AI 用量', workspaceAdminOnly: true },
  },
  {
    path: '/enterprise/billing-sandbox',
    name: 'enterprise-billing-sandbox',
    component: () => import('../modules/platform/pages/EnterpriseBillingSandboxPage.vue'),
    meta: {title:'支付流程测试',navLabel:'支付流程测试',icon:'◇',group:'企业管理',crumb:'企业管理 / 支付流程测试',workspaceAdminOnly:true},
  },
  {
    path: '/enterprise/payments', name: 'enterprise-payments',
    component: () => import('../modules/platform/pages/EnterprisePaymentsPage.vue'),
    meta: {title:'套餐订购与续费',navLabel:'套餐订购与续费',icon:'◇',group:'企业管理',crumb:'企业管理 / 套餐订购与续费',workspaceAdminOnly:true,billingOnly:true},
  },
  {
    path: '/enterprise/payments/:id', name: 'enterprise-payment-order',
    component: () => import('../modules/platform/pages/EnterprisePaymentsPage.vue'),
    meta: {title:'付款订单',navLabel:'付款订单',icon:'◇',group:'企业管理',crumb:'企业管理 / 付款订单',workspaceAdminOnly:true,billingOnly:true,hideInNav:true},
  },
  {
    path: '/platform/payments', name: 'platform-payments',
    component: () => import('../modules/platform/pages/PlatformPaymentsPage.vue'),
    meta: {title:'支付与商品管理',navLabel:'支付与商品管理',icon:'¥',group:'平台运营',crumb:'平台运营 / 支付与商品管理',platformOnly:true},
  },
  {
    path: '/platform/customers',
    name: 'platform-customers',
    component: () => import('../modules/platform/pages/PlatformCustomersPage.vue'),
    meta: { title: '企业客户管理', navLabel: '企业客户管理', icon: '▧', group: '平台运营', crumb: '平台运营 / 企业客户管理', platformOnly: true },
  },
  {
    path: '/administration',
    name: 'administration',
    component: () => import('../modules/administration/pages/AdministrationPage.vue'),
    meta: {
      title: '平台系统配置', navLabel: '平台系统配置', icon: '⚙', group: '平台运营', crumb: '平台运营 / 系统配置', platformOnly: true, platformAdminOnly: true,
    },
  },
  {
    path: '/enterprise/approval-settings',
    name: 'enterprise-approval-settings',
    component: () => import('../modules/administration/pages/EnterpriseApprovalSettingsPage.vue'),
    meta: {
      title: '需求审批设置', navLabel: '需求审批设置', icon: '✓', group: '系统', crumb: '系统 / 需求审批设置', workspaceAdminOnly: true,
      requiresRecruitmentRequests: true,
    },
  },
  {
    path: '/:pathMatch(.*)*',
    name: 'not-found',
    redirect: '/',
    meta: {
      title: '招聘工作台', navLabel: '招聘工作台', icon: '◈', group: '总览', crumb: '首页 / 招聘工作台',
    },
  },
]
