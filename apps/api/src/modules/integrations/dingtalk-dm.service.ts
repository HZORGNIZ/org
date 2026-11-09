import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Role } from '@prisma/client';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { CN_OFFSET_MS } from '../../common/beijing-time';
import { PrismaService } from '../../common/prisma.service';
import { resolveDwsJs } from './dingtalk-fetch.service';

const execFileAsync = promisify(execFile);

/** 抄送汇总里最多列出的成员数（超出折叠为「等共 N 人」） */
const MAX_CC_LISTED = 20;

export interface DmSendResult {
  ok: boolean;
  error?: string;
}

/** 私聊发送目标：to=钉钉可解析的收件标识，via=解析途径（userId/phone/name） */
export interface DmTarget {
  to: string;
  via: string;
}

/** 提醒抄送条目：本轮已被私聊提醒的成员（summary 为提醒摘要，如「今日日报未提交」） */
export interface ReminderCcItem {
  userId: string;
  name: string;
  summary: string;
}

/** 抄送结果：每个收件人一条汇总消息 */
export interface ReminderCcResult {
  userId: string;
  name: string;
  audience: 'leader' | 'admin' | 'leader+admin';
  to: string;
  via: string;
  memberCount: number;
  /** 抄送正文（dryRun 时供预览） */
  text: string;
  sent: boolean;
  error?: string;
}

/**
 * 钉钉私聊发送通用能力（从 TaskReminderService 抽取，供任务逾期提醒 / 日报通知负责人 / 日报未写提醒 / PBC 审批与催办共用）
 * - resolveTarget：优先已绑定钉钉 userId（纯数字，可被 +dm 唯一解析）→ 手机号反查 orgUserId → 姓名兜底
 * - sendDm：【发送身份】优先用企业内部应用「机器人单聊」（oToMessages/batchSend，消息来自机器人而非个人账号）；
 *   仅当收件人为数字 userId 且已配置应用凭证时走机器人，机器人失败或非数字目标时自动回退 dws CLI 以个人身份（+dm）发送
 * - notifyUser：解析目标并发送的组合入口，返回发送结果（含目标信息与错误），调用方据此记日志/频控
 * - ccReminders：成员收到系统提醒时，把本轮提醒汇总抄送其主部门负责人与全部管理员
 * - sendGroup：以个人身份向指定钉钉群发一条消息（dws `chat +send-to-group`，与每日进展总结群发同一路径）
 */
@Injectable()
export class DingtalkDmService {
  private readonly logger = new Logger(DingtalkDmService.name);
  readonly dwsJs: string;
  /** 企业内部应用机器人「单聊」发送所需凭证：复用 Stream 的 ClientID/Secret，robotCode 默认等于 ClientID */
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly robotCode: string;
  private botEnabled = false;
  /** 应用 access_token 缓存（到期前 2 分钟刷新） */
  private accessToken = '';
  private accessTokenExp = 0;

  constructor(
    private config: ConfigService,
    private prisma: PrismaService,
  ) {
    this.dwsJs = resolveDwsJs(this.config.get<string>('DINGTALK_DWS_JS', ''));
    if (!this.dwsJs) {
      this.logger.warn('未找到 dws.js（dingtalk-workspace-cli），钉钉私聊「个人身份回退」发送将不可用（可用 DINGTALK_DWS_JS 指定路径）');
    }
    this.clientId = this.config.get<string>('DINGTALK_CLIENT_ID', '');
    this.clientSecret = this.config.get<string>('DINGTALK_CLIENT_SECRET', '');
    this.robotCode = (this.config.get<string>('DINGTALK_ROBOT_CODE', '') || this.clientId).trim();
    this.botEnabled = !!(this.clientId && this.clientSecret && this.robotCode);
    if (this.botEnabled) {
      this.logger.log(`钉钉机器人单聊发送已启用（robotCode=${this.robotCode ? this.robotCode.slice(0, 6) + '…' : '空'}），私聊提醒将以机器人身份发出`);
    } else {
      this.logger.warn('未配置 DINGTALK_CLIENT_ID/SECRET，钉钉私聊将仅以个人身份（dws +dm）发送');
    }
  }

  /** dws CLI 是否可用（不可用时发送直接返回错误，不阻断调用方主流程） */
  get available(): boolean {
    return !!this.dwsJs;
  }

  /**
   * 解析某系统用户的钉钉私聊发送目标
   * - 优先已绑定的钉钉 userId（纯数字可唯一解析；openDingtalkId 不被 +dm 接受）
   * - 其次手机号反查组织成员 ID（contact +by-mobile → orgUserId）
   * - 兜底用系统用户姓名（同名多人时 dws 会报歧义，发送失败记日志）
   */
  async resolveTarget(user: { id: string; name: string; phone: string | null }): Promise<DmTarget> {
    const ids = await this.prisma.userIdentity.findMany({
      where: { userId: user.id, provider: 'dingtalk' },
      select: { externalId: true },
    });
    const numeric = ids.map((i) => i.externalId).find((id) => /^\d+$/.test(id));
    if (numeric) return { to: numeric, via: 'userId' };
    if (user.phone && this.dwsJs) {
      try {
        const { stdout } = await execFileAsync(
          'node',
          [this.dwsJs, 'contact', '+by-mobile', '--mobile', user.phone, '--format', 'json'],
          { timeout: 60_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true, encoding: 'utf8' },
        );
        const orgUserId = (JSON.parse(stdout) as any)?.data?.profile?.orgUserId;
        if (orgUserId && /^\d+$/.test(String(orgUserId))) {
          return { to: String(orgUserId), via: 'phone' };
        }
      } catch (e) {
        this.logger.warn(`手机号反查钉钉 userId 失败（${user.name}）: ${(e as Error).message}`);
      }
    }
    return { to: user.name, via: 'name' };
  }

  /**
   * 发送一条钉钉私聊消息
   * - 优先：收件人为数字 userId 且应用机器人已启用 → 走「机器人单聊」（消息来自机器人，非个人）
   * - 回退：机器人未启用 / 目标非数字 userId / 机器人发送失败 → dws CLI 以个人身份（+dm）发送
   */
  async sendDm(to: string, content: string): Promise<DmSendResult> {
    if (this.botEnabled && /^\d+$/.test(to)) {
      const bot = await this.sendViaBot(to, content);
      if (bot.ok) return bot;
      this.logger.warn(`机器人单聊发送失败（${to}）：${bot.error ?? '未知'}，回退个人身份(dws)发送`);
    }
    return this.sendDmViaDws(to, content);
  }

  /** dws CLI 以个人身份发一条私聊；失败仅返回错误信息 */
  private async sendDmViaDws(to: string, content: string): Promise<DmSendResult> {
    return this.runDws(['chat', '+dm', '--to', to, '--content', content]);
  }

  /**
   * 向指定钉钉群发一条消息（群消息只能以个人身份经 dws 发出，应用机器人不在群里）
   * - conversationId 复用 Project.dingtalkConversationId / Meeting.groupConversationId 的取值口径
   * - 失败只返回错误不抛异常，通知失败不得阻断业务主流程
   */
  async sendGroup(conversationId: string, content: string): Promise<DmSendResult> {
    if (!conversationId) return { ok: false, error: '未指定群 conversationId' };
    return this.runDws(['chat', '+send-to-group', '--group', conversationId, '--content', content]);
  }

  /** 执行一次 dws 发送命令（统一追加 --yes --format json）；失败仅返回错误信息 */
  private async runDws(args: string[]): Promise<DmSendResult> {
    if (!this.dwsJs) return { ok: false, error: 'dws.js 未找到（请配置 DINGTALK_DWS_JS）' };
    try {
      const { stdout } = await execFileAsync(
        'node',
        [this.dwsJs, ...args, '--yes', '--format', 'json'],
        { timeout: 90_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true, encoding: 'utf8' },
      );
      const text = (stdout ?? '').trim();
      if (text) {
        try {
          const data = JSON.parse(text) as any;
          if (data?.success === false || (typeof data?.failedCount === 'number' && data.failedCount > 0)) {
            return { ok: false, error: String(data?.message ?? data?.error ?? 'dws 返回失败') };
          }
        } catch {
          // 非 JSON 输出（部分版本输出文本）：视为成功
        }
      }
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: String(e?.stderr || e?.message || e).slice(0, 300) };
    }
  }

  /** 获取企业内部应用 access_token（缓存至过期前 2 分钟）；失败返回 null */
  private async getAccessToken(): Promise<string | null> {
    if (this.accessToken && Date.now() < this.accessTokenExp) return this.accessToken;
    try {
      const res = await fetch('https://api.dingtalk.com/v1.0/oauth2/accessToken', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appKey: this.clientId, appSecret: this.clientSecret }),
        signal: AbortSignal.timeout(15_000),
      });
      const data = (await res.json().catch(() => ({}))) as any;
      const token = data?.accessToken as string | undefined;
      if (!res.ok || !token) {
        this.logger.warn(`获取钉钉 access_token 失败（HTTP ${res.status}）: ${JSON.stringify(data).slice(0, 200)}`);
        return null;
      }
      this.accessToken = token;
      const expireIn = Number(data?.expireIn ?? 7200);
      this.accessTokenExp = Date.now() + Math.max(expireIn - 120, 60) * 1000;
      return token;
    } catch (e) {
      this.logger.warn(`获取钉钉 access_token 异常: ${(e as Error).message}`);
      return null;
    }
  }

  /** 企业内部应用机器人单聊（oToMessages/batchSend）向单个 userId 发送文本；失败返回错误供回退 */
  private async sendViaBot(userId: string, content: string): Promise<DmSendResult> {
    const token = await this.getAccessToken();
    if (!token) return { ok: false, error: 'access_token 获取失败' };
    try {
      const res = await fetch('https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-acs-dingtalk-access-token': token },
        body: JSON.stringify({
          robotCode: this.robotCode,
          userIds: [userId],
          msgKey: 'sampleText',
          msgParam: JSON.stringify({ content }),
        }),
        signal: AbortSignal.timeout(20_000),
      });
      const data = (await res.json().catch(() => ({}))) as any;
      if (!res.ok) return { ok: false, error: `HTTP ${res.status} ${JSON.stringify(data).slice(0, 200)}` };
      const invalid = Array.isArray(data?.invalidStaffIdList) ? (data.invalidStaffIdList as unknown[]) : [];
      const flow = Array.isArray(data?.flowControlledStaffIdList) ? (data.flowControlledStaffIdList as unknown[]) : [];
      const filtered = Array.isArray(data?.filteredStaffIdList) ? (data.filteredStaffIdList as unknown[]) : [];
      if (invalid.includes(userId)) return { ok: false, error: '用户不在机器人可发送范围(invalidStaffId)' };
      if (flow.includes(userId)) return { ok: false, error: '发送被限流(flowControlled)' };
      if (filtered.includes(userId)) return { ok: false, error: '用户被过滤(filtered)' };
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String((e as Error).message).slice(0, 200) };
    }
  }

  /**
   * 给某系统用户发钉钉私聊：解析目标 → 发送；dryRun 时只解析目标返回文本不发送。
   * 返回结果含目标标识与途径，供调用方记日志或做发送成功后的频控更新。
   */
  async notifyUser(
    user: { id: string; name: string; phone: string | null },
    text: string,
    opts: { dryRun?: boolean } = {},
  ): Promise<{ to: string; via: string; sent: boolean; error?: string }> {
    const target = await this.resolveTarget(user);
    if (opts.dryRun) return { to: target.to, via: target.via, sent: false };
    const r = await this.sendDm(target.to, text);
    return { to: target.to, via: target.via, sent: r.ok, error: r.error };
  }

  /**
   * 提醒抄送：成员收到系统钉钉提醒时，同时知会其主部门负责人与全部管理员
   * - 按收件人聚合：每个收件人每轮只收一条汇总（负责人只列本部门成员，管理员列全部；双重身份并集去重）
   * - 排除被提醒成员本人、停用账号与 opts.excludeUserIds（如催办操作人，无需给自己发副本）
   * - dryRun 只解析目标不发送；发送失败仅记日志，不抛错、不影响主提醒流程
   */
  async ccReminders(
    items: ReminderCcItem[],
    opts: { dryRun?: boolean; title?: string; excludeUserIds?: string[] } = {},
  ): Promise<ReminderCcResult[]> {
    if (!items.length) return [];
    const excluded = new Set(opts.excludeUserIds ?? []);
    const memberIds = [...new Set(items.map((i) => i.userId))];
    const [members, admins] = await Promise.all([
      this.prisma.user.findMany({
        where: { id: { in: memberIds } },
        select: {
          id: true,
          department: {
            select: {
              name: true,
              leaderId: true,
              leader: { select: { id: true, name: true, phone: true, active: true } },
            },
          },
        },
      }),
      this.prisma.user.findMany({
        where: { role: Role.ADMIN, active: true },
        select: { id: true, name: true, phone: true },
      }),
    ]);
    const memberMap = new Map(members.map((m) => [m.id, m]));
    type Recipient = {
      id: string;
      name: string;
      phone: string | null;
      leader: boolean;
      admin: boolean;
      lines: Map<string, string>;
    };
    const recipients = new Map<string, Recipient>();
    const add = (
      u: { id: string; name: string; phone: string | null },
      kind: 'leader' | 'admin',
      memberId: string,
      line: string,
    ) => {
      const r = recipients.get(u.id) ?? {
        id: u.id,
        name: u.name,
        phone: u.phone,
        leader: false,
        admin: false,
        lines: new Map<string, string>(),
      };
      r[kind] = true;
      if (!r.lines.has(memberId)) r.lines.set(memberId, line);
      recipients.set(u.id, r);
    };
    for (const it of items) {
      const dept = memberMap.get(it.userId)?.department;
      const line = `· ${it.name}（${dept?.name ?? '未分配部门'}）：${it.summary}`;
      const leader = dept?.leader;
      if (leader?.active && leader.id !== it.userId && !excluded.has(leader.id)) {
        add(leader, 'leader', it.userId, line);
      }
      for (const a of admins) {
        if (a.id === it.userId || excluded.has(a.id)) continue;
        add(a, 'admin', it.userId, line);
      }
    }

    const now = new Date();
    const results: ReminderCcResult[] = [];
    for (const r of recipients.values()) {
      const audience = r.leader && r.admin ? 'leader+admin' : r.admin ? 'admin' : 'leader';
      const text = this.buildCcText(opts.title ?? '成员提醒', [...r.lines.values()], now);
      const target = await this.resolveTarget(r);
      if (opts.dryRun) {
        results.push({
          userId: r.id,
          name: r.name,
          audience,
          to: target.to,
          via: target.via,
          memberCount: r.lines.size,
          text,
          sent: false,
        });
        continue;
      }
      const res = await this.sendDm(target.to, text);
      if (res.ok) {
        this.logger.log(`提醒抄送已发送「${r.name}」（${audience}，${r.lines.size} 人，via ${target.via}）`);
      } else {
        this.logger.warn(`提醒抄送发送失败（${r.name} → ${target.to}）: ${res.error ?? '未知'}`);
      }
      results.push({
        userId: r.id,
        name: r.name,
        audience,
        to: target.to,
        via: target.via,
        memberCount: r.lines.size,
        text,
        sent: res.ok,
        error: res.error,
      });
    }
    return results;
  }

  /** 组装抄送汇总文本（最多列 MAX_CC_LISTED 人，超出折叠） */
  private buildCcText(title: string, lines: string[], now: Date): string {
    const b = new Date(now.getTime() + CN_OFFSET_MS).toISOString();
    const md = `${Number(b.slice(5, 7))}.${Number(b.slice(8, 10))}`;
    const shown = lines.slice(0, MAX_CC_LISTED);
    if (lines.length > shown.length) shown.push(`… 等共 ${lines.length} 人`);
    return [
      `🔔 ${title}抄送（${md}）`,
      '以下成员已收到系统钉钉提醒：',
      ...shown,
      '',
      '（自动抄送成员主部门负责人与系统管理员，便于跟进）',
      '—— 来自 MyOrgniz 团队协作系统',
    ].join('\n');
  }

  /**
   * 成员提交汇报内容（日报/周报/PBC）后，实时钉钉私聊其部门负责人（统一入口）
   * - kind：汇报类型文案（如「日报」「周报」「月度 PBC」），用于通知标题与正文
   * - excerpt：正文摘要（自动截断至 160 字）
   * - 仅当本人所在部门开启 reportNotifyLeader 且设有负责人，且负责人不是本人
   * - 失败/异常只记日志，绝不抛出，不影响调用方主流程
   */
  async notifyDeptLeader(userId: string, opts: { kind: string; excerpt: string }): Promise<void> {
    try {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          name: true,
          departmentId: true,
          department: {
            select: {
              name: true,
              reportNotifyLeader: true,
              leaderId: true,
              leader: { select: { id: true, name: true, phone: true } },
            },
          },
        },
      });
      const dept = user?.department;
      if (!dept?.reportNotifyLeader || !dept.leader || dept.leaderId === userId) return;
      const body = (opts.excerpt || '').trim();
      const excerpt = body.length > 160 ? `${body.slice(0, 160)}…` : body;
      const text = [
        `🗒️ ${opts.kind}提交通知（${dept.name}）`,
        `${user!.name} 刚刚提交了${opts.kind}：`,
        excerpt || '（无正文）',
        '',
        '—— 来自 MyOrgniz 团队协作系统',
      ].join('\n');
      const r = await this.notifyUser(dept.leader, text);
      if (r.sent) {
        this.logger.log(`${opts.kind}已通知负责人「${dept.leader.name}」（成员 ${user!.name}，via ${r.via}）`);
      } else {
        this.logger.warn(`${opts.kind}通知负责人失败（${dept.leader.name} → ${r.to}）: ${r.error ?? '未知'}`);
      }
    } catch (e) {
      this.logger.error(`${opts.kind}通知负责人异常（已忽略，不影响提交）: ${(e as Error).message}`);
    }
  }
}
