import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';
import { PrismaService } from '../../common/prisma.service';
import { AiService } from '../ai/ai.service';
import { ReportsService, normalizeHours } from '../reports/reports.service';
import { WorkScheduleService } from '../reports/work-schedule.service';
import { WORK_SLOT_PRESETS, WORK_WEEKDAY_LABELS, slotRangeLabel, slotsHours, weekdayLabel } from '../../common/work-slots';
import { ProjectsService } from '../projects/projects.service';
import { NotificationsService } from '../notifications/notifications.service';
import { TasksService } from '../tasks/tasks.service';
import { KnowledgeService } from '../knowledge/knowledge.service';
import { SopsService } from '../sops/sops.service';
import { DingtalkDmService } from '../integrations/dingtalk-dm.service';
import { DingtalkFetchService } from '../integrations/dingtalk-fetch.service';
import { CurrentUserPayload } from '../../common/current-user.decorator';
import { beijingMondayDate, beijingMondayOf, fmtBeijing, fmtBeijingDate } from '../../common/beijing-time';
import { deptOfProjectAuthority, ledDeptWhere } from '../../common/dept-authority';
import { dailyBodyOf } from '../../common/daily-body';
import { webLink } from '../../common/web-link';

/** Setting 表总闸 key（管理后台开关；缺省=关闭） */
export const AGENT_ENABLED_KEY = 'manager.agent.enabled';
/** 员工档开关 key（管理后台；Setting 里没有这条时按「开」处理，管理员可一键关掉） */
export const AGENT_MEMBER_ENABLED_KEY = 'manager.agent.member.enabled';

/** 可使用管理者档的角色（总闸是第一道，角色是第二道） */
const MANAGER_ROLES = new Set(['ADMIN', 'DEPT_LEADER', 'PROJECT_LEADER']);

/** 公司群固定名（用户口径：「发到公司群」就是这一个；仅管理员/部门负责人可用，项目负责人只发自己项目群） */
export const COMPANY_GROUP_NAME = '杭州红蛛科技有限公司';

/**
 * 员工档可用的只读工具：只查自己 + 查全员可见的沉淀（知识库/SOP 走各自模块的可见性口径）
 * 任何「看别人进度」的工具都不放开，避免放开入口等于放开数据
 * list_meetings 对非管理员已按 owner/参会/材料上传人自收敛，成员用它只能查到「自己的会议」，安全
 * my_ranking/my_work_schedule 只回「我是第几名 / 共几人」与自己的排班，不含任何他人姓名与数值
 */
const MEMBER_TOOLS = new Set([
  'my_tasks',
  'my_today',
  'search_knowledge',
  'search_sop',
  'list_meetings',
  'my_ranking',
  'my_work_schedule',
  // 项目 AI 员工三件套：只在项目页上下文里可用，数据严格按项目收敛（文件/在线文档/成员日报），成员档也放行
  'project_files',
  'read_project_doc',
  'project_reports',
]);
/** 员工档可用的动作：只能改自己的任务/交自己的日报周报/安排自己的工作时间；会议、催办、下发、广播一律不给 */
const MEMBER_ACTIONS = new Set(['TASK_PATCH', 'DAILY_SUBMIT', 'WEEKLY_SUBMIT', 'WORK_SCHEDULE_SET']);

/** 允许的动作类型：后端只生成计划，执行由前端确认后调现有接口或 /agent 执行路由（建任务/催逾期/广播通知均走后者，需叠加通知副作用） */
const ACTION_KINDS = new Set([
  'MEETING_CREATE',
  'MEETING_PUBLISH',
  'MEETING_NOTIFY',
  'WEEKLY_SEND_GROUP',
  'WEEKLY_CHASE',
  'TASK_CREATE',
  'TASK_PATCH',
  'OVERDUE_CHASE',
  'NOTIFY_BROADCAST',
  'DAILY_SUBMIT',
  'WEEKLY_SUBMIT',
  'WORK_SCHEDULE_SET',
  'DAILY_CHASE',
  'RISK_ALERT',
]);

/** 任务状态中文（确认卡要显示「从什么改成什么」，不能让用户自己翻译枚举值） */
const STATUS_CN: Record<string, string> = { TODO: '未开始', IN_PROGRESS: '进行中', DONE: '已完成' };

/** 模型可见的对话轮次上限（超出截断：保留最近 16 条） */
const MAX_HISTORY = 16;
/** 对话循环最多执行几轮工具 */
const MAX_TOOL_ROUNDS = 5;

const truncate = (s: string, n = 120) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

/** 归一化名称：去空白/常见标点，用于项目名/人名/群名的模糊匹配 */
function normName(s: unknown): string {
  return String(s ?? '')
    .trim()
    .replace(/[\s（）()【】\[\]「」]/g, '');
}

@Injectable()
export class AgentService {
  private readonly logger = new Logger(AgentService.name);

  constructor(
    private prisma: PrismaService,
    private ai: AiService,
    private reports: ReportsService,
    private projects: ProjectsService,
    private notifications: NotificationsService,
    private tasks: TasksService,
    private knowledge: KnowledgeService,
    private sops: SopsService,
    private dm: DingtalkDmService,
    private dingtalkFetch: DingtalkFetchService,
    private workSchedule: WorkScheduleService,
  ) {}

  // ---- 开关与可见性 ----

  async isEnabled(): Promise<boolean> {
    const row = await this.prisma.setting.findUnique({ where: { key: AGENT_ENABLED_KEY } });
    return (row?.value as { enabled?: unknown } | undefined)?.enabled === true;
  }

  /** 员工档：没配过 Setting 按「开」处理（产品决定：普通员工也能问自己的进度） */
  async isMemberEnabled(): Promise<boolean> {
    const row = await this.prisma.setting.findUnique({ where: { key: AGENT_MEMBER_ENABLED_KEY } });
    if (!row) return true;
    return (row?.value as { enabled?: unknown } | undefined)?.enabled !== false;
  }

  /**
   * visible = 总闸开 ∧（管理者 ∨ 员工档开）
   * tier：manager=全能力；member=只查自己 + 沉淀检索 + 自己的日报/待办；none=不可见
   * 前端渲染与 /agent/* 全部共用这一个口径，不允许前端自己判角色
   */
  async config(me: CurrentUserPayload) {
    const [enabled, memberEnabled] = await Promise.all([this.isEnabled(), this.isMemberEnabled()]);
    const manager = MANAGER_ROLES.has(me.role);
    const tier = manager ? 'manager' : memberEnabled ? 'member' : 'none';
    // 引导词分档：管理员/部门负责人=全站视角，项目负责人=本项目视角，其余=员工视角
    const bucket =
      me.role === 'ADMIN' || me.role === 'DEPT_LEADER' ? 'org' : me.role === 'PROJECT_LEADER' ? 'project' : 'member';
    return { enabled, memberEnabled, manager, tier, bucket, visible: enabled && tier !== 'none' };
  }

  async saveEnabled(enabled: boolean) {
    await this.prisma.setting.upsert({
      where: { key: AGENT_ENABLED_KEY },
      create: { key: AGENT_ENABLED_KEY, value: { enabled } } as any,
      update: { value: { enabled } } as any,
    });
    return { ok: true, enabled };
  }

  async saveMemberEnabled(enabled: boolean) {
    await this.prisma.setting.upsert({
      where: { key: AGENT_MEMBER_ENABLED_KEY },
      create: { key: AGENT_MEMBER_ENABLED_KEY, value: { enabled } } as any,
      update: { value: { enabled } } as any,
    });
    return { ok: true, memberEnabled: enabled };
  }

  /** 可见即可用；返回档位供工具/动作白名单收口 */
  private async assertVisible(me: CurrentUserPayload): Promise<string> {
    const cfg = await this.config(me);
    if (!cfg.visible) throw new ForbiddenException('小助手未开启（后台总闸或员工档已关闭）');
    return cfg.tier;
  }

  /**
   * 带副作用的执行路由（催办/下发/发群/广播）必须管理者档
   * —— 放开员工档只是放开「问」，绝不等于放开「对外发言」；前端不给按钮不算防住
   */
  private async assertManager(me: CurrentUserPayload) {
    const tier = await this.assertVisible(me);
    if (tier !== 'manager') throw new ForbiddenException('该操作只对项目/部门负责人开放');
  }

  // ---- 对话主循环 ----

  async chat(
    me: CurrentUserPayload,
    body: {
      messages?: { role?: string; content?: string }[];
      pageContext?: { projectId?: string; projectName?: string; route?: string };
    },
  ) {
    const tier = await this.assertVisible(me);
    if (!this.ai.enabled) return { reply: '大模型尚未配置（AI_API_KEY），暂时无法使用对话助手。', action: null, toolTrace: [], links: [] };

    // 规整历史：只保留 user/assistant 文本，截最近 MAX_HISTORY 条
    const flat = (body.messages ?? [])
      .filter((m) => (m.role === 'user' || m.role === 'assistant') && String(m.content ?? '').trim())
      .slice(-MAX_HISTORY)
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: String(m.content).slice(0, 3000) }));
    if (!flat.length || flat[flat.length - 1].role !== 'user') {
      throw new BadRequestException('请以一条用户消息结束对话');
    }

    const scope: any = await this.buildScope(me, tier);
    // 项目 AI 员工：当前页面带项目 id 时校验可见性并挂到 scope，供档案注入与项目工具缺省定位
    if (body.pageContext?.projectId) {
      const pj = await this.prisma.project.findFirst({
        where: { id: body.pageContext.projectId, deletedAt: null },
        select: { id: true, name: true, confidential: true },
      });
      if (pj && (await this.canSeeProject(me, pj))) scope.pageProject = pj;
    }
    const toolTrace: { tool: string; args: any }[] = [];
    const resultCache = new Map<string, string>();
    // 工具结果里夹带的 links 是给前端渲染的可点跳转：不进入模型上下文（省 token，也避免模型把内部 id 写进回答）
    const links: { label: string; to: string }[] = [];
    const linkSeen = new Set<string>();
    const archivedNames = scope.projects.filter((p: any) => p.archived).map((p: any) => p.name);
    // 附加上下文块：随每轮 prompt 的 contextNote 变量注入（会话级不变）
    const ctxBlock = [
      `【当前时间（北京）】${fmtBeijing(new Date())}（今天=${beijingMondayDate(new Date()).slice(0, 10)} 所在周为本周）`,
      `【我】${me.name}（角色 ${me.role}${me.departmentId ? `，部门id ${me.departmentId}` : ''}）`,
      // 归档≠删除：历史进展/任务仍在库里，单独列出来让模型知道“老项目也能查”
      `【我的可见项目】${
        JSON.stringify(scope.projects.filter((p: any) => !p.archived).map((p: any) => p.name))
      }${archivedNames.length ? `；已归档项目（一样可查，回答时请标注「已归档」）=${JSON.stringify(archivedNames)}` : ''}`,
      tier === 'member'
        ? `【你的能力范围（普通成员档）】只能用这些只读工具：${JSON.stringify([...MEMBER_TOOLS])}；只能发起这些动作：${JSON.stringify(
            [...MEMBER_ACTIONS],
          )}。其余（看别人的进度/日报周报情况、催办、下发任务给别人、发起或发布会议、发群通知）一律不开放，用户提及时直接说明没有权限并建议他找负责人，不要承诺自己能做。你只能用 list_meetings 查自己参与的会议，不能替别人发起会议。公司排名与工时情况只看自己的：my_ranking 只返回你自己的名次与总人数（看不到别人的名单），my_work_schedule/WORK_SCHEDULE_SET 也只管你自己。`
        : '',
      body.pageContext?.projectId || body.pageContext?.projectName
        ? `【当前页面项目】${body.pageContext.projectName ?? ''}（id=${body.pageContext.projectId ?? '未提供'}）——用户说「这个项目」时指它`
        : '',
      // 项目 AI 员工：档案块（信息/任务/文件/在线文档/今日日报），每轮 prompt 随 contextNote 注入
      scope.pageProject ? await this.buildProjectDossier(me, scope.pageProject) : '',
      `【动作目标备选清单】人名=${JSON.stringify(scope.members.map((m: any) => m.name))}；群名=${JSON.stringify(
        scope.groups.map((g: any) => g.groupName),
      )}${
        scope.groups.some((g: any) => g.isCompany)
          ? `（其中「${COMPANY_GROUP_NAME}」是公司群：用户说“发公司群/公司大群/大群/全员群”就选它；其余群为项目群）`
          : '（当前未解析到公司群，只能发项目群）'
      }；我的未发布/待召开会议=${JSON.stringify(scope.meetings)}`,
    ]
      .filter(Boolean)
      .join('\n');

    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const extraMessages = [...flat];
      if (toolTrace.length) {
        // 把本轮工具结果回填进对话：assistant 声明去查、user 给出结果 JSON
        extraMessages.push({ role: 'assistant', content: `（正在执行工具 ${toolTrace[toolTrace.length - 1].tool}）` });
        extraMessages.push({ role: 'user', content: `工具结果：${resultCache.get(this.traceKey(toolTrace[toolTrace.length - 1])) ?? '{}'}` });
      }
      const out = await this.ai.generateJson<{
        thought?: string;
        tool?: string;
        args?: any;
        reply?: string;
        action?: any;
      }>(
        'manager.agent',
        { contextNote: ctxBlock },
        { extraMessages, temperature: 0.2 },
      );
      if (!out) return { reply: '模型暂时没有返回内容，请稍后重试，或者换个问法。', action: null, toolTrace, links };

      const toolName = String(out.tool ?? '').trim();
      if (toolName && round < MAX_TOOL_ROUNDS) {
        const args = out.args ?? {};
        const key = this.traceKey({ tool: toolName, args });
        let result = resultCache.get(key);
        if (!result) {
          const raw = await this.runTool(me, scope, toolName, args, tier);
          const ro = raw && typeof raw === 'object' && !Array.isArray(raw) ? ({ ...(raw as any) } as any) : { data: raw };
          if (Array.isArray(ro.links)) {
            for (const l of ro.links) {
              const to = String((l as any)?.to ?? '');
              if (!to || linkSeen.has(to)) continue;
              linkSeen.add(to);
              links.push({ label: String((l as any)?.label ?? '查看'), to });
            }
            delete ro.links;
          }
          result = JSON.stringify(ro);
          resultCache.set(key, result);
          toolTrace.push({ tool: toolName, args });
        }
        continue;
      }

      const reply = String(out.reply ?? '').trim() || '（模型未给出答复，请补充更多信息后重试）';
      const action = out.action ? await this.buildAction(me, scope, out.action, tier) : null;
      if (out.action && !action) {
        // 动作参数解析失败：降级为文字提示，让模型下一轮向用户追问
        return { reply: `${reply}\n\n（我尝试生成的操作计划信息不完整或无权限，已暂停，请补充或修正后重试）`, action: null, toolTrace, links };
      }
      return { reply, action, toolTrace, links };
    }
    return { reply: '这轮查询步骤太多，我先停一下；请把问题拆细一点再问我。', action: null, toolTrace, links };
  }

  private traceKey(t: { tool: string; args: any }) {
    return `${t.tool}:${JSON.stringify(t.args ?? {})}`;
  }

  // ---- 可见范围（模型只见名称；id 一律后端解析） ----

  private async buildScope(me: CurrentUserPayload, tier = 'manager') {
    const isMemberTier = tier === 'member';
    const isAdmin = me.role === Role.ADMIN;
    // 归档项目也要能问：归档只是不再排在前面，历史进展/任务都还在，查不到反而让人以为数据丢了
    const perm: Prisma.ProjectWhereInput = isAdmin
      ? {}
      : {
          OR: [
            { ownerId: me.id },
            { members: { some: { userId: me.id } } },
            { departments: deptOfProjectAuthority(me.id) },
          ],
        };
    const pSelect = { id: true, name: true, status: true, confidential: true, ownerId: true, dingtalkGroupName: true } as const;
    const [activeRows, archivedRows] = await Promise.all([
      this.prisma.project.findMany({ where: { deletedAt: null, archived: false, ...perm }, select: pSelect, orderBy: { updatedAt: 'desc' }, take: 120 }),
      // 归档项目都是旧的，跟活跃项目挤同一个 updatedAt 倒序名额会被挤掉，所以单独取一批
      this.prisma.project.findMany({ where: { deletedAt: null, archived: true, ...perm }, select: pSelect, orderBy: { updatedAt: 'desc' }, take: 40 }),
    ]);
    const projects = [
      ...activeRows.map((p) => ({ ...p, archived: false })),
      ...archivedRows.map((p) => ({ ...p, archived: true })),
    ];
    // 员工档：不把其他人的名字和群名交给模型——模型拿不到对象名，就构造不出「发给谁/发到哪个群」的意图
    if (isMemberTier) {
      return {
        isAdmin: false,
        projects,
        members: [{ id: me.id, name: me.name, dept: '' }],
        groups: [] as { conversationId: string; groupName: string; projectIds: string[]; projectNames: string[] }[],
        meetings: [] as { id: string; title: string; status: string; startAt: string }[],
      };
    }
    const visible = await this.reports.visibleOwnerIds(me);
    const users = visible.all
      ? await this.prisma.user.findMany({
          where: { active: true },
          select: { id: true, name: true, department: { select: { name: true } } },
          orderBy: { name: 'asc' },
          take: 300,
        })
      : await this.prisma.user.findMany({
          where: { id: { in: visible.ids }, active: true },
          select: { id: true, name: true, department: { select: { name: true } } },
          orderBy: { name: 'asc' },
        });
    const groups = new Map<
      string,
      { conversationId: string; groupName: string; projectIds: string[]; projectNames: string[]; isCompany?: boolean }
    >();
    const projWithGroup = await this.prisma.project.findMany({
      where: {
        deletedAt: null,
        dingtalkConversationId: { not: null },
        ...(isAdmin ? {} : { id: { in: projects.map((p) => p.id) } }),
      },
      select: { id: true, name: true, dingtalkConversationId: true, dingtalkGroupName: true },
    });
    for (const p of projWithGroup) {
      if (!p.dingtalkConversationId) continue;
      const cur = groups.get(p.dingtalkConversationId);
      if (cur) {
        cur.projectIds.push(p.id);
        cur.projectNames.push(p.name);
      } else {
        groups.set(p.dingtalkConversationId, {
          conversationId: p.dingtalkConversationId,
          groupName: p.dingtalkGroupName ?? p.dingtalkConversationId,
          projectIds: [p.id],
          projectNames: [p.name],
        });
      }
    }
    // 公司群（固定名「杭州红蛛科技有限公司」）：仅管理员/部门负责人可发，项目负责人只发自己项目群
    // projectIds 取可见项目全集，让逾期催办/日报催办能按项目把人归到公司群，而不是把全公司名单无差别塞进去
    if (me.role === Role.ADMIN || me.role === Role.DEPT_LEADER) {
      const company = await this.resolveCompanyGroup();
      if (company) {
        const allIds = projects.map((p) => p.id);
        const allNames = projects.map((p) => p.name);
        const cur = groups.get(company.conversationId);
        if (cur) {
          cur.isCompany = true;
          cur.projectIds = allIds;
          cur.projectNames = allNames;
          cur.groupName = COMPANY_GROUP_NAME;
        } else {
          groups.set(company.conversationId, {
            conversationId: company.conversationId,
            groupName: COMPANY_GROUP_NAME,
            projectIds: allIds,
            projectNames: allNames,
            isCompany: true,
          });
        }
      }
    }
    const meetings = await this.prisma.meeting.findMany({
      where: { deletedAt: null, ownerId: me.id, status: { in: ['DRAFT', 'SCHEDULED'] } },
      select: { id: true, title: true, status: true, startAt: true },
      orderBy: { startAt: 'desc' },
      take: 20,
    });
    return {
      isAdmin,
      projects,
      members: users.map((u) => ({ id: u.id, name: u.name, dept: u.department?.name ?? '' })),
      groups: [...groups.values()],
      meetings: meetings.map((m) => ({ id: m.id, title: m.title, status: m.status, startAt: fmtBeijing(m.startAt) })),
    };
  }

  /** 唯一命中→返回候选；歧义/未命中→返回带提示的 Error（调用方转成工具错误信息或动作降级） */
  private matchOne<T>(cands: T[], pick: (t: T) => string, input: unknown): T | Error {
    const n = normName(input);
    if (!n) return new Error('名称为空');
    let hits = cands.filter((c) => normName(pick(c)) === n);
    if (!hits.length) hits = cands.filter((c) => normName(pick(c)).includes(n) || n.includes(normName(pick(c))));
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) return new Error(`「${input}」匹配到多个对象，请让用户明确是哪一个`);
    return new Error(`「${input}」不在你的可见范围内（可能名称不对或无权访问）`);
  }

  /**
   * 公司群 conversationId 解析（按固定群名走 dws 查一次，内存缓存 10 分钟）
   * - 查不到（dws 未启用/未登录/群改名）时返回 null，调用方当“公司群不可用”处理，不阻塞对话
   * - 失败也缓存，避免每轮对话都去跑一次 dws 命令
   */
  private companyGroupCache: { at: number; value: { conversationId: string; name: string } | null } | null = null;
  private async resolveCompanyGroup(): Promise<{ conversationId: string; name: string } | null> {
    const now = Date.now();
    if (this.companyGroupCache && now - this.companyGroupCache.at < 10 * 60 * 1000) return this.companyGroupCache.value;
    let value: { conversationId: string; name: string } | null = null;
    try {
      const r = await this.dingtalkFetch.resolveGroupByName(COMPANY_GROUP_NAME);
      if (r.ok) value = { conversationId: r.conversationId, name: r.name || COMPANY_GROUP_NAME };
      else this.logger.warn(`公司群「${COMPANY_GROUP_NAME}」解析失败：${r.reason}`);
    } catch (e: any) {
      this.logger.warn(`公司群「${COMPANY_GROUP_NAME}」解析异常：${e?.message ?? e}`);
    }
    this.companyGroupCache = { at: now, value };
    return value;
  }

  private resolveProject(scope: any, name: unknown) {
    return this.matchOne<any>(scope.projects, (p) => p.name, name);
  }

  private resolveMeeting(scope: any, title: unknown) {
    return this.matchOne<any>(scope.meetings, (m) => m.title, title);
  }

  private resolveGroup(scope: any, name: unknown) {
    // 「公司群/公司大群/大群」是用户口语，直接指向固定公司群（群名固定，不必让模型记住全名）
    const n = normName(name);
    if (/^(公司群|公司大群|大群|全公司群|全体群|全员群|公司)$/.test(n)) {
      const company = (scope.groups ?? []).find((g: any) => g.isCompany);
      if (company) return company;
      return new Error(`公司群「${COMPANY_GROUP_NAME}」暂时没解析到（钉钉未登录或群名变更），请改用具体项目群`);
    }
    return this.matchOne<any>(scope.groups, (g) => g.groupName, name);
  }

  // ---- 只读工具执行 ----

  private async runTool(me: CurrentUserPayload, scope: any, tool: string, args: any, tier = 'manager'): Promise<unknown> {
    // 档位白名单硬拦截：前端不给按钮不算防住，模型乱承诺也不能真查到别人的数据
    if (tier === 'member' && !MEMBER_TOOLS.has(tool)) {
      return { error: '这个查询只对项目/部门负责人开放，你当前是普通成员档' };
    }
    try {
      switch (tool) {
        case 'list_projects':
          return await this.toolListProjects(scope);
        case 'project_progress':
          return await this.toolProjectProgress(me, scope, args);
        case 'project_risks':
          return await this.toolProjectRisks(scope, args);
        case 'project_tasks':
          return await this.toolProjectTasks(scope, args);
        case 'project_weekly':
          return await this.toolProjectWeekly(me, scope, args);
        case 'list_meetings':
          return await this.toolListMeetings(me, scope, args);
        case 'group_options':
          return { groups: scope.groups.map((g: any) => g.groupName) };
        case 'weekly_status':
          return await this.toolWeeklyStatus(me, args);
        case 'daily_status':
          return await this.toolDailyStatus(me, scope, args);
        case 'overdue_tasks':
          return await this.toolOverdueTasks(me, scope, args);
        case 'my_today':
          return await this.toolMyToday(me);
        case 'my_tasks':
          return await this.toolMyTasks(me);
        case 'search_knowledge':
          return await this.toolSearchKnowledge(me, args);
        case 'search_sop':
          return await this.toolSearchSop(args);
        case 'project_files':
          return await this.toolProjectFiles(me, scope, args);
        case 'read_project_doc':
          return await this.toolReadProjectDoc(me, scope, args);
        case 'project_reports':
          return await this.toolProjectReports(me, scope, args);
        case 'my_ranking':
          return await this.toolMyRanking(me, args);
        case 'team_ranking':
          return await this.toolTeamRanking(me, scope, args);
        case 'my_work_schedule':
          return await this.toolMyWorkSchedule(me);
        default:
          return { error: `未知工具「${tool}」，请从清单中选择` };
      }
    } catch (e: any) {
      return { error: String(e?.message ?? e).slice(0, 200) };
    }
  }

  private async toolListProjects(scope: any) {
    const ids = scope.projects.map((p: any) => p.id);
    const counts = ids.length
      ? await this.prisma.task.groupBy({ by: ['projectId', 'status'], where: { projectId: { in: ids } }, _count: { _all: true } })
      : [];
    const stat = new Map<string, Record<string, number>>();
    for (const c of counts) {
      const m = stat.get(c.projectId) ?? {};
      m[c.status] = c._count._all;
      stat.set(c.projectId, m);
    }
    return {
      projects: scope.projects.slice(0, 60).map((p: any) => ({
        name: p.name,
        status: p.status,
        archived: !!p.archived,
        tasks: stat.get(p.id) ?? {},
        confidential: p.confidential,
      })),
    };
  }

  /** 保密项目门槛：非 ADMIN 需 owner/成员本人 ∧ 已签 NDA（与项目详情口径一致） */
  private async canSeeProject(me: CurrentUserPayload, project: any): Promise<boolean> {
    if (!project.confidential || me.role === Role.ADMIN) return true;
    const isMember =
      project.ownerId === me.id ||
      !!(await this.prisma.projectMember.findUnique({ where: { projectId_userId: { projectId: project.id, userId: me.id } } }));
    if (!isMember) return false;
    const signed = await this.prisma.ndaSign.count({ where: { projectId: project.id, userId: me.id } });
    return signed > 0;
  }

  // ---- 项目 AI 员工：项目页上下文里的档案与三件套工具 ----

  /** 项目工具的项目定位：优先 args.projectName，缺省用当前页面项目（AI 员工场景） */
  private resolveToolProject(scope: any, name: unknown) {
    if (name && String(name).trim()) return this.resolveProject(scope, name);
    if (scope?.pageProject) return scope.pageProject;
    return new Error('请告诉我项目名（在项目详情页提问时可直接说「这个项目」）');
  }

  /**
   * 项目档案（AI 员工首屏注入）：信息/任务概况/文件与在线文档清单/今日成员日报，全部限量防 token 失控。
   * 注入失败不阻断对话（catch 返回空串）；保密项目已在 chat() 里过 canSeeProject 门槛。
   */
  private async buildProjectDossier(me: CurrentUserPayload, pageProject: { id: string; name: string }): Promise<string> {
    try {
      const p = await this.prisma.project.findUnique({
        where: { id: pageProject.id },
        select: {
          id: true,
          name: true,
          status: true,
          archived: true,
          startDate: true,
          endDate: true,
          completionPercent: true,
          healthLevel: true,
          healthPercent: true,
          owner: { select: { name: true } },
          departments: { select: { department: { select: { name: true } } } },
          members: { select: { user: { select: { name: true } } } },
        },
      });
      if (!p) return '';
      const [files, docs, taskStat, overdue, todayReports] = await Promise.all([
        this.prisma.documentFile.findMany({
          where: { projectId: p.id },
          orderBy: { updatedAt: 'desc' },
          take: 40,
          select: { name: true },
        }),
        this.prisma.knowledgeDoc.findMany({
          where: { projectId: p.id },
          orderBy: { updatedAt: 'desc' },
          take: 40,
          select: { title: true },
        }),
        this.prisma.task.groupBy({ by: ['status'], where: { projectId: p.id }, _count: { _all: true } }),
        this.prisma.task.findMany({
          where: { projectId: p.id, status: { not: 'DONE' }, dueDate: { lt: new Date() } },
          orderBy: { dueDate: 'asc' },
          take: 5,
          select: { title: true, assignee: { select: { name: true } } },
        }),
        this.reports.dailyOverview(me, { projectId: p.id, date: fmtBeijingDate(new Date()) }),
      ]);
      const memberNames = p.members.map((m) => m.user?.name).filter(Boolean) as string[];
      const stat: Record<string, number> = {};
      for (const s of taskStat) stat[s.status] = s._count._all;
      const todayItems = (Array.isArray(todayReports) ? todayReports : [])
        .filter((x: any) => x.submitted)
        .slice(0, 8)
        .map((x: any) => `${x.name}：${truncate(x.content ?? '', 90)}`);
      const lines = [
        `【项目AI员工 · 当前项目档案】（用户在本项目页提问时优先依据这里；深查用 project_files / read_project_doc / project_reports）`,
        `- 基本信息：${p.name}${p.archived ? '（已归档）' : ''}｜状态 ${p.status}｜负责人 ${p.owner?.name ?? ''}｜关联部门 ${
          p.departments.map((d) => d.department?.name).filter(Boolean).join('、') || '无'
        }${p.startDate ? `｜计划 ${fmtBeijing(p.startDate).slice(0, 10)} ~ ${p.endDate ? fmtBeijing(p.endDate).slice(0, 10) : '未定'}` : ''}｜完成度 ${p.completionPercent ?? '-'}%｜健康度 ${p.healthLevel ?? '-'}${p.healthPercent != null ? `(${p.healthPercent})` : ''}`,
        `- 成员（${memberNames.length}）：${memberNames.join('、') || '无'}`,
        `- 任务概况：${JSON.stringify(stat)}${overdue.length ? `；逾期：${overdue.map((t) => `${t.assignee?.name ?? ''}《${truncate(t.title, 30)}》`).join('、')}` : ''}`,
        `- 文件空间（${files.length} 个，最新在前）：${files.map((f) => f.name).join('；') || '无'}`,
        `- 在线文档（${docs.length} 篇）：${docs.map((d) => `《${d.title}》`).join('；') || '无'}`,
        `- 今日已交日报（${todayItems.length}）：${todayItems.join(' ⏎ ') || '今日暂无'}`,
        `- 成员分工建议用 TASK_CREATE 动作（assigneeName 必须是上面成员名单里的人；projectName 填本项目名）`,
      ];
      return lines.join('\n').slice(0, 4200);
    } catch (e: any) {
      this.logger.warn(`项目档案注入失败（${pageProject.name}）：${e?.message ?? e}`);
      return '';
    }
  }

  /** 项目文件与在线文档清单（AI 员工）：文件给元数据，在线文档给标题；keyword 过滤名称/正文 */
  private async toolProjectFiles(me: CurrentUserPayload, scope: any, args: any) {
    const p = this.resolveToolProject(scope, args?.projectName);
    if (p instanceof Error) return { error: p.message };
    if (!(await this.canSeeProject(me, p))) return { error: `「${p.name}」是保密项目，你无权查看其文件` };
    const kw = String(args?.keyword ?? '').trim();
    const [files, docs] = await Promise.all([
      this.prisma.documentFile.findMany({
        where: { projectId: p.id, ...(kw ? { name: { contains: kw } } : {}) },
        orderBy: { updatedAt: 'desc' },
        take: 60,
        select: {
          name: true,
          size: true,
          mimeType: true,
          note: true,
          updatedAt: true,
          folder: { select: { name: true } },
          uploader: { select: { name: true } },
        },
      }),
      this.prisma.knowledgeDoc.findMany({
        where: {
          projectId: p.id,
          ...(kw ? { OR: [{ title: { contains: kw } }, { content: { contains: kw } }] } : {}),
        },
        orderBy: { updatedAt: 'desc' },
        take: 60,
        select: { title: true, visibility: true, updatedAt: true, author: { select: { name: true } } },
      }),
    ]);
    return {
      projectName: p.name,
      keyword: kw || undefined,
      files: files.map((f) => ({
        name: f.name,
        size: f.size,
        folder: f.folder?.name ?? '',
        uploader: f.uploader?.name ?? '',
        updatedAt: fmtBeijing(f.updatedAt).slice(0, 10),
      })),
      docs: docs.map((d) => ({
        title: d.title,
        visibility: d.visibility,
        author: d.author?.name ?? '',
        updatedAt: fmtBeijing(d.updatedAt).slice(0, 10),
      })),
      hint: '读正文用 read_project_doc（在线文档传 docTitle，文件传 fileName；二进制文件只给元数据）',
    };
  }

  /**
   * 读项目文档（AI 员工）：在线文档（KnowledgeDoc）给全文（截 6000 字）；二进制文件（DocumentFile）只给元数据。
   * 个人文档（PRIVATE）只对作者/管理员开放正文，与知识库可见性口径一致。
   */
  private async toolReadProjectDoc(me: CurrentUserPayload, scope: any, args: any) {
    const p = this.resolveToolProject(scope, args?.projectName);
    if (p instanceof Error) return { error: p.message };
    if (!(await this.canSeeProject(me, p))) return { error: `「${p.name}」是保密项目，你无权查看其文档` };
    const title = String(args?.docTitle ?? args?.title ?? '').trim();
    const fileName = String(args?.fileName ?? '').trim();
    if (!title && !fileName) return { error: '请给 docTitle（在线文档标题）或 fileName（文件名）' };
    if (fileName) {
      const f = await this.prisma.documentFile.findFirst({
        where: { projectId: p.id, name: { contains: fileName } },
        orderBy: { updatedAt: 'desc' },
        select: {
          name: true,
          size: true,
          mimeType: true,
          note: true,
          updatedAt: true,
          uploader: { select: { name: true } },
        },
      });
      if (!f) return { error: `项目「${p.name}」里没找到文件「${fileName}」，可先用 project_files 查清单` };
      return {
        projectName: p.name,
        file: {
          name: f.name,
          size: f.size,
          mimeType: f.mimeType,
          note: f.note,
          updatedAt: fmtBeijing(f.updatedAt).slice(0, 10),
          uploader: f.uploader?.name ?? '',
        },
        note: '二进制文件不提供正文；如需内容请提示用户到项目「项目文档 → 文件空间」查看',
      };
    }
    const doc = await this.prisma.knowledgeDoc.findFirst({
      where: { projectId: p.id, ...(title ? { title: { contains: title } } : {}) },
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true,
        title: true,
        content: true,
        visibility: true,
        authorId: true,
        updatedAt: true,
        author: { select: { name: true } },
      },
    });
    if (!doc) return { error: `项目「${p.name}」里没找到在线文档「${title}」，可先用 project_files 查清单` };
    if (doc.visibility === 'PRIVATE' && doc.authorId !== me.id && me.role !== Role.ADMIN) {
      return { error: `《${doc.title}》是个人文档，你无权读取正文` };
    }
    return {
      projectName: p.name,
      doc: {
        title: doc.title,
        author: doc.author?.name ?? '',
        updatedAt: fmtBeijing(doc.updatedAt).slice(0, 10),
        content: doc.content.slice(0, 6000),
        truncated: doc.content.length > 6000,
      },
    };
  }

  /**
   * 项目成员日报（AI 员工）：名册以当日 daily-overview 为准（与「项目日报」Tab 同权限口径），
   * 再按名册回查最近 days 天的日报正文；personName 可只看某人。
   */
  private async toolProjectReports(me: CurrentUserPayload, scope: any, args: any) {
    const p = this.resolveToolProject(scope, args?.projectName);
    if (p instanceof Error) return { error: p.message };
    const days = Math.min(14, Math.max(1, Number(args?.days) || 7));
    const person = String(args?.personName ?? '').trim();
    const roster = await this.reports.dailyOverview(me, { projectId: p.id, date: fmtBeijingDate(new Date()) });
    if (!Array.isArray(roster) || !roster.length) return { projectName: p.name, reports: [], note: '该项目名册为空' };
    const ids = [...new Set(roster.map((x: any) => x.userId).filter(Boolean))];
    const since = new Date(Date.now() - (days - 1) * 86400000);
    const rows = await this.prisma.report.findMany({
      where: { type: 'DAILY', ownerId: { in: ids }, periodStart: { gte: since } },
      orderBy: { periodStart: 'desc' },
      take: 60,
      include: { owner: { select: { name: true } } },
    });
    const items = rows
      .map((r) => ({
        date: fmtBeijing(r.periodStart).slice(0, 10),
        name: r.owner?.name ?? '',
        hours: typeof r.hours === 'number' ? r.hours : null,
        content: dailyBodyOf(r),
      }))
      .filter((x) => !person || normName(x.name) === normName(person) || normName(x.name).includes(normName(person)));
    return {
      projectName: p.name,
      days,
      count: items.length,
      reports: items.slice(0, 30).map((x) => ({ ...x, content: truncate(x.content, 400) })),
    };
  }

  private async toolProjectProgress(me: CurrentUserPayload, scope: any, args: any) {
    const p = this.resolveProject(scope, args?.projectName);
    if (p instanceof Error) return { error: p.message };
    if (!(await this.canSeeProject(me, p))) return { error: `「${p.name}」是保密项目，你无权查看其进展` };
    const since = new Date(Date.now() - 14 * 86400000);
    const updates = await this.prisma.projectUpdate.findMany({
      where: { projectId: p.id, periodEnd: { gte: since } },
      orderBy: { periodEnd: 'desc' },
      take: 15,
      select: { content: true, keyPoints: true, source: true, periodEnd: true },
    });
    return {
      projectName: p.name,
      updates: updates.map((u) => ({ date: fmtBeijing(u.periodEnd).slice(0, 10), source: u.source, text: truncate(u.content, 160) })),
    };
  }

  private async toolProjectRisks(scope: any, args: any) {
    const p = this.resolveProject(scope, args?.projectName);
    if (p instanceof Error) return { error: p.message };
    const full = await this.prisma.project.findUnique({
      where: { id: p.id },
      select: { name: true, completionPercent: true, healthPercent: true, healthLevel: true, healthSummary: true, healthRisks: true, healthSuggestions: true, healthAnalyzedAt: true, endDate: true },
    });
    const split = (s: string | null) => (s ?? '').split('\n').map((x) => x.trim()).filter(Boolean).slice(0, 8);
    return {
      projectName: full?.name,
      completionPercent: full?.completionPercent,
      healthPercent: full?.healthPercent,
      healthLevel: full?.healthLevel,
      summary: full?.healthSummary ? truncate(full.healthSummary, 300) : null,
      risks: split(full?.healthRisks ?? null),
      suggestions: split(full?.healthSuggestions ?? null),
      analyzedAt: full?.healthAnalyzedAt ? fmtBeijing(full.healthAnalyzedAt).slice(0, 16) : null,
      planEndDate: full?.endDate ? fmtBeijingDate(full.endDate) : null,
    };
  }

  private async toolProjectTasks(scope: any, args: any) {
    const p = this.resolveProject(scope, args?.projectName);
    if (p instanceof Error) return { error: p.message };
    const tasks = await this.prisma.task.findMany({
      where: { projectId: p.id },
      select: {
        title: true, status: true, dueDate: true,
        assignee: { select: { name: true } },
      },
    });
    const byStatus: Record<string, number> = {};
    for (const t of tasks) byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;
    const now = new Date();
    const overdue = tasks
      .filter((t) => t.dueDate && t.status !== 'DONE' && t.dueDate < now)
      .sort((a, b) => a.dueDate!.getTime() - b.dueDate!.getTime())
      .slice(0, 15)
      .map((t) => ({ title: truncate(t.title, 60), status: t.status, due: fmtBeijingDate(t.dueDate!), who: t.assignee?.name ?? '未指派' }));
    const doing = tasks
      .filter((t) => t.status === 'IN_PROGRESS')
      .slice(0, 15)
      .map((t) => ({ title: truncate(t.title, 60), who: t.assignee?.name ?? '未指派', due: t.dueDate ? fmtBeijingDate(t.dueDate) : null }));
    return { total: tasks.length, byStatus, overdue, inProgress: doing };
  }

  private async toolProjectWeekly(me: CurrentUserPayload, scope: any, args: any) {
    const p = this.resolveProject(scope, args?.projectName);
    if (p instanceof Error) return { error: p.message };
    const r = await this.projects.projectWeeklyReport(me.id, me.role, p.id, args?.periodStart).catch((e: any) => ({ error: String(e?.message ?? e).slice(0, 160) } as any));
    if ((r as any).error) return r;
    const sections = (r as any).sections ?? [];
    return {
      projectName: (r as any).projectName,
      weekLabel: (r as any).weekLabel,
      readiness: (r as any).readiness,
      submitted: sections
        .filter((s: any) => s.submitted)
        .slice(0, 40)
        .map((s: any) => ({ name: s.name, dept: s.departmentName, note: s.scopeNote ?? null, text: truncate(s.content, 160) })),
      missingNames: sections.filter((s: any) => !s.submitted).map((s: any) => s.name),
    };
  }

  /**
   * 只读工具：某项目今天日报提交情况（成员+负责人里谁已交/谁待补）
   * 与每日小组小结（发群）同一口径：名单=项目 owner+members；判定「今日已交」用 submitDaily 相同的服务器本地零点
   * 仅管理者档可用（成员档不放开，会泄露别人情况）
   */
  private async toolDailyStatus(me: CurrentUserPayload, scope: any, args: any) {
    const projectName = String(args?.projectName ?? '').trim();
    let target: any = null;
    if (projectName) {
      const p = this.resolveProject(scope, projectName);
      if (p instanceof Error) return { error: p.message };
      target = p;
    } else {
      // 没点名项目：只管理一个可见项目时直接用它；多个则追问（避免把别人项目名单端出来）
      const manageable = scope.projects.filter((p: any) => !p.archived && (scope.isAdmin || p.ownerId === me.id));
      if (manageable.length === 1) target = manageable[0];
      else if (manageable.length === 0) return { error: '你没找到可管理的活跃项目，请确认项目名称' };
      else return { error: '你管理多个项目，请说明查哪个项目的日报' };
    }
    if (!(await this.canSeeProject(me, target))) return { error: `无权查看项目「${target.name}」的日报情况` };

    const proj = await this.prisma.project.findUnique({
      where: { id: target.id },
      select: { id: true, name: true, ownerId: true, members: { select: { userId: true } } },
    });
    if (!proj) return { error: '项目不存在或已删除' };
    const roster = [...new Set([proj.ownerId, ...proj.members.map((m) => m.userId)])];
    if (!roster.length) return { project: proj.name, rosterCount: 0, submittedCount: 0, missingCount: 0, submittedNames: [], missingNames: [] };

    // 与 submitDaily 存 periodStart（服务器本地零点）一致：判定「今日已交」用本地零点
    const now = new Date();
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);
    const [names, reportsToday] = await Promise.all([
      this.prisma.user.findMany({ where: { id: { in: roster } }, select: { id: true, name: true } }),
      this.prisma.report.findMany({
        where: { type: 'DAILY', ownerId: { in: roster }, periodStart: { gte: todayStart, lt: new Date(todayStart.getTime() + 86400000) } },
        select: { ownerId: true },
      }),
    ]);
    const nameById = new Map(names.map((u) => [u.id, u.name]));
    const submittedSet = new Set(reportsToday.map((r) => r.ownerId).filter(Boolean) as string[]);
    const submittedNames: string[] = [];
    const missingNames: string[] = [];
    for (const uid of roster) {
      const nm = nameById.get(uid) ?? '未知成员';
      (submittedSet.has(uid) ? submittedNames : missingNames).push(nm);
    }
    return {
      project: proj.name,
      date: fmtBeijingDate(now),
      rosterCount: roster.length,
      submittedCount: submittedNames.length,
      missingCount: missingNames.length,
      submittedNames,
      missingNames,
      links: [{ label: `${proj.name} 日报页`, to: '/reports' }],
    };
  }

  private async toolListMeetings(me: CurrentUserPayload, scope: any, args: any) {
    let projectId: string | null = null;
    if (args?.projectName) {
      const p = this.resolveProject(scope, args.projectName);
      if (p instanceof Error) return { error: p.message };
      projectId = p.id;
    }
    const and: Record<string, unknown>[] = [{ deletedAt: null }];
    if (projectId) and.push({ projectId });
    if (!scope.isAdmin) {
      and.push({
        OR: [
          { ownerId: me.id },
          { status: { not: 'DRAFT' }, participantIds: { has: me.id } },
          { materials: { some: { userId: me.id } } },
        ],
      });
    }
    const rows = await this.prisma.meeting.findMany({
      where: { AND: and },
      orderBy: { startAt: 'desc' },
      take: 16,
      select: { id: true, title: true, scope: true, status: true, startAt: true, endAt: true, participantIds: true, groupName: true, ownerId: true },
    });
    const ownerNames = await this.prisma.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.ownerId))] } }, select: { id: true, name: true } });
    const owner = new Map(ownerNames.map((u) => [u.id, u.name]));
    const now = new Date();
    return {
      meetings: rows.map((m) => ({
        title: truncate(m.title, 50),
        status: m.status,
        time: `${fmtBeijing(m.startAt).slice(5, 16)}~${fmtBeijing(m.endAt).slice(11, 16)}`,
        upcoming: m.startAt >= now,
        members: m.participantIds.length,
        host: owner.get(m.ownerId) ?? '—',
        group: m.groupName ?? null,
      })),
    };
  }

  private async toolWeeklyStatus(me: CurrentUserPayload, args: any) {
    const agg = await this.reports.weeklyAggregate(me, { periodStart: args?.periodStart });
    return {
      weekLabel: agg.weekLabel,
      readiness: agg.readiness,
      submitted: agg.sections.filter((s: any) => s.submitted).slice(0, 60).map((s: any) => s.name),
      missingNames: agg.sections.filter((s: any) => !s.submitted).map((s: any) => s.name),
    };
  }

  /** 跨可见项目扫描逾期任务（只收有权查看的项目，保密项目过 NDA 门槛）：按逾期天数倒序 */
  private async scanOverdue(me: CurrentUserPayload, scope: any) {
    const visible: any[] = [];
    for (const p of scope.projects) {
      if (await this.canSeeProject(me, p)) visible.push(p);
    }
    const ids = visible.map((p) => p.id);
    if (!ids.length) return [];
    const nameOf = new Map<string, string>(visible.map((p) => [p.id, p.name]));
    const now = new Date();
    const rows = await this.prisma.task.findMany({
      where: { projectId: { in: ids }, status: { not: 'DONE' }, dueDate: { lt: now } },
      select: { id: true, title: true, dueDate: true, projectId: true, assigneeId: true, assignee: { select: { name: true } } },
      orderBy: { dueDate: 'asc' },
      take: 60,
    });
    return rows.map((t) => ({
      taskId: t.id,
      who: t.assignee?.name ?? '未指派',
      whoId: t.assigneeId ?? null,
      projectId: t.projectId,
      project: nameOf.get(t.projectId) ?? '',
      task: truncate(t.title, 50),
      due: fmtBeijingDate(t.dueDate!),
      days: Math.max(1, Math.floor((now.getTime() - t.dueDate!.getTime()) / 86400000)),
    }));
  }

  /** 只读工具：谁的任务逾期了（按人可读清单，供回答与催办文案素材） */
  private async toolOverdueTasks(me: CurrentUserPayload, scope: any, args: any) {
    let items = await this.scanOverdue(me, scope);
    const who = String(args?.assigneeName ?? '').trim();
    if (who) items = items.filter((t) => normName(t.who).includes(normName(who)) || normName(who).includes(normName(t.who)));
    const projectName = String(args?.projectName ?? '').trim();
    if (projectName) items = items.filter((t) => normName(t.project).includes(normName(projectName)));
    return { count: items.length, items: items.slice(0, 30) };
  }

  /** 只读工具：本人今日/本周写作素材（今天完成与推进的任务、本周已交日报摘要），供日报/周报口述整理 */
  private async toolMyToday(me: CurrentUserPayload) {
    const CN = 8 * 3600 * 1000;
    const bj = new Date(Date.now() + CN);
    const dayStart = new Date(Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth(), bj.getUTCDate()) - CN);
    const monday = beijingMondayOf(new Date());
    const [doneToday, moving, daily] = await Promise.all([
      this.prisma.task.findMany({
        where: { assigneeId: me.id, status: 'DONE', updatedAt: { gte: dayStart } },
        select: { title: true, project: { select: { name: true } } },
        take: 15,
      }),
      this.prisma.task.findMany({
        where: { assigneeId: me.id, status: { not: 'DONE' }, updatedAt: { gte: dayStart } },
        select: { title: true, status: true },
        take: 15,
      }),
      this.prisma.report.findMany({
        where: { ownerId: me.id, type: 'DAILY', periodStart: { gte: dayStart } },
        select: { periodStart: true, correctedContent: true, rawContent: true },
        orderBy: { periodStart: 'desc' },
        take: 7,
      }),
    ]);
    return {
      today: fmtBeijingDate(dayStart),
      weekLabel: `${beijingMondayDate(monday)} 起那周`,
      doneToday: doneToday.map((t) => ({ task: truncate(t.title, 50), project: t.project?.name ?? '' })),
      inProgress: moving.map((t) => ({ task: truncate(t.title, 50), status: t.status })),
      thisWeekDaily: daily.map((d) => ({ date: fmtBeijingDate(d.periodStart), text: truncate(String(d.correctedContent ?? d.rawContent ?? ''), 140) })),
    };
  }

  /**
   * 只读工具：我的待办 / 逾期 / 近 7 天完成
   * 直接复用 TasksService.myTasks——首页「我的待办」卡片与任务页用的就是它，
   * 助手自己另写一份 where 就会出现“助手说有三条、首页只看到两条”这种口径分叉
   */
  private async toolMyTasks(me: CurrentUserPayload) {
    const r = await this.tasks.myTasks({ id: me.id, role: me.role });
    const now = Date.now();
    const row = (t: any) => ({
      title: truncate(t.title, 50),
      project: t.project?.name ?? '',
      status: t.status,
      due: t.dueDate ? fmtBeijing(t.dueDate).slice(0, 16) : null,
      overdueDays:
        t.dueDate && t.status !== 'DONE' && t.dueDate.getTime() < now ? Math.ceil((now - t.dueDate.getTime()) / 86400000) : null,
      doneAt: t.completedAt ? fmtBeijing(t.completedAt).slice(0, 16) : null,
    });
    const firstOverdue = r.todo.find((t: any) => t.dueDate && t.dueDate.getTime() < now) ?? r.todo[0];
    const links: { label: string; to: string }[] = [];
    if (firstOverdue) links.push({ label: `打开「${truncate(firstOverdue.title, 20)}」`, to: `/tasks?open=${firstOverdue.id}` });
    links.push({ label: '我的待办列表', to: '/tasks?scope=mine' });
    return {
      todoCount: r.todo.length,
      overdueCount: r.overdue,
      recentDoneCount: r.done.length,
      // 回收站项目下的任务不计入待办（与首页同一口径），免得用户以为任务被删了
      hiddenInRecycleBin: r.hidden,
      todo: r.todo.slice(0, 12).map(row),
      recentDone: r.done.slice(0, 8).map(row),
      links,
    };
  }

  /** 只读工具：知识库检索（可见性完全复用 KnowledgeService，不自己写 where） */
  private async toolSearchKnowledge(me: CurrentUserPayload, args: any) {
    const kw = String(args?.keyword ?? '').trim();
    if (!kw) return { error: '请给出检索关键词（比如「对账」「部署」「入职」）' };
    const docs = await this.knowledge.listDocs(
      { id: me.id, role: me.role, departmentId: me.departmentId ?? null, name: me.name },
      { keyword: kw },
    );
    // listDocs 的可见性里没有保密项目 NDA 这一层（getDoc 才有），这里补齐：没签保密协议的保密项目文档一条不给
    const projIds = [...new Set(docs.map((d: any) => d.project?.id).filter(Boolean))] as string[];
    const confidentialIds = projIds.length
      ? (await this.prisma.project.findMany({ where: { id: { in: projIds }, confidential: true }, select: { id: true } })).map((p) => p.id)
      : [];
    const signedIds = confidentialIds.length
      ? (await this.prisma.ndaSign.findMany({ where: { userId: me.id, projectId: { in: confidentialIds } }, select: { projectId: true } })).map((s) => s.projectId)
      : [];
    const allowed = docs.filter((d: any) => !confidentialIds.includes(d.project?.id) || signedIds.includes(d.project?.id));
    const dropped = docs.length - allowed.length;
    const hits = allowed.slice(0, 8).map((d: any) => ({
      id: d.id,
      title: d.title,
      category: d.category?.name ?? '',
      owner: d.project?.name ?? d.department?.name ?? (d.visibility === 'PRIVATE' ? '个人' : '团队'),
      updated: fmtBeijing(d.updatedAt).slice(0, 10),
      snippet: truncate(String(d.content ?? '').replace(/[#*>`|\r\n]+/g, ' '), 140),
    }));
    return {
      keyword: kw,
      count: allowed.length,
      hits: hits.map(({ id, ...h }: any) => h),
      note: dropped ? `另有 ${dropped} 条属于保密项目但你未签保密协议，已隐去` : null,
      links: hits.slice(0, 3).map((h) => ({ label: `打开《${truncate(h.title, 20)}》`, to: `/knowledge?doc=${h.id}` })),
    };
  }

  /** 只读工具：SOP（标准经验库）检索 */
  private async toolSearchSop(args: any) {
    const kw = String(args?.keyword ?? '').trim();
    const tag = String(args?.tag ?? '').trim();
    const { items, allTags } = await this.sops.list({ keyword: kw || undefined, tag: tag || undefined });
    return {
      keyword: kw || null,
      count: items.length,
      hits: items.slice(0, 8).map((s: any) => ({
        title: s.title,
        status: s.status === 'APPROVED' ? '已生效' : '待确认',
        project: s.project?.name ?? '',
        tags: s.tags,
        fromRetro: s.retro?.title ?? null,
        snippet: truncate(String(s.content ?? '').replace(/[#*>`|\r\n]+/g, ' '), 160),
      })),
      tags: allTags.slice(0, 12).map((t) => `${t.name}(${t.count})`),
      note: items.length ? null : '没检索到相关 SOP，换个关键词试试（上面 tags 是现有标签）',
      links: [{ label: 'SOP 经验库', to: '/sops' }],
    };
  }

  /**
   * 排行口径归一：工时榜支持 week/month/cumulative，日报篇数榜只有 week/month
   * 默认本月（与用户认知里的「公司排名」一致），模型给中文口径也接得住
   */
  private rankScopes(args: any): { hoursScope: 'week' | 'month' | 'cumulative'; countScope: 'week' | 'month' } {
    const s = String(args?.scope ?? '').trim().toLowerCase();
    if (s === 'week' || s === '本周' || s === '这周' || s === '周') return { hoursScope: 'week', countScope: 'week' };
    if (s === 'cumulative' || s === 'all' || s === '累计' || s === '总共') return { hoursScope: 'cumulative', countScope: 'month' };
    return { hoursScope: 'month', countScope: 'month' };
  }

  /**
   * 只读工具：我的公司排名（工时榜 + 日报篇数榜）
   * 不自己写 where：直接转调 ReportsService 两个榜方法并强制 all=true，与首页榜单同一个口径
   * （同样按成员名册取数、同样排除「只看不排」成员），否则会出现“首页第 3、助手说第 5”这种分叉
   * 员工档也可用：返回里只有我的名次与参与人数，不含任何他人姓名/数值
   */
  private async toolMyRanking(me: CurrentUserPayload, args: any) {
    const { hoursScope, countScope } = this.rankScopes(args);
    const [h, c] = await Promise.all([
      this.reports.hoursRanking(me, { scope: hoursScope, all: true }),
      this.reports.reportCountRanking(me, { scope: countScope, all: true }),
    ]);
    const meH: any = h.rows.find((r: any) => r.userId === me.id) ?? null;
    const meC: any = c.rows.find((r: any) => r.userId === me.id) ?? null;
    const notes: string[] = [];
    if (!meH) notes.push(`${h.label}你还没有已发布的带工时日报，所以未进入工时榜（不是“倒数第一”）`);
    if (!meC) notes.push(`${c.label}你还没有已发布日报，暂未进入日报篇数榜`);
    if (hoursScope === 'cumulative') notes.push('日报篇数榜只有本周/本月两个口径，下面的是本月');
    notes.push('榜单只算已发布日报，且“只看不排”的成员不参与排名');
    return {
      scope: hoursScope,
      hoursLabel: h.label,
      hoursRank: meH?.rank ?? null,
      hoursRankedCount: h.memberCount,
      myHours: meH?.hours ?? 0,
      myWorkDays: meH?.days ?? 0,
      reportScope: countScope,
      reportLabel: c.label,
      reportRank: meC?.rank ?? null,
      reportRankedCount: c.memberCount,
      myReportCount: meC?.count ?? 0,
      note: notes.join('；'),
      links: [{ label: '看完整榜单（可切本周/本月）', to: '/reports' }],
    };
  }

  /** 只读工具：团队（项目内/部门/全站）工时与日报篇数排行；仅管理者档——别人的工时与篇数属于进度信息 */
  private async toolTeamRanking(me: CurrentUserPayload, scope: any, args: any) {
    const { hoursScope, countScope } = this.rankScopes(args);
    const top = Math.max(3, Math.min(20, Number(args?.top ?? 10) || 10));
    const projectName = String(args?.projectName ?? '').trim();
    const departmentName = String(args?.departmentName ?? '').trim();
    let opts: { projectId?: string; departmentId?: string; all?: boolean };
    let scopeLabel: string;
    if (projectName) {
      const p = this.resolveProject(scope, projectName);
      if (p instanceof Error) return { error: p.message };
      if (!(await this.canSeeProject(me, p))) return { error: `「${p.name}」是保密项目，你无权查看其排行` };
      opts = { projectId: p.id };
      scopeLabel = `项目·${p.name}`;
    } else if (departmentName) {
      // 部门维度只有管理员与该部门管理者能用：非管理员只在「我管辖的部门（负责人 ∪ 共管人）」里找，与 resolveViewUsers 同口径
      const depts = await this.prisma.department.findMany({
        where:
          me.role === Role.ADMIN
            ? { name: { contains: departmentName } }
            : { AND: [{ name: { contains: departmentName } }, ledDeptWhere(me.id)] },
        select: { id: true, name: true },
        take: 3,
      });
      if (!depts.length) return { error: `没找到部门「${departmentName}」（或你无权查看该部门）` };
      if (depts.length > 1) return { error: `「${departmentName}」匹配到多个部门：${depts.map((d) => d.name).join('、')}，请让用户明确是哪一个` };
      opts = { departmentId: depts[0].id };
      scopeLabel = `部门·${depts[0].name}`;
    } else if (me.role === Role.PROJECT_LEADER) {
      // 项目负责人不点名范围：默认取他负责的唯一活跃项目；管多个就追问，绝不把全站榜单递给他
      const owned = scope.projects.filter((p: any) => !p.archived && p.ownerId === me.id);
      if (owned.length === 1) {
        opts = { projectId: owned[0].id };
        scopeLabel = `项目·${owned[0].name}`;
      } else if (!owned.length) {
        return { error: '你不负责任何活跃项目，请说明要查哪个项目的排行' };
      } else {
        return { error: `你负责多个项目（${owned.map((p: any) => p.name).join('、')}），请说明查哪个项目的排行` };
      }
    } else {
      opts = { all: true };
      scopeLabel = '公司全员';
    }
    const [h, c] = await Promise.all([
      this.reports.hoursRanking(me, { scope: hoursScope, ...opts }),
      this.reports.reportCountRanking(me, { scope: countScope, ...opts }),
    ]);
    const meH: any = h.rows.find((r: any) => r.userId === me.id) ?? null;
    const meC: any = c.rows.find((r: any) => r.userId === me.id) ?? null;
    return {
      scopeLabel,
      hoursLabel: h.label,
      reportLabel: c.label,
      hoursTop: h.rows.slice(0, top).map((r: any) => ({ rank: r.rank, name: r.name, dept: r.departmentName ?? '', hours: r.hours, days: r.days })),
      reportTop: c.rows.slice(0, top).map((r: any) => ({ rank: r.rank, name: r.name, dept: r.departmentName ?? '', count: r.count })),
      hoursRankedCount: h.memberCount,
      reportRankedCount: c.memberCount,
      totalHours: h.totalHours,
      totalReports: c.totalCount,
      myHoursRank: meH?.rank ?? null,
      myReportRank: meC?.rank ?? null,
      note:
        h.memberCount === 0
          ? `${h.label}这个范围内还没有已发布的带工时日报，所以榜单是空的`
          : '榜上只列前若干名；未进入榜单 = 该时段没有已发布日报',
      links: [{ label: '排行页（可切周/月/项目）', to: '/reports' }],
    };
  }

  /** 只读工具：我的整周工作时间安排（顺带告知“没排班就不算应发日报”这条既有规则） */
  private async toolMyWorkSchedule(me: CurrentUserPayload) {
    const s = await this.workSchedule.getMine(me.id);
    const days = WORK_WEEKDAY_LABELS.map((label, weekday) => {
      const list = s.slots.filter((r: any) => r.weekday === weekday);
      return { weekday, label, ranges: list.map((r: any) => slotRangeLabel(r.startMin, r.endMin)), hours: slotsHours(list) };
    });
    return {
      today: s.todayLabel,
      todayRanges: s.todaySlots.map((r: any) => slotRangeLabel(r.startMin, r.endMin)),
      todayHours: s.todayHours,
      weeklyHours: s.totalHours,
      totalSlots: s.totalSlots,
      days,
      presets: WORK_SLOT_PRESETS.map((p) => `${p.label} ${p.range}`),
      note: s.totalSlots
        ? '这是整周循环模板（不按日历日期排），改了就长期生效；没排班的那天不算应发日报、也不会收到日报提醒'
        : '你还没设置工作时间安排——没排班就不算应发日报、也不会收到日报提醒；想设的话直接说“我周一到周五上午下午都上班”',
      links: [{ label: '我的工作时间安排', to: '/reports' }],
    };
  }

  // ---- 动作计划（只生成不执行；前端确认后调现有接口） ----

  private async buildAction(me: CurrentUserPayload, scope: any, action: any, tier = 'manager'): Promise<any | null> {
    const kind = String(action?.kind ?? '').toUpperCase();
    if (!ACTION_KINDS.has(kind)) return null;
    // 档位硬拦截（与 runTool 同一道理）：员工档只能动自己的任务与日报/周报
    if (tier === 'member' && !MEMBER_ACTIONS.has(kind)) return null;
    try {
      switch (kind) {
        case 'MEETING_CREATE':
          return await this.planMeetingCreate(me, scope, action);
        case 'MEETING_PUBLISH':
        case 'MEETING_NOTIFY':
          return await this.planMeetingNotifyLike(me, kind, scope, action);
        case 'WEEKLY_SEND_GROUP':
          return await this.planWeeklySendGroup(me, scope, action);
        case 'WEEKLY_CHASE':
          return await this.planWeeklyChase(me, scope, action);
        case 'TASK_CREATE':
          return await this.planTaskCreate(me, scope, action);
        case 'TASK_PATCH':
          return await this.planTaskPatch(me, scope, action, tier);
        case 'OVERDUE_CHASE':
          return await this.planOverdueChase(me, scope, action);
        case 'NOTIFY_BROADCAST':
          return this.planNotify(me, scope, action);
        case 'DAILY_SUBMIT':
          return await this.planDaily(me, action);
        case 'WEEKLY_SUBMIT':
          return await this.planWeekly(me, scope, action);
        case 'WORK_SCHEDULE_SET':
          return await this.planWorkScheduleSet(me, action);
        case 'DAILY_CHASE':
          return await this.planDailyChase(me, scope, action);
        case 'RISK_ALERT':
          return await this.planRiskAlert(me, scope, action);
      }
    } catch (e: any) {
      this.logger.warn(`Agent 动作计划失败 kind=${kind}: ${e?.message ?? e}`);
      return null;
    }
  }

  private async planMeetingCreate(me: CurrentUserPayload, scope: any, action: any) {
    const a = action ?? {};
    const title = String(a.title ?? '').trim();
    const agenda = String(a.agenda ?? '').trim();
    if (title.length < 2 || !agenda) return null;

    let projectId: string | null = null;
    let projectName: string | null = null;
    if (a.projectName) {
      const p = this.resolveProject(scope, a.projectName);
      if (p instanceof Error) return null;
      projectId = p.id;
      projectName = p.name;
    }
    // scope 推断：绑定项目→PROJECT；ADMIN→COMPANY；部门负责人→DEPT；其余→PERSONAL
    const scopeKind = projectId ? 'PROJECT' : me.role === Role.ADMIN ? 'COMPANY' : me.role === Role.DEPT_LEADER ? 'DEPT' : 'PERSONAL';

    const names: string[] = Array.from(new Set((Array.isArray(a.participantNames) ? a.participantNames : []).map((x) => String(x ?? '').trim()).filter(Boolean)));
    const participantIds: string[] = [];
    const resolved: { name: string; dept: string }[] = [];
    const unknown: string[] = [];
    for (const nm of names) {
      const hit = this.matchOne(scope.members, (u: any) => u.name, nm);
      if (hit instanceof Error) unknown.push(nm);
      else {
        if (!participantIds.includes(hit.id)) participantIds.push(hit.id);
        resolved.push({ name: hit.name, dept: hit.dept });
      }
    }
    // 时间：模型输出 ISO 串（前端本地时区），后端只做有效性校验供确认卡展示
    const startAt = String(a.startAt ?? '');
    const endAt = String(a.endAt ?? '');
    const sv = new Date(startAt);
    const ev = new Date(endAt);
    if (!startAt || !endAt || Number.isNaN(sv.getTime()) || Number.isNaN(ev.getTime()) || ev <= sv) {
      return { kind: 'MEETING_CREATE', needClarify: 'startAt/endAt', reason: '会议时间缺失或结束不晚于开始，请向用户确认具体时间（如「明天15:00~16:00」）' };
    }

    let groupConversationId: string | null = null;
    let groupName: string | null = null;
    if (a.groupName) {
      const g = this.resolveGroup(scope, a.groupName);
      if (g instanceof Error) return null;
      groupConversationId = g.conversationId;
      groupName = g.groupName;
    }
    if (unknown.length) {
      return { kind: 'MEETING_CREATE', needClarify: 'participantNames', reason: `这些人名我没在你的可见范围内找到：${unknown.join('、')}，请确认是谁` };
    }
    return {
      kind: 'MEETING_CREATE',
      title,
      agenda,
      scope: scopeKind,
      projectId,
      projectName,
      startAt,
      endAt,
      startLabel: fmtBeijing(sv).slice(0, 16),
      endLabel: fmtBeijing(ev).slice(11, 16),
      participantIds,
      participantNames: resolved,
      location: String(a.location ?? '').trim() || null,
      publish: a.publish !== false,
      groupConversationId,
      groupName,
    };
  }

  private async planMeetingNotifyLike(me: CurrentUserPayload, kind: string, scope: any, action: any) {
    const m = this.resolveMeeting(scope, action?.meetingTitle);
    if (m instanceof Error) return { kind, needClarify: 'meetingTitle', reason: m.message };
    const kindName = kind === 'MEETING_NOTIFY' ? String(action?.notifyKind ?? 'INVITE').toUpperCase() : 'INVITE';
    if (!['INVITE', 'GROUP', 'START', 'MINUTES', 'MATERIAL', 'WRAP_UP'].includes(kindName)) return null;
    return {
      kind,
      meetingId: m.id,
      meetingTitle: m.title,
      meetingStatus: m.status,
      notifyKind: kindName,
      label: kind === 'MEETING_PUBLISH' ? `发布会议《${m.title}》（草稿→已安排，发邀请通知）` : `为会议《${m.title}》补发「${kindName}」通知`,
    };
  }

  private async planWeeklySendGroup(me: CurrentUserPayload, scope: any, action: any) {
    const a = action ?? {};
    const base = a.periodStart ? new Date(a.periodStart) : new Date();
    const monday = beijingMondayOf(Number.isNaN(base.getTime()) ? new Date() : base);
    // 周报现一律个人唯一：个人行优先，兼容历史周仅有项目/部门归属行→取任一（scopeKey 随命中行）；a.projectName/departmentName 不再作为硬过滤
    const rep =
      (await this.prisma.report.findUnique({
        where: { type_ownerId_periodStart_scopeKey: { type: 'WEEKLY', ownerId: me.id, periodStart: monday, scopeKey: '' } },
        select: { id: true, rawContent: true, correctedContent: true, scopeKey: true },
      })) ??
      (await this.prisma.report.findFirst({
        where: { type: 'WEEKLY', ownerId: me.id, periodStart: monday },
        select: { id: true, rawContent: true, correctedContent: true, scopeKey: true },
      }));
    const scopeKey = rep?.scopeKey ?? '';
    const scopeLabel = '个人周报';
    const bodyText = rep ? String(rep.correctedContent ?? '').trim() || String(rep.rawContent ?? '').trim() : '';
    if (!rep || !bodyText) {
      return { kind: 'WEEKLY_SEND_GROUP', needClarify: 'report', reason: `你本周（${beijingMondayDate(monday)} 起）还没有周报，请先写好再发群` };
    }
    const groupNames: string[] = [];
    const groupIds: string[] = [];
    for (const gn of Array.isArray(a.groupNames) ? a.groupNames : []) {
      const g = this.resolveGroup(scope, gn);
      if (g instanceof Error) continue;
      if (!groupIds.includes(g.conversationId)) {
        groupIds.push(g.conversationId);
        groupNames.push(g.groupName);
      }
    }
    if (!groupIds.length) return null;
    return {
      kind: 'WEEKLY_SEND_GROUP',
      periodStart: beijingMondayDate(monday),
      periodStartIso: monday.toISOString(),
      scopeKey,
      scopeLabel,
      reportContent: bodyText,
      groupIds,
      groupNames,
      label: `把${scopeLabel}（${beijingMondayDate(monday)} 周）原文发到：${groupNames.join('、')}`,
    };
  }

  private async planWeeklyChase(me: CurrentUserPayload, scope: any, action: any) {
    const agg = await this.reports.weeklyAggregate(me, { periodStart: action?.periodStart });
    const missing = agg.sections.filter((s: any) => !s.submitted);
    const asked: string[] = Array.from(new Set((Array.isArray(action?.names) ? action.names : []).map((x) => String(x ?? '').trim()).filter(Boolean)));
    let targets = missing;
    if (asked.length) {
      targets = missing.filter((m: any) => asked.some((q) => normName(m.name) === normName(q) || normName(m.name).includes(normName(q))));
      const notMissing = asked.filter((q) => !missing.some((m: any) => normName(m.name).includes(normName(q)) || normName(q).includes(normName(m.name))));
      if (notMissing.length) {
        return { kind: 'WEEKLY_CHASE', needClarify: 'names', reason: `这些人本周其实已交（或不在缺交名单）：${notMissing.join('、')}；当前缺交：${missing.map((m: any) => m.name).join('、') || '（无人缺交）'}` };
      }
    }
    if (!targets.length) {
      return { kind: 'WEEKLY_CHASE', needClarify: 'none', reason: `${agg.weekLabel} 可见范围内无人缺交周报，无需催办` };
    }
    return {
      kind: 'WEEKLY_CHASE',
      weekLabel: agg.weekLabel,
      names: targets.map((t: any) => t.name),
      label: `给缺交的人发站内提醒（${(targets as any[]).map((t) => t.name).join('、')}，共 ${targets.length} 人）`,
    };
  }

  /** 任务下发计划：一条指令可建多任务；项目/指派人都后端名称→id 解析，解不动降级 needClarify */
  private async planTaskCreate(me: CurrentUserPayload, scope: any, action: any) {
    const rawTasks = Array.isArray(action?.tasks) && action.tasks.length ? action.tasks : action?.title ? [action] : [];
    if (!rawTasks.length) return null;
    const tasks: any[] = [];
    const clarifies: string[] = [];
    for (const t of rawTasks.slice(0, 10)) {
      const title = String(t?.title ?? '').trim();
      if (!title) {
        clarifies.push('有任务没给标题，请补充任务内容');
        continue;
      }
      // 指派人：给了人名就必须唯一解析到可见范围内的人
      let assigneeId: string | null = null;
      let assigneeName: string | null = null;
      const whoInput = String(t?.assigneeName ?? '').trim();
      if (whoInput) {
        const hit = this.matchOne(scope.members, (u: any) => u.name, whoInput);
        if (hit instanceof Error) {
          clarifies.push(`「${title}」的指派人：${hit.message}`);
          continue;
        }
        assigneeId = hit.id;
        assigneeName = hit.name;
      }
      // 项目：显式给了就用；没给则按指派人所在项目唯一定位，多命中/无命中反问
      let projectId: string | null = null;
      let projectName: string | null = null;
      if (t?.projectName) {
        const p = this.resolveProject(scope, t.projectName);
        if (p instanceof Error) {
          clarifies.push(`「${title}」的项目：${p.message}`);
          continue;
        }
        projectId = p.id;
        projectName = p.name;
      } else if (assigneeId) {
        const owned = scope.projects.filter((p: any) => p.ownerId === assigneeId);
        const memberIds = (await this.prisma.projectMember.findMany({ where: { userId: assigneeId }, select: { projectId: true } })).map((m) => m.projectId);
        const joined = scope.projects.filter((p: any) => memberIds.includes(p.id));
        const cands = [...new Map([...owned, ...joined].map((p: any) => [p.id, p])).values()];
        if (cands.length === 1) {
          projectId = cands[0].id;
          projectName = cands[0].name;
        } else if (cands.length > 1) {
          clarifies.push(`「${title}」：${assigneeName} 同时属于多个项目（${cands.map((c: any) => c.name).join('、')}），请让用户明确放到哪个项目`);
          continue;
        } else {
          clarifies.push(`「${title}」：${assigneeName} 不在你的任何可见项目里，请让用户先指定项目或确认人名`);
          continue;
        }
      } else {
        clarifies.push(`「${title}」既没给项目也没给指派人，至少需要一项`);
        continue;
      }
      // 指派+项目同时存在：校验被指派人属该项目成员/负责人（与 tasks.create 同口径，保证被指派者必然可见）
      if (assigneeId && projectId) {
        const proj = scope.projects.find((p: any) => p.id === projectId);
        const isOwner = proj?.ownerId === assigneeId;
        const member = await this.prisma.projectMember.findUnique({ where: { projectId_userId: { projectId, userId: assigneeId } }, select: { userId: true } });
        if (!isOwner && !member) {
          clarifies.push(`「${title}」的指派人 ${assigneeName} 不是项目「${projectName}」的成员，请让用户确认先入项目或改指派/改项目`);
          continue;
        }
      }
      const due = t?.dueDate ? new Date(String(t.dueDate)) : null;
      const dueValid = due && !Number.isNaN(due.getTime()) ? due : null;
      const prio = String(t?.priority ?? '').toUpperCase();
      tasks.push({
        title,
        description: String(t?.description ?? '').trim() || null,
        priority: ['LOW', 'MEDIUM', 'HIGH', 'URGENT'].includes(prio) ? prio : 'MEDIUM',
        projectId,
        projectName,
        assigneeId,
        assigneeName,
        dueDate: dueValid ? dueValid.toISOString() : null,
        dueLabel: dueValid ? fmtBeijingDate(dueValid) : null,
      });
    }
    if (!tasks.length) {
      return { kind: 'TASK_CREATE', needClarify: 'tasks', reason: clarifies.join('；') || '任务信息不足' };
    }
    return {
      kind: 'TASK_CREATE',
      tasks,
      clarifyNote: clarifies.length ? `部分任务未创建，需确认：${clarifies.join('；')}` : null,
      label: `创建 ${tasks.length} 个任务并通知负责人（${tasks.map((x) => x.assigneeName ?? '未指派').join('、')}）`,
    };
  }

  /**
   * 任务调整计划：按标题（+可选项目/负责人）在可见项目里唯一定位一条任务，只改状态/截止时间/优先级
   * 刻意不开放「改派负责人」：改派要重新通知新人、旧人退出，属于下发类操作，该走 TASK_CREATE
   * 确认后前端调 PATCH /tasks/:id——与首页待办卡片快捷操作同一个接口，权限/活动记录/看板落位都是现成的
   */
  private async planTaskPatch(me: CurrentUserPayload, scope: any, action: any, tier: string) {
    const clarify = (field: string, reason: string) => ({ kind: 'TASK_PATCH', needClarify: field, reason });
    const title = String(action?.taskTitle ?? action?.title ?? '').trim();
    if (!title) return clarify('taskTitle', '请说明要调整哪一条任务（任务标题或关键词）');
    const where: Prisma.TaskWhereInput = {
      title: { contains: title, mode: 'insensitive' },
      project: { id: { in: scope.projects.map((p: any) => p.id) } },
    };
    if (action?.projectName) {
      const p = this.resolveProject(scope, action.projectName);
      if (p instanceof Error) return clarify('projectName', p.message);
      where.projectId = p.id;
    }
    if (action?.assigneeName) {
      const hit = this.matchOne(scope.members, (u: any) => u.name, action.assigneeName);
      if (hit instanceof Error) return clarify('assigneeName', hit.message);
      where.assigneeId = hit.id;
    }
    const found = await this.prisma.task.findMany({
      where,
      select: {
        id: true,
        title: true,
        status: true,
        dueDate: true,
        priority: true,
        assigneeId: true,
        project: { select: { id: true, name: true, archived: true, confidential: true } },
        assignee: { select: { name: true } },
      },
      take: 6,
    });
    if (!found.length) {
      return clarify('taskTitle', `没在你可见的项目里找到标题含「${title}」的任务，可先用 my_tasks 或 project_tasks 核对一下标题`);
    }
    if (found.length > 1) {
      return clarify(
        'taskTitle',
        `「${title}」匹配到多条任务，请让用户明确是哪一条：${found
          .map((t) => `《${truncate(t.title, 30)}》（${t.project.name}·${t.assignee?.name ?? '未指派'}）`)
          .join('；')}`,
      );
    }
    const t = found[0];
    // 员工档只能动自己名下的任务；管理者档（含项目负责人）可以动本项目组员的任务
    if (tier === 'member' && t.assigneeId !== me.id) return clarify('permission', '你只能调整指派给自己的任务，组员的事请找项目负责人');
    const sp = scope.projects.find((p: any) => p.id === t.project.id);
    if (sp && !(await this.canSeeProject(me, sp))) return clarify('permission', `「${t.project.name}」是保密项目，你未签保密协议`);
    // 动别人名下的任务：提前按 tasks.update 的同一条件预检（我是该项目负责人或成员），
    // 否则会出现“卡片出来了、点确认却被接口挡掉”这种尴尬（部门负责人可见≠可改，这里以可改为准）
    if (t.assigneeId !== me.id && me.role !== Role.ADMIN) {
      const proj = await this.prisma.project.findUnique({
        where: { id: t.project.id },
        select: { ownerId: true, confidential: true, members: { select: { userId: true } }, ndaSigns: { select: { userId: true } } },
      });
      const canWrite =
        !!proj &&
        (proj.ownerId === me.id || proj.members.some((m) => m.userId === me.id)) &&
        (!proj.confidential || proj.ndaSigns.some((s) => s.userId === me.id));
      if (!canWrite) return clarify('permission', `你不是「${t.project.name}」的负责人或成员，改不了 ${t.assignee?.name ?? '该成员'} 名下的任务`);
    }

    const patch: Partial<{ status: string; dueDate: string | null; priority: string }> = {};
    const changes: { k: string; from: string; to: string }[] = [];
    const status = String(action?.status ?? '').toUpperCase();
    if (status) {
      if (!['TODO', 'IN_PROGRESS', 'DONE'].includes(status)) return clarify('status', `状态只能是未开始/进行中/已完成，收到的是「${action?.status}」`);
      if (status === t.status) {
        return clarify('status', `《${truncate(t.title, 24)}》已经是「${STATUS_CN[status]}」了，无需修改`);
      }
      patch.status = status;
      changes.push({ k: '状态', from: STATUS_CN[t.status], to: STATUS_CN[status] });
    }
    // dueDate：给 ISO 时间串=改期；显式给 null / "clear" =清除截止时间
    const dueRaw = action?.dueDate;
    const wantClear = dueRaw === null || String(dueRaw).trim().toLowerCase() === 'clear' || action?.clearDue === true;
    if (wantClear) {
      if (!t.dueDate) return clarify('dueDate', `《${truncate(t.title, 24)}》本来就没有截止时间`);
      patch.dueDate = null;
      changes.push({ k: '截止', from: fmtBeijing(t.dueDate).slice(0, 16), to: '清除（不再按时提醒）' });
    } else if (dueRaw !== undefined && String(dueRaw).trim()) {
      const d = new Date(String(dueRaw));
      if (Number.isNaN(d.getTime())) return clarify('dueDate', `截止时间没看懂（「${dueRaw}」），请给具体日期，如 2026-11-06T18:00`);
      patch.dueDate = d.toISOString();
      changes.push({ k: '截止', from: t.dueDate ? fmtBeijing(t.dueDate).slice(0, 16) : '未设置', to: fmtBeijing(d).slice(0, 16) });
    }
    const prio = String(action?.priority ?? '').toUpperCase();
    if (prio) {
      if (!['LOW', 'MEDIUM', 'HIGH', 'URGENT'].includes(prio)) return clarify('priority', `优先级只能是 LOW/MEDIUM/HIGH/URGENT`);
      patch.priority = prio;
      changes.push({ k: '优先级', from: t.priority, to: prio });
    }
    if (!changes.length) return clarify('changes', '还没说要改什么：状态（已完成/进行中）、截止时间还是优先级？');
    const forOthers = t.assigneeId !== me.id;
    return {
      kind: 'TASK_PATCH',
      taskId: t.id,
      patch,
      taskTitle: t.title,
      projectName: t.project.name,
      projectArchived: !!t.project.archived,
      assigneeName: t.assignee?.name ?? '未指派',
      forOthers,
      changes,
      label: `调整任务《${truncate(t.title, 30)}》${forOthers ? `（${t.assignee?.name ?? '未指派'}）` : ''}：${changes.map((c) => `${c.k}→${c.to}`).join('，')}`,
      note: [status === 'DONE' ? '标记完成后系统会记进度 100%、写活动记录并同步看板' : '', forOthers ? '你以负责人身份调整组员的任务，改动会写进该任务的活动记录' : ''].filter(Boolean).join('；') || null,
    };
  }

  /** 逾期催办计划：后端实时重扫（防幻觉）；硬规则「分人分群」——每个项目群只收到自己绑定项目内成员的逾期名单 */
  private async planOverdueChase(me: CurrentUserPayload, scope: any, action: any) {
    const chosen: any[] = [];
    for (const gn of Array.isArray(action?.groupNames) ? action.groupNames : []) {
      const g = this.resolveGroup(scope, gn);
      if (g instanceof Error) continue;
      if (!chosen.some((c) => c.conversationId === g.conversationId)) chosen.push(g);
    }
    if (!chosen.length) {
      return {
        kind: 'OVERDUE_CHASE',
        needClarify: 'groupNames',
        reason: `没在你的可见项目绑定群清单里找到目标群；可选群：${scope.groups.map((g: any) => g.groupName).join('、') || '（无）'}`,
      };
    }
    let items = (await this.scanOverdue(me, scope)).filter((t) => t.who !== '未指派');
    const asked: string[] = Array.from(new Set((Array.isArray(action?.names) ? action.names : []).map((x) => String(x ?? '').trim()).filter(Boolean)));
    if (asked.length) {
      items = items.filter((t) => asked.some((q) => normName(t.who) === normName(q) || normName(t.who).includes(normName(q))));
    }
    if (!items.length) {
      return { kind: 'OVERDUE_CHASE', needClarify: 'none', reason: asked.length ? `这些人当前没有逾期任务：${asked.join('、')}` : '可见范围内没有已指派的逾期任务，无需催办' };
    }
    // 分群拆分：群绑定的项目 id 命中才入该群名单；同一人多项目逾期时，各群只看到自己项目的条目
    const groupPlans = chosen.map((g: any) => {
      const gItems = items.filter((t) => (g.projectIds ?? []).includes(t.projectId)).slice(0, 20);
      return {
        conversationId: g.conversationId,
        groupName: g.groupName,
        projectNames: g.projectNames ?? [],
        items: gItems,
        people: [...new Set(gItems.map((t) => t.who))],
        text: this.composeOverdueText(me.name, gItems),
      };
    });
    const withRoster = groupPlans.filter((p) => p.items.length);
    if (!withRoster.length) {
      return { kind: 'OVERDUE_CHASE', needClarify: 'none', reason: '所选群里没有命中逾期成员（逾期任务属于其它项目），请改选对应项目群或发个人提醒' };
    }
    return {
      kind: 'OVERDUE_CHASE',
      items: items.slice(0, 20),
      groupIds: withRoster.map((p) => p.conversationId),
      groupNames: withRoster.map((p) => p.groupName),
      groupPlans,
      skippedEmpty: groupPlans.filter((p) => !p.items.length).map((p) => p.groupName),
      label: `分群催办：${withRoster.map((p) => `${p.groupName}（${p.people.join('、') || '无'}）`).join('；')}`,
    };
  }

  /** 逾期催办群文案：标题 + 每人一行（姓名·项目·任务·逾期天数 + 该任务可点击深链）+ 入口 */
  private composeOverdueText(byName: string, items: any[]): string {
    const lines = items.map((t, i) => {
      const link = t.taskId ? webLink(`/tasks?open=${t.taskId}`) : webLink('/tasks');
      return `${i + 1}. ${t.who} · ${t.project} · ${t.task} · ${t.due} 到期，逾期 ${t.days} 天\n   处理：${link}`;
    });
    return [
      `【逾期任务催办】（${fmtBeijingDate(new Date())} 统计，由 ${byName} 发出）`,
      ...lines,
      '',
      `点上面的链接直接打开任务处理；全部待办：${webLink('/tasks')}`,
      '请尽快推进以上任务，完成后到系统更新任务状态。—— 来自 MyOrgniz 团队协作系统',
    ].join('\n');
  }

  /** 统一通知下发：正文卡片逐字呈现；硬规则「分人分群」——支持 groupContents 按群差异化文案（每群只发与其成员相关的内容） */
  private planNotify(me: CurrentUserPayload, scope: any, action: any) {
    const content = String(action?.content ?? '').trim().slice(0, 2000);
    const groupIds: string[] = [];
    const groupNames: string[] = [];
    const personIds: string[] = [];
    const personNames: string[] = [];
    const unknown: string[] = [];
    // 分群文案：[{groupName, content}]，命中群用各自文案；未覆盖的群/个人用主 content
    const groupContents: { conversationId: string; groupName: string; content: string }[] = [];
    for (const gc of Array.isArray(action?.groupContents) ? action.groupContents : []) {
      const g = this.resolveGroup(scope, gc?.groupName);
      const text = String(gc?.content ?? '').trim().slice(0, 2000);
      if (g instanceof Error || !text) {
        unknown.push(g instanceof Error ? String(gc?.groupName) : text ? '' : gc?.groupName ?? '');
        continue;
      }
      groupContents.push({ conversationId: g.conversationId, groupName: g.groupName, content: text });
      if (!groupIds.includes(g.conversationId)) {
        groupIds.push(g.conversationId);
        groupNames.push(g.groupName);
      }
    }
    for (const gn of Array.isArray(action?.groupNames) ? action.groupNames : []) {
      const g = this.resolveGroup(scope, gn);
      if (g instanceof Error) {
        unknown.push(String(gn));
        continue;
      }
      if (!groupIds.includes(g.conversationId)) {
        groupIds.push(g.conversationId);
        groupNames.push(g.groupName);
      }
    }
    for (const pn of Array.isArray(action?.personNames) ? action.personNames : []) {
      const hit = this.matchOne(scope.members, (u: any) => u.name, pn);
      if (hit instanceof Error) {
        unknown.push(String(pn));
        continue;
      }
      if (!personIds.includes(hit.id)) {
        personIds.push(hit.id);
        personNames.push(hit.name);
      }
    }
    if (unknown.filter(Boolean).length) return { kind: 'NOTIFY_BROADCAST', needClarify: 'targets', reason: `这些目标我没在可见范围内找到：${unknown.filter(Boolean).join('、')}，请确认群名/人名` };
    if (!groupIds.length && !personIds.length) return { kind: 'NOTIFY_BROADCAST', needClarify: 'targets', reason: '没有指定通知目标，请问用户发到哪些群、通知哪些人' };
    if (personIds.length && !content) return { kind: 'NOTIFY_BROADCAST', needClarify: 'content', reason: '通知具体个人需要一段完整正文（content），请补充' };
    if (!personIds.length && !content && !groupContents.length) return { kind: 'NOTIFY_BROADCAST', needClarify: 'content', reason: '通知正文为空，请让用户补充要通知什么' };
    return {
      kind: 'NOTIFY_BROADCAST',
      content: content || null,
      groupIds,
      groupNames,
      groupContents,
      personIds,
      personNames,
      label: `发通知到：${[...groupNames.map((n) => `群·${n}`), ...personNames.map((n) => `人·${n}`)].join('、')}`,
    };
  }

  /**
   * 日报提交计划：整理稿即提交稿；同日重复提交会追加合并（现有 submitDaily 逻辑），卡片上提示
   * - 工时是必填项：模型从用户话里抽到（action.hours）就带上；抽不到先追问，不生成可提交卡片
   * - 追问态仍带回 rawContent，前端让用户只补一个数字就能提交，不用把日报重说一遍
   */
  private async planDaily(me: CurrentUserPayload, action: any) {
    const rawContent = String(action?.content ?? '').trim().slice(0, 6000);
    if (!rawContent) return { kind: 'DAILY_SUBMIT', needClarify: 'content', reason: '日报正文为空，请让用户口述今天完成了什么' };
    const CN = 8 * 3600 * 1000;
    const bj = new Date(Date.now() + CN);
    const dayStart = new Date(Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth(), bj.getUTCDate()) - CN);
    const existed = await this.prisma.report.count({ where: { ownerId: me.id, type: 'DAILY', periodStart: { gte: dayStart } } });
    const label = existed > 0 ? '提交今日日报（今天已交过，本次将追加合并并重新整理）' : '提交今日日报';
    const hours = normalizeHours(action?.hours);
    if (hours === null) {
      return {
        kind: 'DAILY_SUBMIT',
        needClarify: 'hours',
        reason: '还差今天的工作时长：今天一共工作了多少个小时？（例如「8 小时」；确实没有投入就说 0）',
        rawContent,
        hours: null,
        appendedMerge: existed > 0,
        label,
      };
    }
    return {
      kind: 'DAILY_SUBMIT',
      rawContent,
      hours,
      appendedMerge: existed > 0,
      label,
    };
  }

  /** 周报口述提交计划：归属后端解析（项目/部门/个人），可选随发群；确认后前端调现有 submitWeekly */
  private async planWeekly(me: CurrentUserPayload, scope: any, action: any) {
    const rawContent = String(action?.content ?? '').trim().slice(0, 8000);
    if (!rawContent) return { kind: 'WEEKLY_SUBMIT', needClarify: 'content', reason: '周报正文为空，请让用户补充本周工作内容' };
    let projectId: string | null = null;
    let departmentId: string | null = null;
    let scopeLabel = '个人周报';
    if (action?.projectName) {
      const p = this.resolveProject(scope, action.projectName);
      if (p instanceof Error) return { kind: 'WEEKLY_SUBMIT', needClarify: 'projectName', reason: p.message };
      projectId = p.id;
      scopeLabel = `项目·${p.name} 周报`;
    } else if (action?.departmentName) {
      const user = await this.prisma.user.findUnique({
        where: { id: me.id },
        select: { departmentId: true, department: { select: { id: true, name: true } }, extraDepartments: { select: { id: true, name: true } } },
      });
      const deptMap = [...(user?.departmentId ? [{ id: user.departmentId, name: user.department?.name ?? '' }] : []), ...(user?.extraDepartments ?? []).map((d) => ({ id: d.id, name: d.name }))];
      const hit = this.matchOne(deptMap, (d) => d.name, action.departmentName);
      if (hit instanceof Error) return { kind: 'WEEKLY_SUBMIT', needClarify: 'departmentName', reason: hit.message };
      departmentId = hit.id;
      scopeLabel = `部门·${hit.name} 周报`;
    }
    const groupIds: string[] = [];
    const groupNames: string[] = [];
    for (const gn of Array.isArray(action?.groupNames) ? action.groupNames : []) {
      const g = this.resolveGroup(scope, gn);
      if (g instanceof Error) continue;
      if (!groupIds.includes(g.conversationId)) {
        groupIds.push(g.conversationId);
        groupNames.push(g.groupName);
      }
    }
    const base = action?.periodStart ? new Date(String(action.periodStart)) : new Date();
    const monday = beijingMondayOf(Number.isNaN(base.getTime()) ? new Date() : base);
    return {
      kind: 'WEEKLY_SUBMIT',
      rawContent,
      periodStart: beijingMondayDate(monday),
      periodStartIso: monday.toISOString(),
      projectId,
      departmentId,
      scopeLabel,
      groupIds,
      groupNames,
      label: `提交${scopeLabel}（${beijingMondayDate(monday)} 周）${groupNames.length ? `并发到：${groupNames.join('、')}` : ''}`,
    };
  }

  // ---- 我的工作时间安排（WORK_SCHEDULE_SET）----

  /** 单个周几说法 → 0~6（0=周一）：支持 周三 / 周3 / 星期三 / 3 */
  private dayTokenToIndex(s: unknown): number | null {
    const t = String(s ?? '').trim();
    if (!t) return null;
    const cn = '一二三四五六日';
    const m1 = t.match(/^(?:周|星期|礼拜)([一二三四五六日天日])$/);
    if (m1) return m1[1] === '天' ? 6 : cn.indexOf(m1[1]);
    const m2 = t.match(/^(?:周|星期|礼拜)([1-7])$/);
    if (m2) return Number(m2[1]) - 1;
    const m3 = t.match(/^([1-7])$/);
    if (m3) return Number(m3[1]) - 1;
    const idx = WORK_WEEKDAY_LABELS.indexOf(t);
    if (idx >= 0) return idx;
    return null;
  }

  /** 日子说法 → 周几数组：周一到周五 / 工作日 / 周末 / 每天 / ["周三","周五"]；解不动返回 null */
  private resolveWeekdays(input: unknown): number[] | null {
    const list = Array.isArray(input) ? input : [input];
    const out = new Set<number>();
    for (const raw of list) {
      const t = String(raw ?? '').trim().replace(/\s+/g, '');
      if (!t) continue;
      if (/^(每天|全周|一周|所有天)$/.test(t)) {
        for (let i = 0; i < 7; i++) out.add(i);
        continue;
      }
      if (/^(工作日|上班日)$/.test(t)) {
        for (let i = 0; i < 5; i++) out.add(i);
        continue;
      }
      if (/^(周末|双休|六日)$/.test(t)) {
        out.add(5);
        out.add(6);
        continue;
      }
      const seg = t.split(/[,~\-到至]+/).filter(Boolean);
      if (seg.length === 2) {
        const a = this.dayTokenToIndex(seg[0]);
        const b = this.dayTokenToIndex(seg[1]);
        if (a === null || b === null) return null;
        const [lo, hi] = a <= b ? [a, b] : [b, a];
        for (let i = lo; i <= hi; i++) out.add(i);
        continue;
      }
      const one = this.dayTokenToIndex(t);
      if (one === null) return null;
      out.add(one);
    }
    return out.size ? [...out].sort((a, b) => a - b) : null;
  }

  /** '9:30' / '09:30' / '9点30分' → 自北京时间 00:00 起算的分钟数；解不动返回 null */
  private minuteOfDay(v: unknown): number | null {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
    const s = String(v).trim();
    const m = s.match(/^(\d{1,2}):(\d{2})$/) || s.match(/^(\d{1,2})[点时](\d{1,2})分?$/) || s.match(/^(\d{1,2})分?$/);
    if (!m) return null;
    const h = Number(m[1]);
    const mi = m[2] ? Number(m[2]) : 0;
    if (h > 23 || mi > 59) return null;
    return h * 60 + mi;
  }

  /** 预设时段：AM/PM/EVE 或 上午/下午/晚上（可数组、可「上午和下午」这种串）；解不动返回 null */
  private resolvePresetSegs(v: unknown): { startMin: number; endMin: number }[] | null {
    const list = Array.isArray(v) ? v : String(v ?? '').split(/[,，+和、&\/\s]+/);
    const out: { startMin: number; endMin: number }[] = [];
    for (const raw of list) {
      const t = String(raw ?? '').trim();
      if (!t) continue;
      const hit = WORK_SLOT_PRESETS.find((p) => p.key.toUpperCase() === t.toUpperCase() || p.label === t || t.startsWith(p.label) || p.range === t);
      if (!hit) return null;
      out.push({ startMin: hit.startMin, endMin: hit.endMin });
    }
    return out.length ? out : null;
  }

  /**
   * 工作时间安排计划：口述「我周一到周五上午下午」→ 整周格子
   * - 默认只替换说到的那几天，没说到的日子保持原样（mode=replace 才整周重建）
   * - 确认后前端调现有 PUT /reports/work-slots（本来就按本人收敛，不在 Agent 里再写一份保存逻辑）
   */
  private async planWorkScheduleSet(me: CurrentUserPayload, action: any) {
    const clarify = (reason: string) => ({ kind: 'WORK_SCHEDULE_SET', needClarify: 'items', reason });
    const cur = await this.workSchedule.getMine(me.id);
    const items: any[] = Array.isArray(action?.items) ? action.items : [];
    const replaceAll = action?.mode === 'replace' || action?.replaceAll === true;
    const append = action?.mode === 'append';
    if (action?.clearAll === true) {
      return {
        kind: 'WORK_SCHEDULE_SET',
        slots: [] as { weekday: number; startMin: number; endMin: number }[],
        days: WORK_WEEKDAY_LABELS.map((label, weekday) => ({ weekday, label, ranges: [] as string[], hours: 0 })),
        changedLabels: [...WORK_WEEKDAY_LABELS],
        weeklyHours: 0,
        clearedAll: true,
        label: '清空我的整周工作时间安排',
        note: '清空后这些天都不算应发日报、也不会再收到日报提醒；排班只影响提醒口径，不改工时统计',
      };
    }
    if (!items.length && !action?.clearDays) {
      return clarify('没听懂要排哪几天、什么时间（例如「周一到周五上午 10:00-12:00、下午 14:00-18:00」）');
    }
    const next = new Map<number, { startMin: number; endMin: number }[]>();
    const touched = new Set<number>();
    for (const it of items) {
      const days = this.resolveWeekdays(it?.weekdays ?? it?.days ?? it?.weekday);
      if (days === null) return clarify(`「${JSON.stringify(it)}」里的日子我没看懂，请说「周一到周五」这类说法`);
      if (it?.clear === true) {
        for (const d of days) {
          touched.add(d);
          next.set(d, []);
        }
        continue;
      }
      let segs: { startMin: number; endMin: number }[] = [];
      if (Array.isArray(it?.slots) && it.slots.length) {
        for (const s of it.slots) {
          const a = this.minuteOfDay(s?.startMin ?? s?.start);
          const b = this.minuteOfDay(s?.endMin ?? s?.end);
          if (a === null || b === null || b <= a) return clarify(`时间段「${JSON.stringify(s)}」没看懂，请用 10:00-12:00 这种写法`);
          segs.push({ startMin: a, endMin: b });
        }
      } else if (it?.start !== undefined || it?.end !== undefined) {
        const a = this.minuteOfDay(it.start);
        const b = this.minuteOfDay(it.end);
        if (a === null || b === null || b <= a) return clarify(`时间段「${it?.start ?? ''}-${it?.end ?? ''}」没看懂，请用 09:30-19:00 这种写法`);
        segs = [{ startMin: a, endMin: b }];
      } else {
        const p = this.resolvePresetSegs(it?.preset ?? it?.presets ?? it?.time ?? it?.label);
        if (!p) return clarify(`时段「${String(it?.preset ?? it?.time ?? '')}」没看懂：可选上午 10:00-12:00 / 下午 14:00-18:00 / 晚上 18:00-20:00，或直接给时间（如 09:30-19:00）`);
        segs = p;
      }
      for (const d of days) {
        touched.add(d);
        next.set(d, append ? [...(next.get(d) ?? []), ...segs] : segs);
      }
    }
    if (action?.clearDays) {
      const cs = this.resolveWeekdays(action.clearDays);
      if (cs === null) return clarify(`要清空哪几天没说清楚（「${action.clearDays}」看不懂）`);
      for (const d of cs) {
        touched.add(d);
        next.set(d, []);
      }
    }
    // 拼回整周：说过的天用新安排，没说过的保留原样（replaceAll 则直接清空重建）
    const rows: { weekday: number; startMin: number; endMin: number }[] = [];
    for (let d = 0; d < 7; d++) {
      const list = next.has(d)
        ? next.get(d)!
        : replaceAll
          ? []
          : cur.slots.filter((s: any) => s.weekday === d).map((s: any) => ({ startMin: s.startMin, endMin: s.endMin }));
      const uniq = [...new Map(list.map((s) => [`${s.startMin}-${s.endMin}`, s])).values()].sort((a, b) => a.startMin - b.startMin);
      for (let i = 1; i < uniq.length; i++) {
        if (uniq[i].startMin < uniq[i - 1].endMin) {
          return clarify(`${weekdayLabel(d)}的时间段有重叠（${slotRangeLabel(uniq[i - 1].startMin, uniq[i - 1].endMin)} 与 ${slotRangeLabel(uniq[i].startMin, uniq[i].endMin)}），请说清楚`);
        }
      }
      uniq.forEach((s) => rows.push({ weekday: d, ...s }));
    }
    const days = WORK_WEEKDAY_LABELS.map((label, weekday) => {
      const list = rows.filter((r) => r.weekday === weekday);
      return { weekday, label, ranges: list.map((r) => slotRangeLabel(r.startMin, r.endMin)), hours: slotsHours(list) };
    });
    const changedLabels = [...touched].sort((a, b) => a - b).map((d) => weekdayLabel(d));
    return {
      kind: 'WORK_SCHEDULE_SET',
      slots: rows,
      days,
      changedLabels,
      weeklyHours: slotsHours(rows),
      clearedAll: !rows.length,
      label: `设置我的工作时间：${days.filter((x) => x.ranges.length).map((x) => `${x.label}${x.ranges.join('/')}`).join('、') || '整周不排班'}`,
      note: '保存是整周覆盖：上面就是改完后的一整周；没排班的那天不算应发日报、也不会收到日报提醒',
    };
  }

  /**
   * 今日「应发日报但还没写」名单
   * 应发口径与后台 report-reminder.service 完全一致：当天（北京周几）至多排了一个工作时间段才算应发，
   * 没排班的人（含从没去填过安排的人）一律不进名单，避免助手比系统本人提醒多打扰人
   */
  private async scanDailyMissing(rosterIds: string[]) {
    const now = new Date();
    const weekday = this.workSchedule.bjWeekday(now);
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);
    const [planned, wrote] = await Promise.all([
      this.workSchedule.plannedOn(rosterIds, weekday),
      this.prisma.report.findMany({
        where: { type: 'DAILY', ownerId: { in: rosterIds }, periodStart: { gte: todayStart, lt: new Date(todayStart.getTime() + 86400000) } },
        select: { ownerId: true },
      }),
    ]);
    const wroteSet = new Set(wrote.map((r) => r.ownerId).filter(Boolean) as string[]);
    const users = rosterIds.length ? await this.prisma.user.findMany({ where: { id: { in: rosterIds } }, select: { id: true, name: true } }) : [];
    const nameById = new Map(users.map((u) => [u.id, u.name]));
    const plannedIds = [...planned.keys()];
    const missing = plannedIds
      .filter((id) => !wroteSet.has(id))
      .map((id) => ({ userId: id, name: nameById.get(id) ?? '未知成员', ranges: (planned.get(id) ?? []).map((s) => slotRangeLabel(s.startMin, s.endMin)) }));
    return {
      date: fmtBeijingDate(now),
      weekday,
      weekdayName: weekdayLabel(weekday),
      rosterCount: rosterIds.length,
      plannedCount: plannedIds.length,
      noPlanCount: rosterIds.length - plannedIds.length,
      wroteCount: plannedIds.filter((id) => wroteSet.has(id)).length,
      missing,
    };
  }

  /** 日报催办的名单范围：点名项目=该项目名册；项目负责人=自己负责项目成员；部门负责人=可见成员；管理员=全部在职 */
  private async dailyChaseRoster(me: CurrentUserPayload, scope: any, projectName: string) {
    if (projectName) {
      const p = this.resolveProject(scope, projectName);
      if (p instanceof Error) return { error: p.message };
      if (!(await this.canSeeProject(me, p))) return { error: `无权查看项目「${p.name}」的日报情况` };
      const proj = await this.prisma.project.findUnique({
        where: { id: p.id },
        select: { id: true, name: true, ownerId: true, members: { select: { userId: true } } },
      });
      if (!proj) return { error: '项目不存在或已删除' };
      return { ids: [...new Set([proj.ownerId, ...proj.members.map((m) => m.userId)])], scopeLabel: `项目·${proj.name}` };
    }
    const vis = await this.reports.visibleOwnerIds(me);
    if (vis.all) {
      const users = await this.prisma.user.findMany({ where: { active: true }, select: { id: true } });
      return { ids: users.map((u) => u.id), scopeLabel: '公司全员' };
    }
    return { ids: vis.ids, scopeLabel: me.role === Role.DEPT_LEADER ? '我可见的成员' : '我项目的成员' };
  }

  /** 人 → 他所属（或负责）的可见项目 id：用来把催办名单拆到各自项目群（分人分群硬规则） */
  private async personProjectMap(scope: any) {
    const ids = (scope.projects as any[]).map((p) => p.id);
    const m = new Map<string, string[]>();
    if (!ids.length) return m;
    const rows = await this.prisma.project.findMany({
      where: { id: { in: ids } },
      select: { id: true, ownerId: true, members: { select: { userId: true } } },
    });
    const add = (uid: string, pid: string) => {
      const a = m.get(uid) ?? [];
      if (!a.includes(pid)) a.push(pid);
      m.set(uid, a);
    };
    for (const p of rows) {
      add(p.ownerId, p.id);
      for (const mm of p.members) add(mm.userId, p.id);
    }
    return m;
  }

  /** 日报催办群文案：逐人点名 + 他今天本来要上班的时间段 + 直达填写入口 */
  private composeDailyText(byName: string, scan: { date: string; weekdayName: string }, people: { name: string; ranges: string[] }[]): string {
    const lines = people.map((p, i) => `${i + 1}. ${p.name}${p.ranges.length ? `（今日安排：${p.ranges.join('、')}）` : ''}`);
    return [
      `📝 日报提醒（${scan.date} ${scan.weekdayName}，由 ${byName} 发出）`,
      '下面几位今天排了工作时间但日报还没交，请尽快补写：',
      ...lines,
      '',
      `填写入口：${webLink('/reports')}`,
      '—— 来自 MyOrgniz 团队协作系统',
    ].join('\n');
  }

  /** 按「分人分群」把缺交名单拆到各群：每群只点自己项目成员的名；盖不到群的人只走站内信 */
  private buildDailyGroupPlans(
    scope: any,
    missing: { userId: string; name: string; ranges: string[] }[],
    personProj: Map<string, string[]>,
    me: CurrentUserPayload,
    scan: { date: string; weekdayName: string },
    onlyGroupIds?: string[],
  ) {
    // 公司群默认不自动带上（否则全公司名单会重复刷到大群），用户点名要发公司群时才通过 onlyGroupIds 进来
    const cands = onlyGroupIds?.length
      ? scope.groups.filter((g: any) => onlyGroupIds.includes(g.conversationId))
      : scope.groups.filter((g: any) => !g.isCompany);
    const plans = (cands as any[]).map((g) => {
      const gp = (g.projectIds ?? []) as string[];
      const people = missing.filter((x) => (personProj.get(x.userId) ?? []).some((pid) => gp.includes(pid)));
      return {
        conversationId: g.conversationId,
        groupName: g.groupName,
        people: people.map((p) => p.name),
        items: people,
        text: this.composeDailyText(me.name, scan, people),
      };
    });
    const withRoster = plans.filter((p) => p.items.length);
    const covered = new Set(withRoster.flatMap((p) => p.items.map((i) => i.userId)));
    return { groupPlans: withRoster, solo: missing.filter((x) => !covered.has(x.userId)) };
  }

  /** 催今日日报计划：没排班的人根本不算应发（不报进名单也不打扰），发送前还会重扫一次 */
  private async planDailyChase(me: CurrentUserPayload, scope: any, action: any) {
    const clarify = (field: string, reason: string) => ({ kind: 'DAILY_CHASE', needClarify: field, reason });
    const projectName = String(action?.projectName ?? '').trim();
    const roster = await this.dailyChaseRoster(me, scope, projectName);
    if ((roster as any).error) return clarify('projectName', (roster as any).error);
    const scan = await this.scanDailyMissing((roster as any).ids);
    if (!scan.plannedCount) {
      return clarify('none', `${scan.date}（${scan.weekdayName}）${(roster as any).scopeLabel}里没一个人排了工作时间——按口径今天都不算应发日报，不能催`);
    }
    if (!scan.missing.length) {
      return clarify('none', `${scan.date}（${scan.weekdayName}）${(roster as any).scopeLabel}：应发 ${scan.plannedCount} 人已全部交完，今天不用催`);
    }
    const personProj = await this.personProjectMap(scope);
    const wanted: string[] = [];
    for (const gn of Array.isArray(action?.groupNames) ? action.groupNames : []) {
      const g = this.resolveGroup(scope, gn);
      if (g instanceof Error) continue;
      if (!wanted.includes(g.conversationId)) wanted.push(g.conversationId);
    }
    const { groupPlans, solo } = this.buildDailyGroupPlans(scope, scan.missing, personProj, me, scan, wanted.length ? wanted : undefined);
    return {
      kind: 'DAILY_CHASE',
      date: scan.date,
      weekdayName: scan.weekdayName,
      scopeLabel: (roster as any).scopeLabel,
      plannedCount: scan.plannedCount,
      wroteCount: scan.wroteCount,
      noPlanCount: scan.noPlanCount,
      missingCount: scan.missing.length,
      missingNames: scan.missing.map((m) => m.name),
      groupIds: groupPlans.map((p) => p.conversationId),
      groupNames: groupPlans.map((p) => p.groupName),
      groupPlans,
      soloNames: solo.map((s) => s.name),
      personIds: scan.missing.map((m) => m.userId),
      personNames: scan.missing.map((m) => m.name),
      label: `催 ${scan.missing.length} 人交今日日报：${groupPlans.map((p) => `${p.groupName}点名 ${p.people.length} 人`).join('；') || '无对应项目群'}${solo.length ? `；${solo.length} 人只发站内信` : ''}`,
      note: `没排班的不算应发（${scan.noPlanCount} 人今天不被打扰）；站内信会给全部 ${scan.missing.length} 人，发送前系统重扫一遍`,
    };
  }

  /**
   * 风险项目快照：默认只取 AI 判定 RED（高风险），includeAttention=true 时把 YELLOW（需关注）也算进来
   * 只从 scope.projects 里取（本身就是可见范围），保密项目再过 canSeeProject 一道 NDA 门槛
   */
  private async scanRiskProjects(me: CurrentUserPayload, scope: any, opts: { includeAttention?: boolean; projectNames?: string[] } = {}) {
    const cands = (scope.projects as any[]).filter((p) => !p.archived);
    const ids = cands.map((p) => p.id);
    if (!ids.length) return [] as any[];
    const rows = await this.prisma.project.findMany({
      where: { id: { in: ids }, healthLevel: opts.includeAttention ? { in: ['RED', 'YELLOW'] } : 'RED' },
      select: {
        id: true, name: true, healthLevel: true, healthPercent: true, healthSummary: true, healthRisks: true,
        ownerId: true, dingtalkConversationId: true, dingtalkGroupName: true,
      },
    });
    let out = rows;
    if (opts.projectNames?.length) {
      const want = opts.projectNames.map((n) => normName(n));
      out = out.filter((p) => want.some((n) => normName(p.name).includes(n) || n.includes(normName(p.name))));
    }
    const visible: any[] = [];
    for (const p of out) {
      if (await this.canSeeProject(me, p)) visible.push(p);
    }
    return visible.sort((a, b) => (a.healthPercent ?? 100) - (b.healthPercent ?? 100));
  }

  /** 风险提醒文案：逐项目一行（等级 + 健康度 + 首要风险）+ 项目页入口 */
  private composeRiskText(byName: string, date: string, mine: any[]): string {
    const lines = mine.map((p, i) => {
      const lv = p.healthLevel === 'RED' ? '高风险' : '需关注';
      const hp = p.healthPercent === null || p.healthPercent === undefined ? '' : `，健康度 ${p.healthPercent}%`;
      const risk = String(p.healthRisks ?? '').split('\n').map((x) => x.trim()).filter(Boolean)[0];
      return `${i + 1}. ${p.name}（${lv}${hp}）${risk ? `：${truncate(risk, 60)}` : ''}`;
    });
    return [
      `⚠️ 风险项目提醒（${date}，由 ${byName} 发出）`,
      '你负责的这些项目被系统判为有风险，请尽快看看进展与安排：',
      ...lines,
      '',
      `去项目页更新进展/安排任务：${webLink('/projects')}`,
      '—— 来自 MyOrgniz 团队协作系统',
    ].join('\n');
  }

  /**
   * 风险项目→对应负责人提醒计划（管理员/部门负责人专属）
   * project_risks 结果按项目负责人分组：一张卡看清楚「几位负责人、几个项目」，每个负责人只收到自己那几个项目
   */
  private async planRiskAlert(me: CurrentUserPayload, scope: any, action: any) {
    const clarify = (field: string, reason: string) => ({ kind: 'RISK_ALERT', needClarify: field, reason });
    if (me.role !== Role.ADMIN && me.role !== Role.DEPT_LEADER) {
      return clarify('permission', '风险项目提醒只对管理员/部门负责人开放；你是项目负责人，直接说「我项目最近有什么风险」就行');
    }
    const includeAttention = action?.includeAttention === true || String(action?.level ?? '').toUpperCase() === 'YELLOW';
    const names = Array.isArray(action?.projectNames) ? action.projectNames.map((x: unknown) => String(x)) : [];
    const rows = await this.scanRiskProjects(me, scope, { includeAttention, projectNames: names });
    if (!rows.length) {
      return clarify('none', includeAttention ? '可见范围里没有「高风险/需关注」的项目，无需提醒' : '可见范围里没有 AI 判定高风险的项目；要把「需关注」的也提一提，说“需关注的项目也提醒”');
    }
    const leaderIds = [...new Set(rows.map((p: any) => p.ownerId))];
    const users = await this.prisma.user.findMany({ where: { id: { in: leaderIds }, active: true }, select: { id: true, name: true } });
    const nameById = new Map(users.map((u) => [u.id, u.name]));
    const groupById = new Map<string, any>((scope.groups as any[]).map((g) => [g.conversationId, g]));
    const leaders = leaderIds
      .map((id) => {
        const mine = rows.filter((p: any) => p.ownerId === id);
        const gIds = [...new Set(mine.map((p: any) => p.dingtalkConversationId).filter(Boolean))] as string[];
        return {
          userId: id,
          name: nameById.get(id) ?? '',
          projectNames: mine.map((p: any) => p.name),
          projectCount: mine.length,
          groupIds: gIds,
          groupNames: gIds.map((cid) => groupById.get(cid)?.groupName ?? '').filter(Boolean),
          text: this.composeRiskText(me.name, fmtBeijingDate(new Date()), mine),
        };
      })
      .filter((l) => l.name);
    if (!leaders.length) return clarify('none', '这些风险项目的负责人当前不在职，发不了提醒');
    const noGroup = leaders.filter((l) => !l.groupIds.length);
    return {
      kind: 'RISK_ALERT',
      date: fmtBeijingDate(new Date()),
      includeAttention,
      projectCount: rows.length,
      leaderCount: leaders.length,
      items: rows.map((p: any) => ({
        project: p.name,
        level: p.healthLevel === 'RED' ? '高风险' : '需关注',
        healthPercent: p.healthPercent ?? null,
        topRisk: String(p.healthRisks ?? '').split('\n').map((x) => x.trim()).filter(Boolean)[0] ?? null,
        leader: nameById.get(p.ownerId) ?? '（不在职）',
        group: p.dingtalkGroupName ?? null,
      })),
      leaders,
      personIds: leaders.map((l) => l.userId),
      groupIds: [...new Set(leaders.flatMap((l) => l.groupIds))],
      groupNames: [...new Set(leaders.flatMap((l) => l.groupNames))],
      label: `提醒 ${leaders.length} 位负责人处理 ${rows.length} 个风险项目：${leaders.map((l) => `${l.name}（${l.projectNames.join('、')}）`).join('；')}`,
      note: `每位负责人只收到自己那几个项目；项目群能对上就同时发群${noGroup.length ? `，${noGroup.map((l) => l.name).join('、')}没有绑定项目群、只发站内信` : ''}`,
    };
  }

  /** 催交执行：服务端重扫缺交名单，只对「仍缺交」的人发站内信（幂等防幻觉） */
  async chaseWeekly(me: CurrentUserPayload, payload: { periodStart?: string; names?: string[] }) {
    await this.assertManager(me);
    const agg = await this.reports.weeklyAggregate(me, { periodStart: payload?.periodStart });
    const missing = agg.sections.filter((s: any) => !s.submitted);
    const asked: string[] = Array.from(new Set((payload?.names ?? []).map((x) => String(x ?? '').trim()).filter(Boolean)));
    const targets = missing.filter((m: any) => !asked.length || asked.some((q) => normName(m.name) === normName(q) || normName(m.name).includes(normName(q))));
    if (!targets.length) return { ok: true, chased: [], skipped: true, reason: '对方本周已不再缺交，无需催办' };
    await this.notifications.createMany((targets as any[]).map((t) => t.userId), {
      type: 'SYSTEM',
      title: `请尽快补交本周周报（${agg.weekLabel}）`,
      content: `${me.name} 通过管理助手提醒你提交本周周报，请到「周报」页撰写发布。`,
      link: '/reports',
    });
    this.logger.log(`Agent 催交周报 by=${me.name} week=${agg.weekDate} targets=${(targets as any[]).map((t) => t.name).join('、')}`);
    return { ok: true, chased: (targets as any[]).map((t) => t.name), skipped: false };
  }

  /** 周报发群执行（确认后）：把已存在的本周某归属周报原文再发一次到指定群（不修改记录） */
  async weeklyToGroup(me: CurrentUserPayload, payload: { periodStart?: string; scopeKey?: string; groupIds?: string[] }) {
    await this.assertManager(me);
    const ids = Array.from(new Set((payload?.groupIds ?? []).map((s) => String(s ?? '').trim()).filter(Boolean)));
    if (!ids.length) throw new BadRequestException('请至少选择一个发送群');
    const base = payload?.periodStart ? new Date(payload.periodStart) : new Date();
    const monday = beijingMondayOf(Number.isNaN(base.getTime()) ? new Date() : base);
    const scopeKey = String(payload?.scopeKey ?? '');
    const r = await this.reports.resendWeeklyToGroups(me.id, monday, scopeKey, ids);
    const failed = ((r.groups ?? []) as any[]).filter((g) => g && g.ok === false);
    this.logger.log(`Agent 周报发群 by=${me.name} week=${beijingMondayDate(monday)} groups=${ids.length} failed=${failed.length}`);
    return { ok: true, sent: (r.groups ?? []).length - failed.length, failed: failed.map((g) => g.groupName ?? g.conversationId), groups: r.groups };
  }

  // ---- 动作执行（卡片确认后由前端调用；服务端二次校验权限，与 chase-weekly 同款直连模式） ----

  /** 任务下发执行：逐条创建（复用 TasksService.create 的看板落位/活动记录），成功后给被指派人推站内信+钉钉私聊 */
  async createTasks(me: CurrentUserPayload, payload: { tasks?: any[] }) {
    await this.assertManager(me);
    const list = Array.isArray(payload?.tasks) ? payload.tasks.slice(0, 10) : [];
    if (!list.length) throw new BadRequestException('没有要创建的任务');
    const scope = await this.buildScope(me);
    const results: { ok: boolean; id?: string; title: string; assigneeName?: string | null; error?: string }[] = [];
    let notified = 0;
    for (const t of list) {
      const title = truncate(String(t?.title ?? ''), 60);
      const project = scope.projects.find((p: any) => p.id === String(t?.projectId ?? ''));
      if (!title || !project) {
        results.push({ ok: false, title: title || '（缺标题）', error: '项目不存在或不在你的可见范围' });
        continue;
      }
      const assigneeId = t?.assigneeId ? String(t.assigneeId) : null;
      if (assigneeId) {
        const isOwner = project.ownerId === assigneeId;
        const member = await this.prisma.projectMember.findUnique({ where: { projectId_userId: { projectId: project.id, userId: assigneeId } }, select: { userId: true } });
        if (!isOwner && !member) {
          results.push({ ok: false, title, error: `指派对象不是项目「${project.name}」的成员` });
          continue;
        }
      }
      try {
        const task = await this.tasks.create({ id: me.id, role: me.role }, {
          projectId: project.id,
          title: String(t.title).trim(),
          description: t?.description ? String(t.description) : undefined,
          priority: t?.priority ? String(t.priority) : undefined,
          assigneeId: assigneeId ?? undefined,
          dueDate: t?.dueDate ? String(t.dueDate) : null,
        });
        results.push({ ok: true, id: task.id, title: task.title, assigneeName: t?.assigneeName ?? null });
        // 通知被指派人：站内信 + 钉钉私聊双通道；任一失败不阻断任务创建成功
        if (assigneeId) {
          const dueLabel = task.dueDate ? fmtBeijingDate(task.dueDate) : null;
          const nm = await this.prisma.user.findUnique({ where: { id: assigneeId }, select: { id: true, name: true, phone: true } });
          if (nm) {
            const inboxText = `${me.name} 通过管理助手给你指派了任务，项目：${project.name}${dueLabel ? `，截止 ${dueLabel}` : ''}。请及时确认并开始推进。`;
            let inboxOk = false;
            try {
              await this.notifications.createMany([nm.id], { type: 'SYSTEM', title: `新任务：${truncate(task.title, 40)}`, content: inboxText, link: '/tasks' });
              inboxOk = true;
            } catch (e: any) {
              this.logger.warn(`Agent 建任务站内信失败 task=${task.id}: ${e?.message ?? e}`);
            }
            try {
              await this.dm.notifyUser(nm, `【新任务】${task.title}\n项目：${project.name}${dueLabel ? `\n截止：${dueLabel}` : ''}\n${inboxText}`);
            } catch (e: any) {
              this.logger.warn(`Agent 建任务钉钉私聊失败 task=${task.id}: ${e?.message ?? e}`);
            }
            if (inboxOk) notified++;
          }
        }
      } catch (e: any) {
        results.push({ ok: false, title, error: String(e?.message ?? e).slice(0, 120) });
      }
    }
    const created = results.filter((r) => r.ok).length;
    this.logger.log(`Agent 任务下发 by=${me.name} created=${created}/${list.length} notified=${notified}`);
    if (!created) throw new BadRequestException(results.find((r) => r.error)?.error ?? '任务创建失败');
    return { ok: true, created, notified, tasks: results };
  }

  /** 逾期催办执行：重扫仍逾期且已指派的任务，按「分人分群」硬规则每个群只发自己项目成员的名单（防确认延迟期间状态变化/防文案篡改） */
  async chaseOverdue(me: CurrentUserPayload, payload: { groupIds?: string[]; names?: string[] }) {
    await this.assertManager(me);
    const scope = await this.buildScope(me);
    const ids = Array.from(new Set((payload?.groupIds ?? []).map((s) => String(s ?? '').trim()).filter(Boolean)));
    if (!ids.length) throw new BadRequestException('请至少选择一个发送群');
    const groupById = new Map<any, any>(scope.groups.map((g: any) => [g.conversationId, g]));
    const allowed = ids.filter((cid) => groupById.has(cid));
    if (!allowed.length) throw new ForbiddenException('所选群不在你的可见范围');
    let items = (await this.scanOverdue(me, scope)).filter((t) => t.who !== '未指派');
    const asked = Array.from(new Set((payload?.names ?? []).map((x) => String(x ?? '').trim()).filter(Boolean)));
    if (asked.length) items = items.filter((t) => asked.some((q) => normName(t.who) === normName(q) || normName(t.who).includes(normName(q))));
    if (!items.length) return { ok: true, sent: 0, skipped: true, reason: '这些人当前已不再逾期，无需催办' };
    const out: { conversationId: string; groupName: string; ok: boolean; people: string[]; error?: string }[] = [];
    for (const cid of allowed) {
      const g = groupById.get(cid);
      // 硬规则：只给该群发自己绑定项目内成员的逾期名单；无命中则跳过不发
      const gItems = items.filter((t) => ((g?.projectIds ?? []) as string[]).includes(t.projectId)).slice(0, 20);
      const people = [...new Set(gItems.map((t) => t.who))];
      if (!gItems.length) {
        out.push({ conversationId: cid, groupName: g?.groupName ?? cid, ok: true, people: [] });
        continue;
      }
      try {
        const r = await this.dm.sendGroup(cid, this.composeOverdueText(me.name, gItems));
        out.push({ conversationId: cid, groupName: g?.groupName ?? cid, ok: !!r.ok, people, error: r.error });
      } catch (e: any) {
        out.push({ conversationId: cid, groupName: g?.groupName ?? cid, ok: false, people, error: String(e?.message ?? e) });
      }
    }
    const failed = out.filter((x) => !x.ok).map((x) => x.groupName);
    const withRoster = out.filter((x) => x.people.length);
    this.logger.log(`Agent 逾期催办 by=${me.name} groups=${withRoster.length} failed=${failed.length}`);
    return { ok: true, sent: withRoster.length - failed.length, failed, groups: out, people: [...new Set(items.slice(0, 20).map((t) => t.who))] };
  }

  /** 通知文案追加可点击处理入口（钉钉里相对路径点不开）：已含完整链接则不重复追加 */
  private appendEntryLink(text: string): string {
    const body = String(text ?? '').trim();
    if (!body) return body;
    if (/https?:\/\//i.test(body)) return body;
    const path = /日报|周报/.test(body) ? '/reports' : /任务|逾期|完成|进度/.test(body) ? '/tasks' : '/';
    return `${body}\n\n处理入口：${webLink(path)}`;
  }

  /** 统一通知执行：群目标逐群取文（优先分群文案，否则主文案），人目标私聊+站内信；逐目标返回结果 */
  async broadcastNotify(me: CurrentUserPayload, payload: { content?: string; groupIds?: string[]; personIds?: string[]; groupContents?: { conversationId?: string; content?: string }[] }) {
    await this.assertManager(me);
    const content = String(payload?.content ?? '').trim().slice(0, 2000);
    const perGroup = new Map<string, string>((payload?.groupContents ?? []).map((gc): [string, string] => [String(gc?.conversationId ?? ''), String(gc?.content ?? '').trim().slice(0, 2000)]).filter(([, v]) => v));
    if (!content && !perGroup.size) throw new BadRequestException('通知内容为空');
    const scope = await this.buildScope(me);
    const nameOf = new Map<string, string>(scope.groups.map((g: any) => [g.conversationId, g.groupName]));
    const groupIds = Array.from(new Set((payload?.groupIds ?? []).map(String))).filter((cid) => nameOf.has(cid));
    const personIds = Array.from(new Set((payload?.personIds ?? []).map(String))).filter((pid) => scope.members.some((m: any) => m.id === pid));
    if (!groupIds.length && !personIds.length) throw new ForbiddenException('通知目标不在可见范围');
    const groups: { conversationId: string; groupName: string; ok: boolean; error?: string }[] = [];
    for (const cid of groupIds) {
      const text = this.appendEntryLink(perGroup.get(cid) || content);
      try {
        const r = await this.dm.sendGroup(cid, text);
        groups.push({ conversationId: cid, groupName: nameOf.get(cid) ?? cid, ok: !!r.ok, error: r.error });
      } catch (e: any) {
        groups.push({ conversationId: cid, groupName: nameOf.get(cid) ?? cid, ok: false, error: String(e?.message ?? e) });
      }
    }
    const persons: { name: string; dmOk: boolean; inboxOk: boolean }[] = [];
    if (personIds.length) {
      const users = await this.prisma.user.findMany({ where: { id: { in: personIds } }, select: { id: true, name: true, phone: true } });
      let inboxOk = false;
      try {
        await this.notifications.createMany(users.map((u) => u.id), { type: 'SYSTEM', title: `${me.name} 的通知`, content: content || '相关通知已发到项目群，详见钉钉', link: '/' });
        inboxOk = true;
      } catch (e: any) {
        this.logger.warn(`Agent 通知站内信失败: ${e?.message ?? e}`);
      }
      for (const u of users) {
        let dmOk = false;
        try {
          const r = await this.dm.notifyUser(u, `【团队通知】${this.appendEntryLink(content || groups.map((g) => g.groupName).join('、'))}`);
          dmOk = !!r?.sent;
        } catch (e: any) {
          this.logger.warn(`Agent 通知私聊失败 user=${u.name}: ${e?.message ?? e}`);
        }
        persons.push({ name: u.name, dmOk, inboxOk });
      }
    }
    this.logger.log(`Agent 通知下发 by=${me.name} groups=${groups.length} persons=${persons.length}`);
    return { ok: true, groups, persons, sentGroups: groups.filter((g) => g.ok).length };
  }

  /** 日报催办执行：重扫「今天排了班 ∧ 还没写」的人，每群只发自己项目成员的名单 + 给全部被催的人发站内信 */
  async chaseDaily(me: CurrentUserPayload, payload: { projectName?: string; groupIds?: string[]; personIds?: string[] }) {
    await this.assertManager(me);
    const scope = await this.buildScope(me);
    const roster = await this.dailyChaseRoster(me, scope, String(payload?.projectName ?? '').trim());
    if ((roster as any).error) throw new ForbiddenException((roster as any).error);
    const scan = await this.scanDailyMissing((roster as any).ids);
    let missing = scan.missing;
    const askedIds = (payload?.personIds ?? []).map(String).filter(Boolean);
    if (askedIds.length) missing = missing.filter((m) => askedIds.includes(m.userId));
    if (!missing.length) return { ok: true, sent: 0, chased: [], skipped: true, reason: '这些人现在已经都交过日报了，无需催办' };
    const askedGroups = (payload?.groupIds ?? []).map(String).filter(Boolean);
    const personProj = await this.personProjectMap(scope);
    const { groupPlans, solo } = this.buildDailyGroupPlans(scope, missing, personProj, me, scan, askedGroups.length ? askedGroups : undefined);
    const groups: { groupName: string; ok: boolean; people: string[]; error?: string }[] = [];
    for (const p of groupPlans) {
      try {
        const r = await this.dm.sendGroup(p.conversationId, p.text);
        groups.push({ groupName: p.groupName, ok: !!r.ok, people: p.people, error: r.error });
      } catch (e: any) {
        groups.push({ groupName: p.groupName, ok: false, people: p.people, error: String(e?.message ?? e) });
      }
    }
    let inboxOk = false;
    try {
      await this.notifications.createMany(missing.map((m) => m.userId), {
        type: 'SYSTEM',
        title: `请尽快补写今天的日报（${scan.date} ${scan.weekdayName}）`,
        content: `${me.name} 通过管理助手提醒你：你今天排了工作时间，但日报还没提交，请到「工作管理」页补写。`,
        link: '/reports',
      });
      inboxOk = true;
    } catch (e: any) {
      this.logger.warn(`Agent 日报催办站内信失败: ${e?.message ?? e}`);
    }
    const failed = groups.filter((g) => !g.ok).map((g) => g.groupName);
    this.logger.log(
      `Agent 日报催办 by=${me.name} scope=${(roster as any).scopeLabel} people=${missing.length} groups=${groups.length} failed=${failed.length} inbox=${inboxOk}`,
    );
    return {
      ok: true,
      sent: groups.length - failed.length,
      failed,
      groups,
      chased: missing.map((m) => m.name),
      inboxOk,
      soloNames: solo.map((s) => s.name),
      skipped: false,
    };
  }

  /** 风险项目提醒执行：重扫风险名单，按负责人分组发站内信（+ 他项目绑定的群），每人只收到自己的项目 */
  async riskAlert(me: CurrentUserPayload, payload: { userIds?: string[]; includeAttention?: boolean }) {
    await this.assertManager(me);
    if (me.role !== Role.ADMIN && me.role !== Role.DEPT_LEADER) throw new ForbiddenException('风险项目提醒只对管理员/部门负责人开放');
    const scope = await this.buildScope(me);
    const rows = await this.scanRiskProjects(me, scope, { includeAttention: !!payload?.includeAttention });
    if (!rows.length) return { ok: true, sent: 0, leaders: [], skipped: true, reason: '当前可见范围内没有风险项目，无需提醒' };
    const asked = (payload?.userIds ?? []).map(String).filter(Boolean);
    const groupById = new Map<string, any>((scope.groups as any[]).map((g) => [g.conversationId, g]));
    const date = fmtBeijingDate(new Date());
    const leaderIds = [...new Set(rows.map((p: any) => p.ownerId))].filter((id) => !asked.length || asked.includes(id));
    const users = await this.prisma.user.findMany({ where: { id: { in: leaderIds }, active: true }, select: { id: true, name: true } });
    const nameById = new Map(users.map((u) => [u.id, u.name]));
    const out: { name: string; projects: string[]; inboxOk: boolean; groups: { groupName: string; ok: boolean }[] }[] = [];
    let sentGroups = 0;
    let failedGroups = 0;
    for (const id of leaderIds) {
      const mine = rows.filter((p: any) => p.ownerId === id);
      const name = nameById.get(id);
      if (!name) continue;
      const text = this.composeRiskText(me.name, date, mine);
      let inboxOk = false;
      try {
        await this.notifications.createMany([id], { type: 'SYSTEM', title: `你有 ${mine.length} 个项目被标为有风险，请看一下`, content: text.replace(/\n+/g, ' ').slice(0, 200), link: '/projects' });
        inboxOk = true;
      } catch (e: any) {
        this.logger.warn(`Agent 风险提醒站内信失败 leader=${name}: ${e?.message ?? e}`);
      }
      const gs: { groupName: string; ok: boolean }[] = [];
      for (const cid of [...new Set(mine.map((p: any) => p.dingtalkConversationId).filter(Boolean))] as string[]) {
        try {
          const r = await this.dm.sendGroup(cid, text);
          const ok = !!r.ok;
          gs.push({ groupName: groupById.get(cid)?.groupName ?? cid, ok });
          if (ok) sentGroups++;
          else failedGroups++;
        } catch (e: any) {
          gs.push({ groupName: groupById.get(cid)?.groupName ?? cid, ok: false });
          failedGroups++;
        }
      }
      out.push({ name, projects: mine.map((p: any) => p.name), inboxOk, groups: gs });
    }
    if (!out.length) return { ok: true, sent: 0, leaders: [], skipped: true, reason: '这些风险项目的负责人当前不在职，发不了提醒' };
    this.logger.log(`Agent 风险项目提醒 by=${me.name} leaders=${out.length} groups=${sentGroups} failed=${failedGroups}`);
    return { ok: true, leaders: out, sentGroups, failedGroups, projectCount: rows.length };
  }

  // ---- 首屏概览（/agent/overview：问候 + 今日速览，确定性拼文案、不走大模型）----

  /**
   * 智能体助手首屏数据：待办/逾期、今日会议、今日日报是否已写、我的两项排名、今天是否排班
   * 口径全部复用现有 service（TasksService.myTasks / ReportsService 榜单 / WorkScheduleService），
   * 不在此重写 where；各块独立 catch，某块挂了只降级该块，不能白屏
   */
  async overview(me: CurrentUserPayload) {
    const cfg = await this.config(me);
    if (!cfg.visible) throw new ForbiddenException('小助手未开启（后台总闸或员工档已关闭）');
    const now = new Date();
    const today = fmtBeijingDate(now);
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(todayStart.getTime() + 86400000);

    const tasksP = this.tasks.myTasks({ id: me.id, role: me.role }).catch(() => null);
    const meetP = this.prisma.meeting
      .findMany({
        where: {
          deletedAt: null,
          status: { not: 'CANCELLED' },
          startAt: { gte: todayStart, lt: dayEnd },
          OR: [{ ownerId: me.id }, { status: { not: 'DRAFT' }, participantIds: { has: me.id } }, { materials: { some: { userId: me.id } } }],
        },
        select: { id: true, title: true, startAt: true, endAt: true, status: true },
        orderBy: { startAt: 'asc' },
        take: 8,
      })
      .catch(() => [] as any[]);
    const dailyP = this.prisma.report
      .count({ where: { ownerId: me.id, type: 'DAILY', periodStart: { gte: todayStart, lt: dayEnd } } })
      .catch(() => 0);
    const schedP = this.workSchedule.getMine(me.id).catch(() => null);
    const hoursP = this.reports.hoursRanking(me, { scope: 'month', all: true }).catch(() => null);
    const countP = this.reports.reportCountRanking(me, { scope: 'month', all: true }).catch(() => null);
    const [r, meetings, wroteToday, sched, hoursRank, countRank] = await Promise.all([tasksP, meetP, dailyP, schedP, hoursP, countP]);

    const meH = hoursRank?.rows.find((x: any) => x.userId === me.id) ?? null;
    const meC = countRank?.rows.find((x: any) => x.userId === me.id) ?? null;
    return {
      name: me.name,
      tier: cfg.tier,
      bucket: cfg.bucket,
      date: today,
      todo: r ? { count: r.todo.length, overdue: r.overdue, hidden: r.hidden } : null,
      meetings: {
        count: meetings.length,
        items: meetings.map((m) => ({ id: m.id, title: truncate(m.title, 30), time: `${fmtBeijing(m.startAt).slice(11, 16)}~${fmtBeijing(m.endAt).slice(11, 16)}`, draft: m.status === 'DRAFT' })),
      },
      daily: { wrote: wroteToday > 0, plannedToday: (sched?.todaySlots?.length ?? 0) > 0, todayHours: sched?.todayHours ?? 0 },
      ranking: {
        hoursRank: meH?.rank ?? null,
        hoursTotal: hoursRank?.memberCount ?? 0,
        myHours: meH?.hours ?? 0,
        reportRank: meC?.rank ?? null,
        reportTotal: countRank?.memberCount ?? 0,
        myReportCount: meC?.count ?? 0,
        label: countRank?.label ?? '本月',
      },
      workSchedule: sched ? { totalSlots: sched.totalSlots, todayLabel: sched.todayLabel, todayRanges: sched.todaySlots.map((s: any) => slotRangeLabel(s.startMin, s.endMin)) } : null,
    };
  }

  // ---- 移动助手入口主动播报（/mobile 每天第一次打开即推：待办明细 + 能力引导） ----

  /**
   * 小助手打招呼：确定性拼文案（明细直接查库，不走大模型——快、稳、数字绝不会编错），
   * 口径复用 TasksService.myTasks，与首页「我的待办」完全一致，不会出现两边数不上；
   * 首行带北京日期戳：前端按「会话里最后一条播报是否同一天的」跨设备判定今天播没播过
   */
  async mobileGreet(me: CurrentUserPayload) {
    const tier = await this.assertVisible(me);
    const now = new Date();
    const today = fmtBeijing(now).slice(0, 10);
    const r = await this.tasks.myTasks({ id: me.id, role: me.role });
    const overdue = r.todo.filter((t: any) => t.dueDate && t.dueDate.getTime() < now.getTime());
    const dueToday = r.todo.filter(
      (t: any) => t.dueDate && t.dueDate.getTime() >= now.getTime() && fmtBeijing(t.dueDate).slice(0, 10) === today,
    );
    const rest = r.todo.length - overdue.length - dueToday.length;

    const lines: string[] = [`📅 ${today} 每日播报`, `你好，${me.name}！我是项目助理小助手。☀️`];
    if (!r.todo.length) {
      lines.push('', '📌 待任务：你手里目前没有未完成任务，手头很清爽。');
    } else {
      lines.push('', `📌 待任务播报（共 ${r.todo.length} 条未完成情况）：`);
      const push = (title: string, items: any[]) => {
        if (!items.length) return;
        lines.push(`· ${title}（${items.length} 条）`);
        for (const t of items.slice(0, 8)) {
          const due = t.dueDate ? fmtBeijing(t.dueDate).slice(5, 10) : '未定';
          const days = t.dueDate && t.dueDate.getTime() < now.getTime() ? `，逾期 ${Math.max(1, Math.floor((now.getTime() - t.dueDate.getTime()) / 86400000))} 天` : '';
          lines.push(`  - ${t.title}（${t.project?.name ?? '未归项目'} · 截止 ${due}${days}）`);
        }
        if (items.length > 8) lines.push(`  …等共 ${items.length} 条`);
      };
      push('⚠️ 已逾期', overdue);
      push('🔔 今日到期', dueToday);
      if (rest > 0) lines.push(`· 其余 ${rest} 条在未来几天陆续到期，可问我「我手里还有哪些待办？」看全量`);
      if (!overdue.length && !dueToday.length && rest > 0)
        lines.push('  今天和往日都没有到期压力，按计划推进即可 👍');
    }

    lines.push('', this.guideForRole(me.role, tier));
    const links: { label: string; to: string }[] = [{ label: '我的待办列表', to: '/tasks?scope=mine' }];
    if (overdue.length) links.push({ label: '去处理逾期任务', to: '/tasks?scope=mine' });
    return { reply: lines.join('\n'), tier, links };
  }

  /**
   * 主动播报的能力引导：按角色四档给不同的话，绝不承诺该角色做不到的事
   * - ADMIN / DEPT_LEADER：全站视角（进度/风险/交报情况/催办/发会）
   * - PROJECT_LEADER：本项目视角（我项目进度/谁没交日报周报/发我项目的会，同时自己也要交日报周报）
   * - MEMBER：员工视角（我的待办/写我日报/我的周报/我有没有会）——不含任何看别人进度的引导
   */
  private guideForRole(role: string, tier: string): string {
    if (tier === 'member' || role === 'MEMBER') {
      return [
        '我还能帮你这些事，直接说或点下方快捷提问：',
        '· 我的待办：我手里还有哪些任务、今天该做什么',
        '· 写日报：口述一句今天干了什么，我帮你写成日报并提交',
        '· 我的周报：这周周报还没交？让我帮你梳理要点、提交周报',
        '· 我的排名：我在公司的工时排名、日报篇数排名（本月/本周都可以问）',
        '· 我的工作时间：查或改我的整周工作安排（没排班就不算应发日报、也不会被提醒）',
        '· 我的会议：我今天/这周有没有会要参加',
        '· 找沉淀：知识库与 SOP 检索',
      ].join('\n');
    }
    if (role === 'PROJECT_LEADER') {
      return [
        '作为项目负责人，我还能帮你这些事：',
        '· 项目进度：我当前项目的进展、风险和未完成任务',
        '· 团队日报：我项目下今天还有谁没交日报、谁还没补',
        '· 催今日日报：把今天该写还没写的人点名发到项目群（没排班的不算应发、不打扰）',
        '· 团队排行：我项目里谁工时多、谁日报写得少（工时榜/日报篇数榜）',
        '· 组员任务：看组员今天交了什么、改组员任务的状态/截止（仍走确认卡）',
        '· 发群提醒：提醒我项目群交日报、或把逾期任务催办发到项目群（消息自带处理链接）',
        '· 团队周报：本周还有谁没交周报，需要的话帮你催一催',
        '· 开会：我今天/这周有哪些会，也能帮你发起周会并发布、通知参会人',
        '· 我自己的：口述写今天的日报、提交本周周报、查我的公司排名、改我的工作时间',
        '· 找沉淀：知识库与 SOP 检索',
      ].join('\n');
    }
    // ADMIN / DEPT_LEADER：全站视角
    return [
      '我还能帮你这些事，直接说或点下方快捷提问：',
      '· 查情况：全站/各项目的进度、风险、谁的任务逾期了',
      '· 交报情况：这周谁还没交周报、今天哪个项目有人没交日报',
      '· 催今日日报：一句话把全公司（或某项目）该写还没写的人点名发到各自项目群',
      '· 排行：全站/部门/项目的工时榜与日报篇数榜，谁多谁少',
      '· 风险预警：把 AI 判为高风险的项目按负责人分组，自动提醒对应的 leader',
      '· 开会：帮你发起会议并发布、通知参会人',
      '· 派活与催办：给别人下发任务、把逾期任务催办发到项目群',
      '· 发公司群：一句话把通知/提醒发到「' + COMPANY_GROUP_NAME + '」（自动附处理链接）',
      '· 我自己的：写今天的日报、标任务完成、改截止时间、查我的排名与工作时间',
      '· 找沉淀：知识库与 SOP 检索',
    ].join('\n');
  }

  // ---- 会话历史（服务端持久；跨设备/刷新可查看与继续） ----

  /** 每个会话最多保留的消息条数（超出截断：保留最近 200 条） */
  private static readonly MAX_SESSION_MSGS = 200;
  /** 每人最多保留的会话数（超出自动裁剪最旧） */
  private static readonly MAX_SESSIONS_PER_USER = 50;

  /** 会话列表（不含正文，轻量）：按最近更新排序 */
  async listSessions(me: CurrentUserPayload) {
    await this.assertVisible(me);
    const rows = await this.prisma.agentSession.findMany({
      where: { userId: me.id },
      orderBy: { updatedAt: 'desc' },
      select: { id: true, title: true, messageCount: true, updatedAt: true, createdAt: true },
      take: 100,
    });
    return { sessions: rows };
  }

  /** 读取单个会话正文（须属于本人） */
  async getSession(me: CurrentUserPayload, id: string) {
    await this.assertVisible(me);
    const row = await this.prisma.agentSession.findFirst({ where: { id, userId: me.id } });
    if (!row) throw new NotFoundException('会话不存在或无权访问');
    return { id: row.id, title: row.title, messages: row.messages, updatedAt: row.updatedAt };
  }

  /** 保存/新建会话（upsert，仅本人）；messages 为前端消息模型数组，服务端裁剪条数并派生 title/count */
  async saveSession(me: CurrentUserPayload, body: { id?: string; title?: string; messages?: any[] }) {
    await this.assertVisible(me);
    const msgs = Array.isArray(body?.messages) ? body.messages.slice(-AgentService.MAX_SESSION_MSGS) : [];
    const title = (String(body?.title ?? '').trim() || this.deriveTitle(msgs)).slice(0, 60) || '新会话';
    if (body?.id) {
      const owned = await this.prisma.agentSession.findFirst({ where: { id: body.id, userId: me.id }, select: { id: true } });
      if (!owned) throw new NotFoundException('会话不存在或无权访问');
      const updated = await this.prisma.agentSession.update({
        where: { id: body.id },
        data: { title, messages: msgs as any, messageCount: msgs.length },
      });
      return { ok: true, id: updated.id };
    }
    const created = await this.prisma.agentSession.create({
      data: { userId: me.id, title, messages: msgs as any, messageCount: msgs.length } as any,
    });
    await this.trimSessions(me.id);
    return { ok: true, id: created.id };
  }

  /** 删除自己的会话 */
  async deleteSession(me: CurrentUserPayload, id: string) {
    await this.assertVisible(me);
    const r = await this.prisma.agentSession.deleteMany({ where: { id, userId: me.id } });
    return { ok: true, deleted: r.count };
  }

  /** 会话标题：取首条真实用户问句（跳过「（系统回报）」动作回报行） */
  private deriveTitle(msgs: any[]): string {
    const firstUser = msgs.find((m) => m && m.role === 'user' && !String(m.text ?? '').startsWith('（系统回报）'));
    const t = String(firstUser?.text ?? '').replace(/\s+/g, ' ').trim();
    return t ? t.slice(0, 30) : '新会话';
  }

  /** 超过每人会话上限时自动裁剪最旧会话 */
  private async trimSessions(userId: string) {
    const count = await this.prisma.agentSession.count({ where: { userId } });
    if (count <= AgentService.MAX_SESSIONS_PER_USER) return;
    const stale = await this.prisma.agentSession.findMany({
      where: { userId },
      orderBy: { updatedAt: 'desc' },
      skip: AgentService.MAX_SESSIONS_PER_USER,
      select: { id: true },
    });
    if (stale.length) await this.prisma.agentSession.deleteMany({ where: { id: { in: stale.map((s) => s.id) } } });
  }
}
