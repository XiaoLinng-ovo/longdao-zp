import type { RouteRecordRaw } from 'vue-router'

export interface RouteMeta {
  title: string
  navLabel: string
  icon: string
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
      title: '招聘概览',
      navLabel: '仪表盘',
      icon: 'layout-dashboard',
    },
  },
  {
    path: '/requisitions',
    name: 'requisitions',
    component: () => import('../modules/requisitions/pages/RequisitionListPage.vue'),
    meta: {
      title: '招聘需求',
      navLabel: '招聘需求',
      icon: 'clipboard-list',
    },
  },
  {
    path: '/jobs',
    name: 'jobs',
    component: () => import('../modules/jobs/pages/JobListPage.vue'),
    meta: {
      title: '岗位管理',
      navLabel: '岗位',
      icon: 'briefcase-business',
    },
  },
  {
    path: '/candidates',
    name: 'candidates',
    component: () => import('../modules/candidates/pages/CandidateListPage.vue'),
    meta: {
      title: '候选人',
      navLabel: '候选人',
      icon: 'users',
    },
  },
  {
    path: '/interviews',
    name: 'interviews',
    component: () => import('../modules/interviews/pages/InterviewListPage.vue'),
    meta: {
      title: '面试管理',
      navLabel: '面试',
      icon: 'calendar-days',
    },
  },
  {
    path: '/offers',
    name: 'offers',
    component: () => import('../modules/offers/pages/OfferListPage.vue'),
    meta: {
      title: 'Offer 管理',
      navLabel: 'Offer',
      icon: 'file-check-2',
    },
  },
  {
    path: '/reports',
    name: 'reports',
    component: () => import('../modules/reports/pages/ReportOverviewPage.vue'),
    meta: {
      title: '招聘报表',
      navLabel: '报表',
      icon: 'chart-no-axes-combined',
    },
  },
  {
    path: '/administration',
    name: 'administration',
    component: () => import('../modules/administration/pages/AdministrationPage.vue'),
    meta: {
      title: '管理后台',
      navLabel: '管理',
      icon: 'settings-2',
    },
  },
  {
    path: '/:pathMatch(.*)*',
    name: 'not-found',
    redirect: '/',
    meta: {
      title: '招聘概览',
      navLabel: '仪表盘',
      icon: 'layout-dashboard',
    },
  },
]
