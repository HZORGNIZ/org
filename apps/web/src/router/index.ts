import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';
import { useAuthStore } from '../stores/auth';
import MainLayout from '../layouts/MainLayout.vue';

const routes: RouteRecordRaw[] = [
  { path: '/login', name: 'login', component: () => import('../views/LoginView.vue') },
  {
    path: '/share/:projectId',
    name: 'share',
    component: () => import('../views/ShareView.vue'),
    meta: { public: true },
  },
  // 活动对外页：陌生人凭链接免登录看活动、签到、答题加分、看小组得分
  {
    path: '/share/meeting/:token',
    name: 'public-meeting',
    component: () => import('../views/PublicMeetingView.vue'),
    meta: { public: true },
  },
  // 项目助理小助手独立入口（手机友好）：不带 MainLayout 外壳，打开即全屏对话；
  // 底层服务/会话历史与首页悬浮窗完全同一套（同一组件、同一 AgentSession）
  {
    path: '/mobile',
    name: 'mobile-assistant',
    component: () => import('../views/MobileAssistantView.vue'),
  },
  {
    path: '/',
    component: MainLayout,
    children: [
      { path: '', name: 'home', component: () => import('../views/HomeView.vue') },
      { path: 'ideas', name: 'ideas', component: () => import('../views/IdeasView.vue') },
      { path: 'tasks', name: 'tasks', component: () => import('../views/TasksView.vue') },
      // 看板已并入「任务」页的大 tab：菜单/首页入口/旧书签统一跳过去（不再单独占一页）
      { path: 'board', redirect: { name: 'tasks', query: { tab: 'board' } } },
      { path: 'projects', name: 'projects', component: () => import('../views/ProjectsView.vue') },
      { path: 'projects/:id', name: 'project-detail', component: () => import('../views/ProjectDetailView.vue') },
      { path: 'projects/:id/weekly-report', name: 'project-weekly-report', component: () => import('../views/ProjectWeeklyReportView.vue') },
      // 侧边菜单「部门」已并进「管理后台 → 部门管理」tab（管理员用）；这里保留路由，作为普通成员从首页「我的部门」进入的只读入口
      { path: 'departments', name: 'departments', component: () => import('../views/DepartmentView.vue') },
      // 员工画像：站内所有人名入口都指这里（管理员/本人/同部门/所管部门可见，越权由后端 403，页面渲染空态）
      { path: 'members/:id', name: 'member-profile', component: () => import('../views/MemberProfileView.vue') },
      { path: 'reports', name: 'reports', component: () => import('../views/ReportsView.vue') },
      // 日报看板 / 工时统计已内迁为「工作管理」的大 tab：旧链接带上对应 tab
      { path: 'reports/stats', redirect: { name: 'reports', query: { tab: 'board' } } },
      { path: 'reports/weekly-aggregate', name: 'company-weekly-report', component: () => import('../views/CompanyWeeklyView.vue') },
      { path: 'meetings', name: 'meetings', component: () => import('../views/MeetingsView.vue') },
      // 会议详情深链：站内信与钉钉消息里带的都是 /meetings/{id}，复用同一页面并自动弹开详情抽屉
      { path: 'meetings/:id', name: 'meeting-detail', component: () => import('../views/MeetingsView.vue') },
      { path: 'data-center', name: 'data-center', component: () => import('../views/DataCenterView.vue') },
      // 知识库 / SOP / 资讯 已合并为「资料中心」大 tab：旧路由保留，转成 ?tab= 直达对应页签（并保留原 query，如小助手 ?doc= 深链）
      { path: 'knowledge', name: 'knowledge', redirect: (to) => ({ name: 'data-center', query: { ...to.query, tab: 'knowledge' } }) },
      // 资源预约模块下线（暂时不要了）：旧链接直接回首页，页面与后端数据保留在历史版本里
      { path: 'resources', redirect: '/' },
      { path: 'retrospectives', name: 'retrospectives', component: () => import('../views/RetrospectivesView.vue') },
      { path: 'sops', name: 'sops', redirect: (to) => ({ name: 'data-center', query: { ...to.query, tab: 'sops' } }) },
      { path: 'news', name: 'news', redirect: (to) => ({ name: 'data-center', query: { ...to.query, tab: 'news' } }) },
      { path: 'notifications', name: 'notifications', component: () => import('../views/NotificationsView.vue') },
      // 待加入组织缺省页：菜单位置保留、路由可达，但除本页外所有页面都被下面的准入闸换到此处
      { path: 'pending', name: 'pending', component: () => import('../views/PendingView.vue') },
      { path: 'profile', name: 'profile', component: () => import('../views/ProfileView.vue') },
      { path: 'admin', name: 'admin', component: () => import('../views/admin/AdminView.vue'), meta: { admin: true } },
      // 会议考勤已内迁到「会议活动」页的大 tab：旧链接（菜单/书签）跳过去
      { path: 'admin/meeting-stats', redirect: { name: 'meetings', query: { tab: 'stats' } } },
      { path: 'ai-calls', name: 'ai-calls', component: () => import('../views/AiCallsView.vue'), meta: { admin: true } },
      { path: 'inventory', name: 'inventory', component: () => import('../views/InventoryView.vue') },
      { path: 'secrecy', name: 'secrecy', component: () => import('../views/SecrecyView.vue'), meta: { admin: true } },
    ],
  },
  { path: '/:pathMatch(.*)*', redirect: '/' },
];

const router = createRouter({
  history: createWebHistory(),
  routes,
});

router.beforeEach((to) => {
  const auth = useAuthStore();
  // 公开页（对外文档分享）免登录直接放行
  if (to.meta.public) return true;
  if (to.name !== 'login' && !auth.loggedIn) {
    return { name: 'login', query: { redirect: to.fullPath } };
  }
  if (to.name === 'login' && auth.loggedIn) {
    // 登录后的 redirect 参数优先（从 /mobile 被拦去登录的要送回 /mobile）；只收站内相对路径
    const redirect = to.query.redirect as string;
    return redirect && redirect.startsWith('/') && !redirect.startsWith('//') ? redirect : { name: 'home' };
  }
  // 组织准入：普通成员尚未分配部门 → 除等待页外一律落到缺省页（组件不挂载就不会发业务请求）
  if (auth.pendingOrg) {
    return to.name === 'pending' ? true : { name: 'pending' };
  }
  if (to.name === 'pending') {
    return { name: 'home' };
  }
  if (to.meta.admin && !auth.isAdmin) {
    return { name: 'home' };
  }
  // 管理者页（项目经理及以上）：普通成员弹回首页
  if (to.meta.manager && auth.roleRank < 1) {
    return { name: 'home' };
  }
  return true;
});

export default router;
