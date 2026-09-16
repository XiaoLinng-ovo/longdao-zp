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
    },
  },
  {
    path: '/requisitions/:id',
    name: 'requisition-detail',
    component: () => import('../modules/requisitions/pages/RequisitionDetailPage.vue'),
    meta: {
      title: '需求详情', navLabel: '需求详情', icon: '①', group: '招聘需求', crumb: '招聘需求 / 需求详情',
    },
  },
  {
    path: '/jobs',
    name: 'jobs',
    component: () => import('../modules/jobs/pages/JobListPage.vue'),
    meta: {
      title: '岗位管理', navLabel: '岗位管理', icon: '②', group: '招聘需求', crumb: '招聘需求 / 岗位说明书与 JD',
    },
  },
  {
    path: '/jobs/:id',
    name: 'job-detail',
    component: () => import('../modules/jobs/pages/JobDetailPage.vue'),
    meta: {
      title: '岗位详情', navLabel: '岗位详情', icon: '②', group: '招聘需求', crumb: '招聘需求 / 岗位详情',
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
      title: '招聘数据看板', navLabel: '招聘数据看板', icon: '▦', group: '洞察', crumb: '洞察 / 招聘数据看板',
    },
  },
  {
    path: '/administration',
    name: 'administration',
    component: () => import('../modules/administration/pages/AdministrationPage.vue'),
    meta: {
      title: '系统配置', navLabel: '系统配置', icon: '⚙', group: '系统', crumb: '系统 / 配置与审计', adminOnly: true, roles: ['admin', 'hr_admin'],
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
