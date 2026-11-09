import { api, http, getMeetingPwdTicket, setMeetingPwdTicket } from './client';

// ---------- 认证 ----------
export const authApi = {
  login: (account: string, password: string) =>
    api.post<{ accessToken: string; user: any }>('/auth/login', { account, password }),
  register: (data: { username: string; name: string; email: string; phone: string; password: string }) =>
    api.post<{ accessToken: string; user: any }>('/auth/register', data),
  changePassword: (data: { oldPassword: string; newPassword: string }) =>
    api.post('/auth/change-password', data),
  /** 管理员以指定用户身份预览（仅 ADMIN；返回带预览标记的短期 token 及目标用户信息） */
  impersonate: (userId: string) =>
    api.post<{ accessToken: string; user: any }>('/auth/impersonate', { userId }),
};

// ---------- 用户 ----------
export const usersApi = {
  me: () => api.get<any>('/users/me'),
  updateMe: (data: any) => api.patch('/users/me', data),
  list: () => api.get<any[]>('/users'),
  create: (data: { username: string; name: string; phone?: string; departmentId?: string | null; additionalDepartmentIds?: string[] }) =>
    api.post<any>('/users', data),
  update: (id: string, data: { username?: string; name?: string; phone?: string; departmentId?: string | null; additionalDepartmentIds?: string[] }) =>
    api.patch<any>(`/users/${id}`, data),
  remove: (id: string) => api.del(`/users/${id}`),
  setRole: (id: string, role: string) => api.patch(`/users/${id}/role`, { role }),
  setActive: (id: string, active: boolean) => api.patch(`/users/${id}/active`, { active }),
  /** 管理员重置密码（重置为默认密码，用户下次登录强制修改） */
  resetPassword: (id: string) => api.post<any>(`/users/${id}/reset-password`),
};

// ---------- 部门 ----------
export const departmentsApi = {
  list: () => api.get<any[]>('/departments'),
  /** 首页「我的部门情况」：当前用户所在部门概况（未归属返回 null） */
  myStatus: () => api.get<any | null>('/departments/my'),
  /** 部门详情：基本信息 + 成员（含备注） + 主要关联项目 */
  detail: (id: string) => api.get<any>(`/departments/${id}`),
  /** 编辑/删除部门成员备注（仅管理员或该部门负责人；note 传空删除） */
  setNote: (id: string, userId: string, note: string) =>
    api.put<any>(`/departments/${id}/members/${userId}/note`, { note }),
  create: (data: { name: string; description?: string; sortOrder?: number }) =>
    api.post<any>('/departments', data),
  update: (id: string, data: { name?: string; description?: string; sortOrder?: number }) =>
    api.patch<any>(`/departments/${id}`, data),
  remove: (id: string) => api.del(`/departments/${id}`),
  /** 设置/取消部门负责人（userId 传 null 取消） */
  setLeader: (id: string, userId: string | null) =>
    api.patch<any>(`/departments/${id}/leader`, { userId }),
  /** 设置部门共管人名单（与负责人同权限、管整个部门；大部门一个负责人管不过来时增设） */
  setManagers: (id: string, userIds: string[]) =>
    api.put<any>(`/departments/${id}/managers`, { userIds }),
  /** 岗位清单 */
  positions: () => api.get<string[]>('/departments/positions'),
  savePositions: (positions: string[]) => api.put<string[]>('/departments/positions', { positions }),
  /** 部门日报规则（仅管理员/该部门负责人） */
  getReportSetting: (id: string) =>
    api.get<any>(`/departments/${id}/report-setting`),
  /** 更新部门日报规则（保存后立即生效） */
  saveReportSetting: (
    id: string,
    data: { reportFrequency?: string; reportWeeklyCount?: number | null; reportRemindTime?: string; reportNotifyLeader?: boolean },
  ) => api.put<any>(`/departments/${id}/report-setting`, data),
  /** 部门本周成员日报完成情况（仅管理员/该部门负责人） */
  reportStatus: (id: string) => api.get<any>(`/departments/${id}/report-status`),
  /** 汇报树（管理员可改任意人；部门负责人/共管人可读全树、只可改本部门名册）：{ roots[], flat[], canEditIds[] } */
  reportTree: () => api.get<{ roots: any[]; flat: any[]; canEditIds: string[] }>('/departments/report-tree'),
  /** 设置某人直属上级；parentId 传 null 置为根 */
  setReportsTo: (userId: string, parentId: string | null) =>
    api.put<any>('/departments/report-to', { userId, parentId }),
};

// ---------- 成员画像 ----------
export const membersApi = {
  /** GET /members/:id：工时/日报/项目/任务/会议活动/贡献聚合（私有块由后端按档位裁剪） */
  profile: (id: string) => api.get<any>(`/members/${id}`),
  /** 人名模糊搜索（姓名/用户名），只在可见范围内返回 */
  search: (q: string) => api.get<any[]>('/members', { q }),
};

// ---------- 项目 ----------
export const projectsApi = {
  list: (archived = false) =>
    api.get<any[]>(archived ? '/projects?archived=true' : '/projects'),
  get: (id: string) => api.get<any>(`/projects/${id}`),
  create: (data: any) => api.post('/projects', data),
  update: (id: string, data: any) => api.patch(`/projects/${id}`, data),
  /** 删除项目（仅系统管理员）：移入回收站（软删除，可恢复） */
  remove: (id: string) => api.del(`/projects/${id}`),
  /** 回收站（已软删除项目，仅管理员） */
  trash: () => api.get<any[]>('/projects/trash'),
  /** 从回收站恢复 */
  restore: (id: string) => api.patch(`/projects/${id}/restore`, {}),
  /** 彻底删除（不可恢复，仅管理员） */
  purge: (id: string) => api.del(`/projects/${id}/purge`),
  addMember: (id: string, userId: string) =>
    api.post(`/projects/${id}/members`, { userId }),
  removeMember: (id: string, userId: string) =>
    api.del(`/projects/${id}/members/${userId}`),
  /** 设置项目成员岗位（产品经理/工程师/运维等；position 传 null 清空） */
  setMemberPosition: (id: string, userId: string, position: string | null) =>
    api.patch(`/projects/${id}/members/${userId}/position`, { position }),
  transferOwner: (id: string, userId: string) =>
    api.patch(`/projects/${id}/owner`, { userId }),
  createBoard: (projectId: string, name: string) =>
    api.post(`/projects/${projectId}/boards`, { name }),
  dingtalkGroups: () => api.get<any[]>('/projects/dingtalk-groups'),
  resolveDingtalkGroup: (name: string) => api.post<any>('/projects/dingtalk-group/resolve', { name }),
  myUpdates: () => api.get<any[]>('/projects/my-updates'),
  /** 首页每项目进展展示条数（管理员）：{ count } 0~10 */
  homeDisplay: () => api.get<any>('/projects/home-display'),
  /** 修改首页展示条数（管理员；保存后首页立即生效） */
  saveHomeDisplay: (count: number) => api.put<any>('/projects/home-display', { count }),
  generateUpdates: () => api.post('/projects/updates/generate'),
  /** 进展转任务后回链：记录该进展已转为指定任务（条目将以已转任务样式展示） */
  linkUpdateTask: (updateId: string, taskId: string) =>
    api.post<any>('/projects/updates/link-task', { updateId, taskId }),
  /** 合并进展：把源进展并入目标进展（同项目，内容合并、删除源） */
  mergeUpdates: (sourceId: string, targetId: string) =>
    api.post<any>('/projects/updates/merge', { sourceId, targetId }),
  /** 拉取项目关联群最近 N 天（默认 2）消息并触发 AI 进展总结（负责人/管理员） */
  summarize: (id: string, days?: number) => api.post<any>(`/projects/${id}/summarize`, days ? { days } : {}),
  /** 立即把本项目最近进展发到本项目绑定钉钉群（负责人/管理员） */
  digestNow: (id: string) => api.post<any>(`/projects/${id}/digest-now`, {}),
  createColumn: (data: any) => api.post('/projects/columns', data),
  updateColumn: (id: string, data: any) => api.patch(`/projects/columns/${id}`, data),
  deleteColumn: (id: string) => api.del(`/projects/columns/${id}`),
  /** 待我审批项目列表（approverId=me 且 status=PENDING；ADMIN 兵底看全部） */
  pending: () => api.get<any[]>('/projects/pending'),
  /** 我提交的审批中/已驳回项目 */
  myApplications: () => api.get<any[]>('/projects/my-applications'),
  /** 项目审批历史 */
  approvals: (id: string) => api.get<any[]>(`/projects/${id}/approvals`),
  /** 审批通过 */
  approve: (id: string, note?: string) => api.post<any>(`/projects/${id}/approve`, { note }),
  /** 审批驳回（需附意见） */
  reject: (id: string, note: string) => api.post<any>(`/projects/${id}/reject`, { note }),
  /** 加签：主审批人或 ADMIN 邀请其他人共同审批（仅待审批期间） */
  addCoReviewers: (id: string, reviewerIds: string[]) =>
    api.post<{ ok: boolean; added: number }>(`/projects/${id}/co-reviewers`, { reviewerIds }),
  /** 加签人给出结论（APPROVED / REJECTED，驳回需附意见） */
  decideCoReview: (id: string, data: { decision: 'APPROVED' | 'REJECTED'; note?: string }) =>
    api.post<{ ok: boolean; remaining: number; rejected: boolean }>(`/projects/${id}/co-review/decide`, data),
  /** 移除尚未处理的加签人（仅主审批人或 ADMIN） */
  removeCoReviewer: (id: string, coReviewId: string) => api.del(`/projects/${id}/co-reviewers/${coReviewId}`),
  /** 驳回后重新提交 */
  resubmit: (id: string, patch: any) => api.post<any>(`/projects/${id}/resubmit`, patch),
  /** 项目完成度/健康度 AI 分析（手动重算）；AI 不可用返回 {ok:false} */
  analyzeHealth: (id: string) => api.post<any>(`/projects/${id}/health/analyze`, {}),
  /** 设为/取消保密项目（仅系统管理员；首次开启会给负责人与成员发站内信提醒签署） */
  setConfidential: (id: string, confidential: boolean) =>
    api.put<any>(`/projects/${id}/confidential`, { confidential }),
  /** 在线签署当前版本保密协议（签署后立即可见项目内容） */
  signNda: (id: string) => api.post<any>(`/projects/${id}/nda-sign`, {}),
  /** 当前生效的保密协议 { version, content } */
  ndaTemplate: () => api.get<any>('/projects/nda/template'),
  /** 改写保密协议（仅系统管理员；正文有变化才升版本） */
  saveNdaTemplate: (content: string) => api.put<any>('/projects/nda/template', { content }),
  /** 保密项目访问留痕（仅系统管理员） */
  accessLogs: (params?: any) => api.get<any[]>('/projects/access-logs', params),
  /** 发布项目规则（ADMIN 或项目负责人）：{ ok, notified, rule } */
  publishRule: (id: string, data: { title: string; content: string }) =>
    api.post<any>(`/projects/${id}/rules`, data),
  /** 修订规则正文（不清空已阅） */
  updateRule: (ruleId: string, data: { title: string; content: string }) =>
    api.put<any>(`/projects/rules/${ruleId}`, data),
  /** 删除规则 */
  deleteRule: (ruleId: string) => api.del(`/projects/rules/${ruleId}`),
  /** 点「我已阅」（note 可选，一句话说明；不可撤回） */
  ackRule: (ruleId: string, note?: string) =>
    api.post<any>(`/projects/rules/${ruleId}/ack`, { note }),
  /** 应阅/已阅/未阅名单（催办用） */
  ruleRoster: (id: string) => api.get<any>(`/projects/${id}/rules/roster`),
  /** 项目会议列表（详情页卡片）：已召开 + 即将召开 */
  meetings: (id: string) => api.get<any>(`/projects/${id}/meetings`),
  /** 项目排期计划（详情页「排期计划」页签）：阶段列表 + 项目计划期 + 是否可编辑 */
  schedule: (id: string) => api.get<any>(`/projects/${id}/schedule`),
  /** 保存排期计划（全量替换阶段；仅项目负责人/管理员） */
  saveSchedule: (id: string, items: any[]) => api.put<any>(`/projects/${id}/schedule`, { items }),
  /** 项目周报聚合视图（F27）：periodStart 传任意日期归一到该自然周，缺省本周 */
  weeklyReport: (id: string, periodStart?: string) =>
    api.get<any>(`/projects/${id}/weekly-report${periodStart ? `?periodStart=${encodeURIComponent(periodStart)}` : ''}`),
  /** 项目周报 AI 总结（命中缓存直接返回；refresh=true 强制重算） */
  weeklySummary: (id: string, periodStart?: string, refresh = false) => {
    const qs: string[] = [];
    if (periodStart) qs.push(`periodStart=${encodeURIComponent(periodStart)}`);
    if (refresh) qs.push('refresh=1');
    return api.post<any>(`/projects/${id}/weekly-report/summary${qs.length ? '?' + qs.join('&') : ''}`, {});
  },
};

// ---------- 任务 ----------
export const tasksApi = {
  list: (params?: any) => api.get<any[]>('/tasks', params),
  my: () => api.get<any>('/tasks/my'),
  get: (id: string) => api.get(`/tasks/${id}`),
  create: (data: any) => api.post('/tasks', data),
  update: (id: string, data: any) => api.patch(`/tasks/${id}`, data),
  move: (id: string, columnId: string | null, sortOrder: number) =>
    api.patch(`/tasks/${id}/move`, { columnId, sortOrder }),
  remove: (id: string) => api.del(`/tasks/${id}`),
  comment: (id: string, content: string) => api.post(`/tasks/${id}/comments`, { content }),
  activities: (id: string) => api.get<any[]>(`/tasks/${id}/activities`),
  /** 删除单条活动记录（项目负责人 / 政委 / 系统管理员；记录不可编辑） */
  removeActivity: (taskId: string, activityId: string) =>
    api.del(`/tasks/${taskId}/activities/${activityId}`),
};

// ---------- 首页 AI 录入 ----------
export interface IntakeResult {
  category: string;
  created: { type: string; id: string | null };
  summary: string;
  detail: string;
  undoable: boolean;
  needProject?: boolean;
  pendingTask?: { title: string; dueDate?: string | null; startDate?: string | null; priority?: string };
  projectOptions?: { id: string; name: string }[];
}
export const intakeApi = {
  /** 提交一段自然语言，AI 判别类别并直接落库（可撤销） */
  submit: (text: string, category?: string) =>
    api.post<IntakeResult>('/intake', { text, category }),
  /** 任务待归属项目时，选定项目后创建 */
  createTask: (data: { projectId: string; title: string; dueDate?: string | null; startDate?: string | null; priority?: string }) =>
    api.post<IntakeResult>('/intake/task', data),
  /** 撤销本次录入 */
  undo: (type: string, id: string) => api.post<{ ok: boolean; message?: string }>('/intake/undo', { type, id }),
};

// ---------- 灵感 / 需求 ----------
export const ideasApi = {
  /** 分组列表：我的 / 同项目组 / 同部门；管理员另有 others（全组织其他人的灵感） */
  list: () => api.get<{ mine: any[]; sameProject: any[]; sameDept: any[]; others: any[] }>('/ideas'),
  create: (content: string, projectId?: string | null) => api.post<any>('/ideas', { content, projectId }),
  remove: (id: string) => api.del(`/ideas/${id}`),
  /** AI 规划（仅出提议，不落库） */
  plan: (ideaIds: string[]) => api.post<{ ok: boolean; projects: any[]; tasks: any[]; message?: string }>('/ideas/plan', { ideaIds }),
  /** 人工确认后落库 */
  commit: (data: { projects?: any[]; tasks?: any[] }) =>
    api.post<{ projects: string[]; tasks: string[]; convertedIdeas: string[] }>('/ideas/commit', data),
};

// ---------- 公告 ----------
export const announcementsApi = {
  list: (params?: any) => api.get<any>('/announcements', params),
  get: (id: string) => api.get(`/announcements/${id}`),
  create: (data: any) => api.post('/announcements', data),
  update: (id: string, data: any) => api.patch(`/announcements/${id}`, data),
  remove: (id: string) => api.del(`/announcements/${id}`),
};

// ---------- 日报周报 ----------
export const reportsApi = {
  list: (type?: string) => api.get<any[]>('/reports', { type }),
  get: (id: string) => api.get(`/reports/${id}`),
  generate: (data: any) => api.post('/reports/generate', data),
  /** 提交手写日报（首页快速日报，直接提交无需确认）；hours 可选，填了以人工工时为准 */
  submitDaily: (rawContent: string, hours?: number | null) =>
    api.post('/reports/daily', hours === undefined || hours === null ? { rawContent } : { rawContent, hours }),
  /** 提交手写周报（三段式，直接提交即发布，同周·同归属追加合并）；groupIds 非空则同步把周报原文发到勾选的钉钉群；
   *  scope 可选归属（项目/部门），periodStart 可传往周日期实现补发 */
  submitWeekly: (
    rawContent: string,
    groupIds: string[] = [],
    extra?: { projectId?: string; departmentId?: string; periodStart?: string },
  ) => api.post<any>('/reports/weekly', { rawContent, groupIds, ...extra }),
  /** 首页顶部工时卡：本人本周/本月/累计工时（已发布日报 hours 求和） */
  myHours: () => api.get<any>('/reports/my-hours'),
  /** 周报草稿：把指定周已提交的本人日报聚合成三段式草稿（只回填表单不落库，人工可改后再提交） */
  weeklyDraft: (extra?: { periodStart?: string; projectId?: string; departmentId?: string }) =>
    api.post<any>('/reports/weekly-draft', extra ?? {}),
  /** 手写周报弹窗下拉数据源：可归属的项目/部门 + 本周周次 */
  weeklyComposeOptions: () => api.get<any>('/reports/weekly-compose-options'),
  /** 我的工作时间安排（计划页周视图）：presets + slots + today 口径 */
  workSlots: () => api.get<any>('/reports/work-slots'),
  /** 保存我的工作时间安排（整表覆盖，weekday 0=周一…6=周日） */
  saveWorkSlots: (slots: { weekday: number; startMin: number; endMin: number }[]) =>
    api.put<any>('/reports/work-slots', { slots }),
  /** 公司/部门周报聚合（participantIds 不传=可见范围全部） */
  weeklyAggregate: (periodStart?: string, participantIds?: string[]) => {
    const qs: string[] = [];
    if (periodStart) qs.push(`periodStart=${encodeURIComponent(periodStart)}`);
    if (participantIds && participantIds.length) qs.push(`participantIds=${encodeURIComponent(participantIds.join(','))}`);
    return api.get<any>(`/reports/weekly-aggregate${qs.length ? '?' + qs.join('&') : ''}`);
  },
  /** 公司/部门周报 AI 总结（refresh=true 强制重算） */
  weeklyAggregateSummary: (periodStart?: string, participantIds?: string[], refresh = false) => {
    const qs: string[] = [];
    if (refresh) qs.push('refresh=1');
    return api.post<any>(`/reports/weekly-aggregate/summary${qs.length ? '?' + qs.join('&') : ''}`, { periodStart, participantIds });
  },
  update: (id: string, data: { manualContent?: string; rawContent?: string; status?: string; hours?: number | null }) =>
    api.patch(`/reports/${id}`, data),
  /** 按日期聚合查看某范围所有人的日报（date 缺省=今天；projectId/departmentId 限定范围） */
  dailyOverview: (opts: { date?: string; projectId?: string; departmentId?: string } = {}) => {
    const qs: string[] = [];
    if (opts.date) qs.push(`date=${encodeURIComponent(opts.date)}`);
    if (opts.projectId) qs.push(`projectId=${encodeURIComponent(opts.projectId)}`);
    if (opts.departmentId) qs.push(`departmentId=${encodeURIComponent(opts.departmentId)}`);
    return api.get<any>(`/reports/daily-overview${qs.length ? '?' + qs.join('&') : ''}`);
  },
  /** 某成员日报时间轴（每天正文+工时，含区间累计工时）；userId 缺省=本人 */
  personTimeline: (opts: { userId?: string; from?: string; to?: string } = {}) => {
    const qs: string[] = [];
    if (opts.userId) qs.push(`userId=${encodeURIComponent(opts.userId)}`);
    if (opts.from) qs.push(`from=${encodeURIComponent(opts.from)}`);
    if (opts.to) qs.push(`to=${encodeURIComponent(opts.to)}`);
    return api.get<any>(`/reports/person-timeline${qs.length ? '?' + qs.join('&') : ''}`);
  },
  /** 工时排行：scope=week 本周 / month 本月 / cumulative 累计；可按项目/部门限定；all=true 强制公司全员口径 */
  hoursRanking: (opts: { scope?: 'week' | 'month' | 'cumulative'; projectId?: string; departmentId?: string; date?: string; all?: boolean } = {}) => {
    const qs: string[] = [];
    if (opts.scope) qs.push(`scope=${encodeURIComponent(opts.scope)}`);
    if (opts.projectId) qs.push(`projectId=${encodeURIComponent(opts.projectId)}`);
    if (opts.departmentId) qs.push(`departmentId=${encodeURIComponent(opts.departmentId)}`);
    if (opts.date) qs.push(`date=${encodeURIComponent(opts.date)}`);
    if (opts.all) qs.push('all=1');
    return api.get<any>(`/reports/hours-ranking${qs.length ? '?' + qs.join('&') : ''}`);
  },
  /** 日报数量排行：scope=week 本周 / 默认本月累计；all=true 强制公司全员口径（首页榜单用） */
  reportCountRanking: (opts: { scope?: 'week' | 'month'; all?: boolean; projectId?: string; departmentId?: string } = {}) => {
    const qs: string[] = [];
    if (opts.scope) qs.push(`scope=${encodeURIComponent(opts.scope)}`);
    if (opts.all) qs.push('all=1');
    if (opts.projectId) qs.push(`projectId=${encodeURIComponent(opts.projectId)}`);
    if (opts.departmentId) qs.push(`departmentId=${encodeURIComponent(opts.departmentId)}`);
    return api.get<any>(`/reports/report-count-ranking${qs.length ? '?' + qs.join('&') : ''}`);
  },
};

// ---------- 管理者 Agent 悬浮窗 ----------
export const agentApi = {
  /** 悬浮窗可见性：{ enabled 总闸, memberEnabled 员工档, visible 可见, tier manager|member|none }；所有登录用户可查 */
  getConfig: () => api.get<{ enabled: boolean; memberEnabled?: boolean; visible: boolean; tier?: string }>('/agent/config'),
  /** 开关保存（仅 ADMIN）：总闸 enabled / 员工档 memberEnabled，给了哪项存哪项 */
  saveConfig: (data: { enabled?: boolean; memberEnabled?: boolean }) => api.put<any>('/agent/config', data),
  /** 无状态对话：历史由前端携带；返回 { reply, action待确认计划?, toolTrace执行痕迹 } */
  chat: (messages: { role: string; content: string }[], pageContext?: { projectId?: string; projectName?: string; route?: string }) =>
    api.post<any>('/agent/chat', { messages, pageContext }),
  /** 催交周报（确认后执行；后端重扫缺交名单，只提醒仍缺交的人） */
  chaseWeekly: (data: { periodStart?: string; names?: string[] }) => api.post<any>('/agent/chase-weekly', data),
  /** 周报发群（确认后执行；把已存在的本周某归属周报原文再发一次到指定群，不修改记录） */
  weeklyToGroup: (data: { periodStart?: string; scopeKey?: string; groupIds?: string[] }) => api.post<any>('/agent/weekly-to-group', data),
  /** 任务下发（确认后执行；批量建任务并给被指派人推站内信+钉钉私聊） */
  createTasks: (data: { tasks: any[] }) => api.post<any>('/agent/tasks', data),
  /** 逾期催办发群（确认后执行；服务端重扫仍逾期的人后一次发到多个群） */
  chaseOverdue: (data: { groupIds: string[]; names?: string[] }) => api.post<any>('/agent/chase-overdue', data),
  /** 催今日日报（确认后执行；服务端重扫「今天排了班∧还没写」的人，分群点名+站内信） */
  chaseDaily: (data: { projectName?: string; groupIds?: string[]; personIds?: string[] }) => api.post<any>('/agent/chase-daily', data),
  /** 风险项目提醒（确认后执行；仅管理员/部门负责人，重扫后按负责人分组发站内信+对应项目群） */
  riskAlert: (data: { userIds?: string[]; includeAttention?: boolean }) => api.post<any>('/agent/risk-alert', data),
  /** 统一通知下发（确认后执行；一次发到多个群 + 通知多个人；groupContents 为分人分群的逐群差异化文案） */
  notify: (data: { content: string; groupIds?: string[]; personIds?: string[]; groupContents?: { conversationId: string; content: string }[] }) => api.post<any>('/agent/notify', data),
  /** 移动助手入口（/mobile）主动播报：待办明细 + 能力引导（服务端确定性拼文案） */
  mobileGreet: () => api.get<{ reply: string; tier: string; links: { label: string; to: string }[] }>('/agent/mobile-greet'),
  /** 首屏今日速览：待办/逾期、今日会议、今日日报、我的排名、今天是否排班（确定性拼数据，不走大模型） */
  overview: () =>
    api.get<{
      name: string;
      tier: string;
      bucket: 'org' | 'project' | 'member';
      date: string;
      todo: { count: number; overdue: number; hidden: number } | null;
      meetings: { count: number; items: { id: string; title: string; time: string; draft: boolean }[] };
      daily: { wrote: boolean; plannedToday: boolean; todayHours: number };
      ranking: { hoursRank: number | null; hoursTotal: number; myHours: number; reportRank: number | null; reportTotal: number; myReportCount: number; label: string };
      workSchedule: { totalSlots: number; todayLabel: string; todayRanges: string[] } | null;
    }>('/agent/overview'),
  /** 会话历史：列表（轻量，不含正文） */
  listSessions: () => api.get<{ sessions: { id: string; title: string; messageCount: number; updatedAt: string; createdAt: string }[] }>('/agent/sessions'),
  /** 读取单个会话正文 */
  getSession: (id: string) => api.get<{ id: string; title: string; messages: any[]; updatedAt: string }>(`/agent/sessions/${id}`),
  /** 保存/新建会话（传 id 则更新，不传则新建；返回服务端会话 id） */
  saveSession: (data: { id?: string; title?: string; messages: any[] }) => api.post<{ ok: boolean; id: string }>('/agent/sessions', data),
  /** 删除自己的会话 */
  deleteSession: (id: string) => api.del<any>(`/agent/sessions/${id}`),
};

// ---------- 使用体验反馈（首页提交、落库后同步公司群；后台按状态管理 + AI 总结） ----------
export const feedbackApi = {
  create: (content: string) => api.post<{ id: string; sent: boolean; group?: string; error?: string }>('/feedback', { content }),
  list: (status = 'ALL') => api.get<any[]>('/feedback', { status }),
  setStatus: (id: string, status: string) => api.patch<any>(`/feedback/${id}`, { status }),
  summarize: (ids: string[]) => api.post<{ ok: boolean; text?: string; count?: number; message?: string }>('/feedback/summarize', { ids }),
};

// ---------- 会议管理（事前-事中-事后闭环） ----------
/** 会议列表行（就绪度 = 会前材料已交/应交） */
export interface MeetingRow {
  id: string;
  title: string;
  scope: string;
  type: string;
  /** 重要性：HIGH 高 / MEDIUM 中 / LOW 低 */
  importance: string;
  status: string;
  startAt: string;
  endAt: string;
  agenda: string;
  location: string | null;
  ownerId: string;
  ownerName: string;
  departmentName: string | null;
  projectName: string | null;
  participantCount: number;
  materialReady: { total: number; submitted: number };
  itemCount: number;
  materialType: string | null;
  groupNotified: boolean;
  minutesReady: boolean;
  /** 已签到人数 */
  attendanceCount: number;
  myCheckedIn: boolean;
  myCheckinMethod: string | null;
  mine: boolean;
  canManage: boolean;
  /** 是否看得到完整内容（议题 / 材料 / 纪要 / 名单）；false 时上面的内容字段已被后端脱敏 */
  fullAccess: boolean;
  /** 无完整权限时的锁提示文案（「部门会议 · 仅 XX 成员可查看完整内容」） */
  lockReason: string | null;
}
/** 团队公告卡片的会议活动通知行（今天 ± 3 天，全员可见） */
export interface BoardMeeting {
  id: string;
  title: string;
  /** ACTIVITY 活动 / MEETING 会议（非活动的其余类型统一归会议） */
  kind: 'ACTIVITY' | 'MEETING';
  type: string;
  importance: string;
  status: string;
  startAt: string;
  endAt: string;
  location: string | null;
  ownerName: string;
  departmentName: string | null;
  attendanceCount: number;
  myCheckedIn: boolean;
  myCheckinMethod: string | null;
  myCheckedAt: string | null;
  /** 尚未开始（未来 3 天） */
  notStarted: boolean;
  /** 开始后 3 天内且本人未打：可打卡 */
  canCheckin: boolean;
  /** 完整内容权限：没有权限的人不给打卡，只显示基本信息 */
  fullAccess: boolean;
  lockReason: string | null;
  checkinDeadline: string | null;
  /** 详情页站内深链，公告条目与「复制链接」都用它 */
  link: string;
}
/** 发起表单预填（层级模板：名称/时间/参会人/材料要求/钉钉群） */
export interface MeetingTemplate {
  title: string;
  type: string;
  materialType: string;
  materialRequirement: string;
  groupConversationId: string | null;
  groupName: string | null;
  projectId?: string | null;
  deptId?: string | null;
  slotId?: string | null;
  weekday?: number | null;
  time?: string | null;
  durationMinutes: number;
  remindBeforeMinutes: number;
  participantIds: string[];
  autoPilot?: boolean;
  slots?: any[];
}
export const meetingsApi = {
  list: (params: { view?: string; scope?: string; status?: string; type?: string; kind?: string; keyword?: string }) =>
    api.get<MeetingRow[]>('/meetings', params),
  detail: (id: string) => api.get<any>(`/meetings/${id}`),
  template: (params: { scope: string; deptId?: string | null; projectId?: string | null }) =>
    api.get<MeetingTemplate>('/meetings/template', params),
  groupOptions: () => api.get<{ conversationId: string; groupName: string; projectNames: string[] }[]>('/meetings/group-options'),
  /** 关联群配置：{ canManageCompany, company:{conversationId,name}, departments:[{id,name,conversationId,groupName}] } */
  groupConfig: () => api.get<any>('/meetings/group-config'),
  saveCompanyGroup: (data: { conversationId?: string | null; name?: string | null }) => api.put<any>('/meetings/group-config/company', data),
  saveDeptGroup: (deptId: string, data: { conversationId?: string | null; name?: string | null }) => api.put<any>(`/meetings/group-config/department/${deptId}`, data),
  create: (data: any) => api.post<any>('/meetings', data),
  update: (id: string, data: any) => api.patch<any>(`/meetings/${id}`, data),
  publish: (id: string) => api.post<{ ok: boolean; autoPilot: boolean; notified: boolean }>(`/meetings/${id}/publish`),
  setStatus: (id: string, status: string) => api.post<{ ok: boolean; status: string }>(`/meetings/${id}/status?status=${status}`),
  saveMinutes: (id: string, minutes: string, send = false) => api.post<{ ok: boolean; queued: boolean }>(`/meetings/${id}/minutes`, { minutes, send }),
  /** 手动补发会议通知：dryRun=true 只返回预览正文与收件人，不真发 */
  notify: (id: string, kind: string, opts: { dryRun?: boolean; force?: boolean } = {}) =>
    api.post<any>(`/meetings/${id}/notify?kind=${kind}${opts.dryRun ? '&dryRun=true' : ''}${opts.force ? '&force=true' : ''}`, {}),
  cancel: (id: string, reason?: string) => api.post(`/meetings/${id}/cancel`, { reason }),
  remove: (id: string) => api.del(`/meetings/${id}`),
  /** 会前材料聚合直排视图：姓名 · 部门 · 正文 + 逐人点评（一次拉全部，不逐条点开） */
  materials: (id: string) => api.get<any>(`/meetings/${id}/materials`),
  /** 读取/重新读取参会人周报（仅主持人）；userIds 为空则处理全体 */
  readMaterials: (id: string, userIds: string[] = []) => api.post<any>(`/meetings/${id}/materials/read`, { userIds }),
  /** 提交/更新自己的会前文字材料 */
  submitMaterial: (id: string, content: string, userId?: string) =>
    api.post<any>(`/meetings/${id}/materials/submit`, { content, userId }),
  /** 会中修改某人材料正文（写 editedContent，原文保留） */
  editMaterial: (materialId: string, content: string) => api.patch<any>(`/meetings/materials/${materialId}`, { content }),
  /** 点评材料（独立留痕） */
  reviewMaterial: (materialId: string, content: string) => api.post<any>(`/meetings/materials/${materialId}/reviews`, { content }),
  deleteReview: (reviewId: string) => api.del(`/meetings/reviews/${reviewId}`),
  /** 团队公告卡片：今天 ± 3 天的会议活动 + 我的打卡状态（全员可见）；不跟实时看板的 board(id) 撞名 */
  announceBoard: () => api.get<BoardMeeting[]>('/meetings/announce-board'),
  /** 公告卡片打卡：开始后 3 天内全员可打，记为一次自主签到 */
  announceCheckin: (id: string) =>
    api.post<{ ok: boolean; already: boolean; method?: string; checkedAt?: string }>(`/meetings/${id}/board-checkin`, {}),
  /** 自主签到（会议开始 ~ 开始后 1 小时内） */
  checkin: (id: string) => api.post<{ ok: boolean; already: boolean; method?: string; checkedAt?: string }>(`/meetings/${id}/checkin`, {}),
  /** 补签/代签：发起人/管理员/本场助教/对方部门主管；reason 留空后端自动记「管理员矩阵补签」 */
  makeupCheckin: (id: string, userId: string, reason = '') =>
    api.post<any>(`/meetings/${id}/checkin/makeup`, { userId, reason }),
  /** 全员补签矩阵：全体在职成员的签到状态与可否补签 */
  makeupCandidates: (id: string) => api.get<any>(`/meetings/${id}/checkin/candidates`),
  /** 撤销考勤（仅发起人/管理员） */
  removeAttendance: (id: string, userId: string) => api.del(`/meetings/${id}/checkin/${userId}`),
  /** 会中表现点赞（理由可选） */
  praise: (id: string, userId: string, reason?: string) => api.post<{ ok: boolean; id: string }>(`/meetings/${id}/praise`, { userId, reason }),
  removePraise: (praiseId: string) => api.del(`/meetings/praises/${praiseId}`),
  /** 保存会议/活动文档的在线文字记录 */
  saveDoc: (id: string, text: string) => api.post<{ ok: boolean; docText: string; docUpdatedAt: string }>(`/meetings/${id}/doc`, { text }),
  /** 上传会议/活动文档附件（multipart） */
  uploadDocFile: (id: string, file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    return api.post<any>(`/meetings/${id}/files`, fd);
  },
  removeDocFile: (fileId: string) => api.del(`/meetings/files/${fileId}`),
  /** 我的活跃度与近期出勤 */
  statsMe: () => api.get<any>('/meetings/stats/me'),
  /** 全组织（或本部门）出勤与活跃度总览 */
  statsOverview: (params: { from?: string; to?: string; deptId?: string }) => api.get<any>('/meetings/stats/overview', params),
  /** 某人所有参加过的会议活动 */
  statsMember: (userId: string) => api.get<any>(`/meetings/stats/member/${userId}`),
  /** 取（或首次生成）对外开放链接：陌生人免登录看活动与得分、签到、答题加分 */
  publicLink: (id: string) => api.get<{ ok: boolean; token: string; path: string }>(`/meetings/${id}/public-link`),
  /** 任命 / 卸任助教（enable=false 为卸任）：助教可审核加分与管理活动 */
  setAssistant: (id: string, userId: string, enable = true) =>
    api.post<{ ok: boolean; assistantIds: string[] }>(`/meetings/${id}/assistants`, { userId, enable }),
  /** 设置答题加分（题目 + 标准答案 + 分值；都留空为关闭） */
  saveQuiz: (id: string, data: { question?: string; answer?: string; points?: number }) =>
    api.post<any>(`/meetings/${id}/quiz`, data),
  /** 设置 / 清除活动访问密码（password 留空即取消；设了后对外页需先输密码才能进） */
  setPublicPassword: (id: string, password: string) =>
    api.post<{ ok: boolean; protected: boolean }>(`/meetings/${id}/public-password`, { password }),
  /** 实时看板：签到情况 / 个人得分 / 各组得分 / 待审批明细 */
  board: (id: string) => api.get<any>(`/meetings/${id}/board`),
  /** 组织者或助教直接加分（内部成员或陌生签到人） */
  addScore: (id: string, data: { targetType: 'USER' | 'GUEST'; userId?: string; guestId?: string; points: number; reason?: string }) =>
    api.post<any>(`/meetings/${id}/scores`, data),
  /** 审批答题加分（approve=false 驳回） */
  reviewScore: (id: string, scoreId: string, approve: boolean) =>
    api.post<{ ok: boolean; status: string }>(`/meetings/${id}/scores/${scoreId}/review`, { approve }),
  /** 撤销一条加分 */
  removeScore: (id: string, scoreId: string) => api.del(`/meetings/${id}/scores/${scoreId}`),
  /** 建组（自己起组名、选组长，可拉上旁边的同事） */
  createGroup: (id: string, data: { name: string; leaderId?: string; memberIds?: string[] }) =>
    api.post<{ ok: boolean; id: string; name: string }>(`/meetings/${id}/groups`, data),
  /** 拖头像入组：把某个成员 / 来宾分进小组（groupId 留空则新建一组，可自带组名） */
  assignGroup: (
    id: string,
    data: { groupId?: string; name?: string; userId?: string; guestId?: string },
  ) => api.post<{ ok: boolean; groupId: string; name: string; memberName: string }>(`/meetings/${id}/groups/assign`, data),
  /** 加入小组 */
  joinGroup: (id: string, groupId: string) => api.post<any>(`/meetings/${id}/groups/${groupId}/join`, {}),
  /** 退出小组 */
  leaveGroup: (id: string, groupId: string) => api.del(`/meetings/${id}/groups/${groupId}/leave`),
  /** 把人移出小组（拖到「移出小组」区）：管理层可移任何人，本人可移自己 */
  leaveMember: (id: string, data: { userId?: string; guestId?: string }) =>
    api.post<{ ok: boolean; name: string; removed: boolean }>(`/meetings/${id}/groups/leave`, data),
  /** 改组名 / 选组长 / 摆会场座位（seatRow/seatCol，-1 为未摆放） */
  updateGroup: (id: string, groupId: string, data: { name?: string; leaderId?: string | null; seatRow?: number; seatCol?: number }) =>
    api.patch<any>(`/meetings/${id}/groups/${groupId}`, data),
  /** 解散小组 */
  removeGroup: (id: string, groupId: string) => api.del(`/meetings/${id}/groups/${groupId}`),
};

/**
 * 活动对外页（陌生人免登录，凭 publicToken 访问）：
 * 发起人设了访问密码时，先 access 探测 / unlock 换票，
 * 后续请求由拦截器自动附加 ?pwdTicket=（见 client.ts）。
 */
export const publicMeetingsApi = {
  /** 入口探测：是否需要密码 + 本机票据是否仍有效 */
  access: (token: string) =>
    api.get<{ needPassword: boolean; valid: boolean }>(`/public/meetings/${token}/access${getMeetingPwdTicket(token) ? '?pwdTicket=' + encodeURIComponent(getMeetingPwdTicket(token)) : ''}`),
  /** 输入访问密码换解锁票据（未设密码返回空头票）；成功后记住票据供拦截器附带 */
  unlock: async (token: string, password: string) => {
    const res = await api.post<{ ok: boolean; ticket: string }>(`/public/meetings/${token}/unlock`, { password });
    if (res.ticket) setMeetingPwdTicket(token, res.ticket);
    return res;
  },
  view: (token: string) => api.get<any>(`/public/meetings/${token}`),
  /** 扫码/填姓名手机号签到（性别二选一）；姓名 + 手机号与注册用户一致时 linked=true 并给出 userName */
  checkin: (token: string, data: { name: string; phone: string; gender?: string }) =>
    api.post<{
      ok: boolean;
      already: boolean;
      /** 信息与之前的签到记录重合，已并到原来那条上 */
      merged: boolean;
      guestId: string;
      name: string;
      gender: string | null;
      points: number;
      linked: boolean;
      userId: string | null;
      userName: string | null;
    }>(`/public/meetings/${token}/checkin`, data),
  quiz: (token: string, data: { phone: string; answer: string; reason?: string }) =>
    api.post<{ ok: boolean; id: string; name: string; points: number; status: string }>(`/public/meetings/${token}/quiz`, data),
  /** 签到信息填错了改一下：改对姓名手机号会重新匹配注册用户，性别也可以改 */
  updateCheckin: (token: string, data: { guestId: string; name: string; phone: string; gender?: string }) =>
    api.post<{
      ok: boolean;
      guestId: string;
      name: string;
      phone: string;
      gender: string | null;
      merged: boolean;
      points: number;
      linked: boolean;
      userId: string | null;
      userName: string | null;
    }>(`/public/meetings/${token}/checkin/update`, data),
  /** 扫码来宾自己拉小组：下面几个都用签到拿到的 guestId 认人，不需要登录 */
  createGroup: (token: string, guestId: string, name: string) =>
    api.post<{ ok: boolean; groupId: string; name: string }>(`/public/meetings/${token}/groups`, { guestId, name }),
  joinGroup: (token: string, guestId: string, groupId: string) =>
    api.post<{ ok: boolean; groupId: string; name: string }>(`/public/meetings/${token}/groups/${groupId}/join`, { guestId }),
  /** 拖自己的头像入组：groupId 为空时新建一个组（自己当组长） */
  assignGroup: (token: string, guestId: string, data: { groupId?: string; name?: string }) =>
    api.post<{ ok: boolean; groupId: string; name: string; memberName: string }>(`/public/meetings/${token}/groups/assign`, {
      guestId,
      ...data,
    }),
  leaveGroup: (token: string, guestId: string, groupId: string) =>
    api.post<{ ok: boolean; name: string }>(`/public/meetings/${token}/groups/${groupId}/leave`, { guestId }),
  /** 改组名 / 选组长 / 摆会场座位（组内成员才能改自己的组） */
  updateGroup: (
    token: string,
    guestId: string,
    groupId: string,
    data: { name?: string; leaderGuestId?: string | null; seatRow?: number; seatCol?: number },
  ) => api.patch<{ ok: boolean }>(`/public/meetings/${token}/groups/${groupId}`, { guestId, ...data }),
  removeGroup: (token: string, guestId: string, groupId: string) =>
    api.del<{ ok: boolean }>(`/public/meetings/${token}/groups/${groupId}?guestId=${encodeURIComponent(guestId)}`),
};

// ---------- PBC（个人业务承诺 / 月度计划，放在日报周报页） ----------
/** PBC 审批状态 */
export type PbcStatus = 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'REJECTED';
/** PBC 考核状态轴（与计划审批 status 独立） */
export type PbcReviewStatus = 'NOT_STARTED' | 'SELF_DONE' | 'LEADER_DONE';
/** 一条 PBC 事项：计划 content/score + 考核阶段逐条自评/上级字段（未评时为 null） */
export interface PbcItemType {
  content: string;
  score: number;
  selfScore?: number | null;
  selfReason?: string | null;
  leaderScore?: number | null;
  leaderComment?: string | null;
}
/** 提交自评/上级评分时逐条传入的评分项（按 items 下标对齐） */
export interface PbcScoreInput {
  index: number;
  selfScore?: number;
  selfReason?: string;
  leaderScore?: number;
  leaderComment?: string;
}
/** 成员 PBC 展示行（团队概览 / 部门互看共用） */
export interface PbcRow {
  userId: string;
  name: string;
  department: string | null;
  hasPbc: boolean;
  total: number;
  itemCount: number;
  items: PbcItemType[];
  status: PbcStatus;
  approverName: string | null;
  approvedAt: string | null;
  reviewComment: string | null;
  canApprove: boolean;
  isSelf: boolean;
  updatedAt: string | null;
  decomposedAt: string | null;
  /** 是否已确认创建过分解任务（列表「已分解/未分解」） */
  decomposed: boolean;
  // ---- 考核轴 ----
  reviewStatus: PbcReviewStatus;
  selfTotal: number | null;
  leaderTotal: number | null;
  selfSummary: string | null;
  leaderComment: string | null;
  pbcLeaderId: string | null;
  pbcLeaderName: string | null;
  /** 自评提交时间 / 上级复核定稿时间 */
  selfAt: string | null;
  leaderAt: string | null;
  canSelfReview: boolean;
  canLeaderReview: boolean;
}
/** PBC 分解出的一条任务（dueDate 为 'YYYY-MM-DD'；projectId 为该条任务选定的关联项目） */
export interface PbcTaskPreview {
  title: string;
  description: string;
  dueDate: string;
  projectId?: string;
}
/** PBC 任务分解结果（含可承接项目清单） */
export interface PbcDecomposeResult {
  month: string;
  memberName: string;
  items: { content: string; score: number }[];
  tasks: PbcTaskPreview[];
  projects: { id: string; name: string }[];
  defaultProjectId: string | null;
  degraded: boolean;
}
export const pbcApi = {
  /** 我某月 PBC：month='YYYY-MM'，无记录返回空计划；附带考核轴（reviewStatus、self/leader 各列、leaderOptions、canSelfReview 等） */
  get: (month: string) =>
    api.get<{
      month: string;
      items: PbcItemType[];
      total: number;
      status: PbcStatus;
      locked: boolean;
      approverName: string | null;
      approvedAt: string | null;
      reviewComment: string | null;
      reviewerName: string | null;
      updatedAt: string | null;
      reviewStatus: PbcReviewStatus;
      selfTotal: number | null;
      leaderTotal: number | null;
      selfSummary: string | null;
      leaderComment: string | null;
      selfAt: string | null;
      leaderAt: string | null;
      pbcLeaderId: string | null;
      pbcLeaderName: string | null;
      defaultLeaderId: string | null;
      leaderOptions: { id: string; name: string; label: string }[];
      canSelfReview: boolean;
      /** 是否可编辑自评（不限时间；仅定稿后为 false），等价于 canSelfReview，语义更明确 */
      selfReviewEditable: boolean;
      canLeaderReview: boolean;
      // ---- 时间窗口（计划=当月1~10号；自评窗口仅作「原定节奏」参考，不再阻断） ----
      planWindowOpen: boolean;
      planWindowHint: string;
      selfReviewWindowOpen: boolean;
      selfReviewWindow: string;
      /** 最近一次「撤销定稿」留痕（管理员打回时展示给本人） */
      lastRevoke: { at: string; byName: string; note: string | null } | null;
    }>('/pbc', { month }),
  /** 保存我某月 PBC（事项+分值，合计须=100） */
  save: (month: string, items: { content: string; score: number }[]) =>
    api.post<{ month: string; items: { content: string; score: number }[]; total: number; status: PbcStatus; locked: boolean }>('/pbc', { month, items }),
  /** 成员月度 PBC 概览（仅部门负责人/管理员）：本部门/全体启用成员及其 PBC */
  team: (month: string) => api.get<PbcRow[]>('/pbc/team', { month }),
  /** 部门内成员 PBC 互看（DepartmentView） */
  dept: (departmentId: string, month: string) => api.get<PbcRow[]>('/pbc/dept', { departmentId, month }),
  /** 审批通过某成员某月 PBC */
  approve: (userId: string, month: string) => api.post<{ userId: string; month: string; status: PbcStatus }>('/pbc/approve', { userId, month }),
  /** 允许修改（撤回审批） */
  revoke: (userId: string, month: string) => api.post<{ userId: string; month: string; status: PbcStatus }>('/pbc/revoke', { userId, month }),
  /** 退回修改：附修改意见退回成员本月 PBC，钉钉私聊通知成员 */
  reject: (userId: string, month: string, comment: string) => api.post<{ userId: string; month: string; status: PbcStatus }>('/pbc/reject', { userId, month, comment }),
  /** 催一下：钉钉私聊提醒成员尽快提交本月 PBC（供未写成员催办） */
  remind: (userId: string, month: string) => api.post<{ sent: boolean; to: string; error: string | null }>('/pbc/remind', { userId, month }),
  /** PBC 任务分解预览：发给 DeepSeek 拆为多条带建议截止日的任务 + 可承接项目清单 */
  decompose: (userId: string, month: string) => api.post<PbcDecomposeResult>('/pbc/decompose', { userId, month }),
  /** 确认创建：把分解任务建为项目任务（每条可各自指定关联项目 projectId），自动带负责人与截止时间 */
  createTasks: (userId: string, month: string, tasks: PbcTaskPreview[], projectId?: string) =>
    api.post<{ created: number; projects: { id: string; name: string }[]; tasks: { id: string; title: string }[] }>('/pbc/create-tasks', { userId, month, tasks, projectId }),
  /** 提交自评：本月已提交/已批计划的逐条自评分 + 整月总述 + 选定打分上级 */
  selfReview: (month: string, data: { items: PbcScoreInput[]; selfSummary?: string; pbcLeaderId?: string | null }) =>
    api.post<{ month: string; reviewStatus: PbcReviewStatus; selfTotal: number; pbcLeaderId: string | null; pbcLeaderName: string | null; items: PbcItemType[] }>('/pbc/self-review', { month, ...data }),
  /** 上级评分定稿：打分上级/管理员对已自评成员本月逐条评分 + 整月总评 */
  leaderReview: (userId: string, month: string, data: { items: PbcScoreInput[]; leaderComment?: string }) =>
    api.post<{ month: string; userId: string; reviewStatus: PbcReviewStatus; leaderTotal: number; leaderComment: string | null; items: PbcItemType[] }>('/pbc/leader-review', { userId, month, ...data }),
  /** 月度 PBC 排行（仅上级评分定稿、按 leaderTotal）：总排行 + 按部门排行 */
  ranking: (month: string) => api.get<PbcRankingResult>('/pbc/ranking', { month }),
  /** 有定稿评分的月份（降序），供排行榜默认「上个月」与月份下拉 */
  rankingMonths: () => api.get<string[]>('/pbc/ranking/months'),
  /** 待我审核清单：省略 month 返回所有有待处理的月份（补录会让老月份一起出现） */
  reviewQueue: (month?: string) =>
    api.get<{ months: string[]; pending: number; rows: (PbcRow & { month: string })[] }>(
      '/pbc/review-queue',
      month ? { month } : undefined,
    ),
  /** 撤销定稿（仅 ADMIN）：定稿退回「已自评·待复核」，保留分数，留痕并通知成员与上级 */
  revokeLeaderReview: (userId: string, month: string, note?: string) =>
    api.post<{ userId: string; month: string; reviewStatus: PbcReviewStatus }>('/pbc/leader-review/revoke', { userId, month, note }),
  /** 首页：上月（无定稿则最近有评分月）的全公司 PBC 排行（不分部门、全员可见） */
  latestRanking: () => api.get<{ month: string | null; overall: PbcRankEntry[] }>('/pbc/latest-ranking'),
};

/** 排行榜条目（仅上级评分定稿成员） */
export interface PbcRankEntry {
  rank: number;
  userId: string;
  name: string;
  department: string;
  leaderTotal: number;
  selfTotal: number | null;
}
/** /pbc/ranking 返回体 */
export interface PbcRankingResult {
  month: string;
  overall: PbcRankEntry[];
  byDepartment: { department: string; list: PbcRankEntry[] }[];
}

// ---------- 复盘 ----------
export const retrospectivesApi = {
  /** 我参与项目的全部复盘轮次（含进度/我的提交状态） */
  list: () => api.get<any[]>('/retrospectives'),
  /** 复盘详情（含成员列表与提交） */
  get: (id: string) => api.get<any>(`/retrospectives/${id}`),
  /** 新建复盘轮次（项目负责人/管理员）：{projectId, kind, title?, deadline?} */
  create: (data: { projectId: string; kind: 'STRUCTURED' | 'GENERAL'; title?: string; deadline?: string | null }) =>
    api.post('/retrospectives', data),
  /** 修改复盘（负责人/管理员）：标题/截止日/状态 */
  update: (id: string, data: { title?: string; deadline?: string | null; status?: string }) =>
    api.put(`/retrospectives/${id}`, data),
  /** 成员提交/覆盖提交：结构化 {answers:{q1..q5}}；一般 {content?, attachment?} */
  submit: (
    id: string,
    data: {
      answers?: Record<string, string>;
      content?: string;
      attachment?: { name?: string; key?: string };
    },
  ) => api.put(`/retrospectives/${id}/submission`, data),
  /** AI 汇总（负责人/管理员） */
  summarize: (id: string) => api.post(`/retrospectives/${id}/summarize`),
};

// ---------- SOP 经验库 ----------
export const sopsApi = {
  /** 列表：?status=&tag=&keyword= → {items, allTags} */
  list: (params?: { status?: string; tag?: string; keyword?: string }) =>
    api.get<{ items: any[]; allTags: { name: string; count: number }[] }>('/sops', params),
  /** 人工新增（负责人/管理员，新增即生效） */
  create: (data: { title: string; content: string; tags?: string[]; projectId?: string }) =>
    api.post('/sops', data),
  /** 从复盘汇总 AI 提取候选（负责人/管理员） */
  extract: (retroId: string) => api.post<any[]>('/sops/extract', { retroId }),
  /** 从团队记录（群聊/日报/周报）AI 提取候选（管理员/负责人；days 默认 30，最长 92） */
  extractTeam: (data: { days?: number; projectId?: string }) =>
    api.post<{ created: any[]; skipped: number; note?: string; sources?: { messages: number; reports: number } }>('/sops/extract-team', data),
  /** 确认/拒绝/编辑/打标签 */
  patch: (id: string, data: { status?: string; title?: string; content?: string; tags?: string[]; addTags?: string[] }) =>
    api.patch(`/sops/${id}`, data),
  remove: (id: string) => api.del(`/sops/${id}`),
};

// ---------- 文件上传（MinIO；返回 attachment：fileKey/fileName/url） ----------
export const filesApi = {
  /** 上传附件；opts 可把文件挂到任务/文档/会议（后端建 Attachment 元数据行） */
  upload: (file: File, opts?: { taskId?: string; docId?: string; meetingId?: string }) => {
    const fd = new FormData();
    fd.append('file', file);
    const qs = new URLSearchParams();
    if (opts?.taskId) qs.set('taskId', opts.taskId);
    if (opts?.docId) qs.set('docId', opts.docId);
    if (opts?.meetingId) qs.set('meetingId', opts.meetingId);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return api.post<any>(`/files/upload${suffix}`, fd);
  },
  /** 预签名下载链接（GET 有效期几分钟），用于附件下载 */
  presign: (key: string) => api.get<{ url: string }>('/files/presign', { key }),
};

// ---------- 文档空间（部门/项目的二进制文件：文件夹、上传、版本、审批、docx 在线编辑） ----------
export type DocSpaceScope = 'department' | 'project';
export type DocConflictPolicy = 'version' | 'overwrite' | 'rename';

export const documentsApi = {
  /** 空间列表：当前文件夹下的子文件夹与文件（keyword 有值时为全空间搜索） */
  space: (params: { scope: DocSpaceScope; targetId: string; folderId?: string | null; keyword?: string }) =>
    api.get<any>('/documents/space', {
      scope: params.scope,
      targetId: params.targetId,
      folderId: params.folderId || undefined,
      keyword: params.keyword || undefined,
    }),
  breadcrumb: (folderId: string) => api.get<{ id: string; name: string }[]>(`/documents/breadcrumb/${folderId}`),
  /** 上传前重名探测：{ exists, file } */
  conflict: (params: { scope: DocSpaceScope; targetId: string; name: string; folderId?: string | null }) =>
    api.get<{ exists: boolean; file?: any }>('/documents/conflict', {
      scope: params.scope,
      targetId: params.targetId,
      name: params.name,
      folderId: params.folderId || undefined,
    }),
  createFolder: (data: { scope: DocSpaceScope; targetId: string; name: string; parentId?: string | null }) =>
    api.post<any>('/documents/folders', data),
  renameFolder: (id: string, name: string) => api.patch<any>(`/documents/folders/${id}`, { name }),
  deleteFolder: (id: string) => api.del(`/documents/folders/${id}`),
  /** 上传（multipart，落盘暂存；大文件不设超时，onProgress 回传百分比） */
  upload: (
    file: File,
    data: {
      scope: DocSpaceScope;
      targetId: string;
      folderId?: string | null;
      visibility?: string;
      externalPassword?: string;
      externalValidDays?: number;
      note?: string;
      conflict?: DocConflictPolicy;
    },
    onProgress?: (percent: number) => void,
  ) => {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('scope', data.scope);
    fd.append('targetId', data.targetId);
    if (data.folderId) fd.append('folderId', data.folderId);
    if (data.visibility) fd.append('visibility', data.visibility);
    if (data.externalPassword) fd.append('externalPassword', data.externalPassword);
    if (data.externalValidDays != null) fd.append('externalValidDays', String(data.externalValidDays));
    if (data.note) fd.append('note', data.note);
    if (data.conflict) fd.append('conflict', data.conflict);
    return http.post<any, any>('/documents/upload', fd, {
      timeout: 0,
      onUploadProgress: (e) => {
        if (onProgress && e.total) onProgress(Math.min(99, Math.round((e.loaded * 100) / e.total)));
      },
    });
  },
  /** 文件内容（走 API 流式代理，MinIO 浏览器侧不可达）：version 取历史版本快照 */
  content: (id: string, opts?: { version?: number; inline?: boolean }) =>
    http.get<Blob, Blob>(`/documents/files/${id}/content`, {
      params: { version: opts?.version, inline: opts?.inline ? 1 : undefined },
      responseType: 'blob',
      timeout: 0,
    }),
  /** docx 在线编辑：读取为 HTML（仅 .docx、≤20MB） */
  editable: (id: string) => api.get<{ file: any; canEdit: boolean; html: string; warnings: any[] }>(`/documents/files/${id}/editable`),
  /** 保存在线编辑：重新生成 docx 并归档为新版本 */
  saveEditable: (id: string, html: string, note?: string) =>
    api.patch<any>(`/documents/files/${id}/content`, { html, note }),
  patchFile: (
    id: string,
    data: { name?: string; note?: string | null; visibility?: string; externalPassword?: string; externalValidDays?: number | null; folderId?: string | null },
  ) => api.patch<any>(`/documents/files/${id}`, data),
  removeFile: (id: string) => api.del(`/documents/files/${id}`),
  versions: (id: string) => api.get<{ current: number; canManage: boolean; versions: any[] }>(`/documents/files/${id}/versions`),
  removeVersion: (id: string, version: number) => api.del(`/documents/files/${id}/versions/${version}`),
  /** 管理员：待审批（默认）与已通过/已驳回列表 */
  approvals: (status?: string) => api.get<{ pending: number; files: any[] }>('/documents/approvals', status ? { status } : undefined),
  review: (id: string, decision: 'APPROVE' | 'REJECT', note?: string) =>
    api.post<any>(`/documents/approvals/${id}/review`, { decision, ...(note ? { note } : {}) }),
};

// ---------- 对外部可见文档分享页（游客免登录） ----------
export const publicApi = {
  /** 分享页头部：{ id, name, externalCount } */
  project: (projectId: string) => http.get<any, any>(`/public/projects/${projectId}`),
  /** 校验密码，返回密码匹配的对外可见文件：{ total, files } */
  docs: (projectId: string, password: string) =>
    http.post<any, any>(`/public/projects/${projectId}/docs`, { password }),
  /** 全局访客入口（登录页）：只输密码，跨所有项目匹配对外可见文件：{ total, files } */
  searchDocs: (password: string) => http.post<any, any>('/public/docs', { password }),
  /** 游客下载（密码随 query 带上，服务端二次校验） */
  content: (fileId: string, password: string, opts?: { inline?: boolean }) =>
    http.get<Blob, Blob>(`/public/documents/files/${fileId}/content`, {
      params: { password, inline: opts?.inline ? 1 : undefined },
      responseType: 'blob',
      timeout: 0,
    }),
};

// ---------- 知识库 ----------
export const knowledgeApi = {
  categories: () => api.get<any[]>('/knowledge/categories'),
  createCategory: (data: any) => api.post('/knowledge/categories', data),
  deleteCategory: (id: string) => api.del(`/knowledge/categories/${id}`),
  list: (params?: any) => api.get<any[]>('/knowledge', params),
  get: (id: string) => api.get(`/knowledge/${id}`),
  create: (data: any) => api.post('/knowledge', data),
  update: (id: string, data: any) => api.patch(`/knowledge/${id}`, data),
  remove: (id: string) => api.del(`/knowledge/${id}`),
  versions: (id: string) => api.get<any[]>(`/knowledge/${id}/versions`),
  version: (id: string, version: number) => api.get(`/knowledge/${id}/versions/${version}`),
};

// ---------- 资源预约 ----------
export const resourcesApi = {
  list: () => api.get<any[]>('/resources'),
  create: (data: any) => api.post('/resources', data),
  update: (id: string, data: any) => api.patch(`/resources/${id}`, data),
  remove: (id: string) => api.del(`/resources/${id}`),
  bookings: (params?: any) => api.get<any[]>('/resources/bookings', params),
  book: (data: any) => api.post('/resources/bookings', data),
  bookingStatus: (id: string, status: string, cancelReason?: string) =>
    api.patch(`/resources/bookings/${id}/status`, {
      status,
      ...(cancelReason ? { cancelReason } : {}),
    }),
  cancelBooking: (id: string) => api.patch(`/resources/bookings/${id}/cancel`),
};

// ---------- 项目资源盘点（人人可录入；非管理员仅见/改自己上传的，管理员看全部） ----------
export const inventoryApi = {
  // 项目盘点条目
  list: () => api.get<any[]>('/inventory'),
  create: (data: any) => api.post('/inventory', data),
  update: (id: string, data: any) => api.patch(`/inventory/${id}`, data),
  remove: (id: string) => api.del(`/inventory/${id}`),
  pickableProjects: () => api.get<any[]>('/inventory/pickable-projects'),
  // 服务器台账
  servers: () => api.get<any[]>('/inventory/servers'),
  createServer: (data: any) => api.post('/inventory/servers', data),
  updateServer: (id: string, data: any) => api.patch(`/inventory/servers/${id}`, data),
  removeServer: (id: string) => api.del(`/inventory/servers/${id}`),
  // 域名台账
  domains: () => api.get<any[]>('/inventory/domains'),
  createDomain: (data: any) => api.post('/inventory/domains', data),
  updateDomain: (id: string, data: any) => api.patch(`/inventory/domains/${id}`, data),
  removeDomain: (id: string) => api.del(`/inventory/domains/${id}`),
  setDomainServers: (id: string, serverIds: string[]) =>
    api.put(`/inventory/domains/${id}/servers`, { serverIds }),
};

// ---------- 资讯 ----------
export const newsApi = {
  sources: () => api.get<any[]>('/news/sources'),
  createSource: (data: any) => api.post('/news/sources', data),
  updateSource: (id: string, data: any) => api.patch(`/news/sources/${id}`, data),
  removeSource: (id: string) => api.del(`/news/sources/${id}`),
  fetchNow: (id: string) => api.post(`/news/sources/${id}/fetch`),
  subscribe: (id: string) => api.post(`/news/sources/${id}/subscribe`),
  unsubscribe: (id: string) => api.del(`/news/sources/${id}/subscribe`),
  /** 资讯条目列表：?keyword=&tag=&sourceId=&limit= → {items, allTags} */
  items: (params?: any) => api.get<{ items: any[]; allTags: string[] }>('/news', params),
  item: (id: string) => api.get(`/news/${id}`),
  /** AI 精选 feed：?view=all|project:<projectId>|interest&limit= → {view, filteredBy, items} */
  feed: (params?: { view?: string; limit?: number }) =>
    api.get<any>('/news/feed', params),
  /** 项目展示规则（负责人可写，成员可读） */
  projectRule: (projectId: string) => api.get<any>(`/news/rule/project/${projectId}`),
  saveProjectRule: (projectId: string, guideText: string) =>
    api.put(`/news/rule/project/${projectId}`, { guideText }),
  /** 个人资讯兴趣 */
  myInterest: () => api.get<any>('/news/rule/me'),
  saveMyInterest: (interestText: string) => api.put('/news/rule/me', { interestText }),
};

// ---------- 通知 ----------
export const notificationsApi = {
  list: () => api.get<any[]>('/notifications'),
  unreadCount: () => api.get<number>('/notifications/unread-count'),
  read: (id: string) => api.patch(`/notifications/${id}/read`),
  readAll: () => api.patch('/notifications/read-all'),
};

// ---------- 集成（钉钉） ----------
export const integrationsApi = {
  status: () => api.get<any>('/integrations/status'),
  messages: (params?: any) => api.get<any[]>('/integrations/messages', params),
  messageStats: (params?: any) => api.get<any>('/integrations/messages/stats', params),
  fetchRecent: (projectId?: string) =>
    api.post<any>('/integrations/dingtalk/fetch', projectId ? { projectId } : {}),
  testPush: (data: any) => api.post('/integrations/dingtalk/test-push', data),
  /** 每日总结推送时间（管理员）：{ time: 'HH:mm', source: 'db'|'env', cron, next } */
  digestSchedule: () => api.get<any>('/integrations/digest/schedule'),
  /** 修改每日总结推送时间（管理员；HH:mm 北京时间，保存后立即生效） */
  saveDigestSchedule: (time: string) => api.put<any>('/integrations/digest/schedule', { time }),
  /** 手动发送 AI 调用日志文件（管理员；默认前一天，不受「每天自动发送」开关限制） */
  sendAiLog: (data?: { date?: string; dryRun?: boolean }) =>
    api.post<any>('/integrations/dingtalk/ai-log', data ?? {}),
  /** AI 日志「每天自动发送」设置（管理员）：{ enabled, source: 'db'|'env', cron, next } */
  aiLogSettings: () => api.get<any>('/integrations/ai-log/settings'),
  /** 修改 AI 日志「每天自动发送」开关（管理员；保存后立即生效） */
  saveAiLogEnabled: (enabled: boolean) => api.put<any>('/integrations/ai-log/settings', { enabled }),
  /** 手动触发日报未写提醒（管理员；dryRun 预览 / force 绕过提醒时点） */
  runReportReminder: (data?: { dryRun?: boolean; force?: boolean }) =>
    api.post<any>('/integrations/report-reminder/run', data ?? {}),
  /** 每周工时排名设置（管理员）：{ enabled, time, cron, groups[], next } */
  workRankSettings: () => api.get<any>('/integrations/work-rank/settings'),
  /** 修改每周工时排名设置（管理员；开关/时间/发送群，传哪项改哪项，保存后立即生效） */
  saveWorkRankSettings: (data: { enabled?: boolean; time?: string; groupIds?: string[] }) =>
    api.put<any>('/integrations/work-rank/settings', data),
  /** 工时排名预览（管理员；不发群，返回榜单与正文） */
  workRankPreview: (periodStart?: string) =>
    api.get<any>('/integrations/work-rank/preview', periodStart ? { periodStart } : undefined),
  /** 立即发送工时排名到后台勾选的群（管理员） */
  publishWorkRank: (data?: { periodStart?: string; groupIds?: string[] }) =>
    api.post<any>('/integrations/work-rank/publish', data ?? {}),
  /** 每日小组小结设置（管理员）：{ enabled, time, cron, next } */
  dailySummarySettings: () => api.get<any>('/integrations/daily-summary/settings'),
  /** 修改每日小组小结设置（管理员；开关/时间，传哪项改哪项，保存后立即生效） */
  saveDailySummarySettings: (data: { enabled?: boolean; time?: string }) =>
    api.put<any>('/integrations/daily-summary/settings', data),
  /** 每日小组小结预览（管理员；不发群，逐项目返回当日小结正文） */
  dailySummaryPreview: () => api.get<any>('/integrations/daily-summary/preview'),
  /** 立即发送每日小组小结到各项目绑定群（管理员） */
  publishDailySummary: () => api.post<any>('/integrations/daily-summary/publish', {}),
};

// ---------- 大模型调用记录（管理员） ----------
export const aiCallsApi = {
  /** 某天（北京时间，默认今天）全部调用概览：{ date, total, items } */
  list: (date?: string) => api.get<any>('/ai-calls', date ? { date } : undefined),
  /** 单条调用详情（含完整提示词与大模型返回结果） */
  detail: (id: string) => api.get<any>(`/ai-calls/${id}`),
};
