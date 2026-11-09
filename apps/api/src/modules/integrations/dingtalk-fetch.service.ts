import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PrismaService } from '../../common/prisma.service';
import { fmtBeijing } from '../../common/beijing-time';
import { InboundMessage } from './message-source.interface';
import { DingTalkService } from './dingtalk.service';

const execFileAsync = promisify(execFile);

// fmtBeijing 已抽到 common/beijing-time（AI 提示词日志等模块共用）；
// 此处保留 re-export 兼容既有导入方，时间口径说明见该文件
// （钉钉 dws 的 --start/--end 与消息 createTime 同为【北京墙钟】，窗口一律显式按北京时间生成）
export { fmtBeijing };

/**
 * 解析钉钉 createTime（"YYYY-MM-DD HH:mm:ss" 北京墙钟）为库内时间值
 * 时间口径约定：MessageInbox.receivedAt 与 ProjectUpdate.periodStart/periodEnd 统一存
 * 【北京墙钟字面量】（即把北京墙钟当作 UTC 存，历史数据同口径），故用 Z 后缀构造，
 * 与容器时区无关；AI 提示词与前端展示均不做时区换算，直接按字面量读
 */
export function parseWallClock(s: string): Date {
  return new Date(`${s.trim().replace(' ', 'T')}Z`);
}

/** 探测 dws.js 路径：优先 DINGTALK_DWS_JS 配置，其次常见安装路径（钉钉抓取与摘要发送共用） */
export function resolveDwsJs(cfg: string): string {
  if (cfg && fs.existsSync(cfg)) return cfg;
  const home = os.homedir();
  const candidates = [
    path.join(home, '.workbuddy', 'binaries', 'node', 'cli-connector-packages', 'node_modules', 'dingtalk-workspace-cli', 'bin', 'dws.js'),
    path.join(process.env.APPDATA ?? '', 'npm', 'node_modules', 'dingtalk-workspace-cli', 'bin', 'dws.js'),
    path.join(home, 'AppData', 'Roaming', 'npm', 'node_modules', 'dingtalk-workspace-cli', 'bin', 'dws.js'),
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return '';
}

/**
 * 钉钉群消息抓取（基于官方 CLI dws / dingtalk-workspace-cli，用户身份登录）
 * - 突破 Stream 只能收 @机器人 消息的限制：按群拉取时间范围内【全部】消息
 * - 每轮抓取 [now-48h, now)，由 MessageInbox.msgId 唯一约束自动去重
 * - 时间口径：dws 查询窗口与消息 createTime 同为【北京墙钟】，窗口统一用 fmtBeijing 生成，
 *   禁止依赖容器时区（线上 api 容器是 UTC，曾造成窗口少 8 小时）
 * - 通过 node 直跑 dws.js：dws.cmd 包装层在 PowerShell 下会报 40441 兼容错误
 */
@Injectable()
export class DingtalkFetchService implements OnModuleInit {
  private readonly logger = new Logger(DingtalkFetchService.name);
  private readonly enabled: boolean;
  private readonly dwsJs: string;
  /** conversationId -> 群名（从已关联项目聚合，供落库补全群名） */
  private readonly groupNames = new Map<string, string>();
  /** conversationId -> 群成员画像（真人/机器人），TTL 10 分钟 */
  private readonly groupMembersCache = new Map<
    string,
    { at: number; users: { openDingtalkId: string; name: string }[]; bots: string[] }
  >();

  constructor(
    private config: ConfigService,
    private prisma: PrismaService,
    private dingtalk: DingTalkService,
  ) {
    this.enabled = this.config.get<string>('DINGTALK_FETCH_ENABLED', 'true') === 'true';
    this.dwsJs = resolveDwsJs(this.config.get<string>('DINGTALK_DWS_JS', ''));
  }

  onModuleInit() {
    if (!this.enabled) {
      this.logger.warn('钉钉群消息抓取未启用（DINGTALK_FETCH_ENABLED=false）');
      return;
    }
    if (!this.dwsJs) {
      this.logger.error('未找到 dws.js（dingtalk-workspace-cli），请安装 npm i -g dingtalk-workspace-cli 或用 DINGTALK_DWS_JS 指定路径');
      return;
    }
    this.logger.log(`钉钉群消息抓取就绪: ${this.dwsJs}`);
  }

  /** 抓取所有已关联钉钉群最近两天的消息（[now-48h, now)）；addedMessages 为本批新增入库消息 */
  async fetchRecentAll(): Promise<{
    groups: number;
    fetched: number;
    added: number;
    skipped: number;
    addedMessages: InboundMessage[];
  }> {
    if (!this.enabled || !this.dwsJs)
      return { groups: 0, fetched: 0, added: 0, skipped: 0, addedMessages: [] };
    const projects = await this.prisma.project.findMany({
      where: { dingtalkConversationId: { not: null } },
      select: { dingtalkConversationId: true, dingtalkGroupName: true },
    });
    this.groupNames.clear();
    for (const p of projects) {
      if (p.dingtalkConversationId) {
        this.groupNames.set(p.dingtalkConversationId, p.dingtalkGroupName ?? p.dingtalkConversationId);
      }
    }
    const now = new Date();
    const start = new Date(now.getTime() - 48 * 60 * 60 * 1000);
    this.logger.log(
      `钉钉群消息抓取窗口（北京时间）: ${fmtBeijing(start)} ~ ${fmtBeijing(now)}，共 ${this.groupNames.size} 个群`,
    );
    const stats = { groups: 0, fetched: 0, added: 0, skipped: 0, addedMessages: [] as InboundMessage[] };
    for (const p of projects) {
      if (!p.dingtalkConversationId) continue;
      const r = await this.fetchGroupMessages(p.dingtalkConversationId, start, now);
      stats.groups++;
      stats.fetched += r.fetched;
      stats.added += r.added;
      stats.skipped += r.skipped;
      stats.addedMessages.push(...(r.addedMessages ?? []));
    }
    return stats;
  }

  /** 抓取单个项目关联群最近 lookbackHours 小时（默认 48h）的消息并落库 */
  async fetchRecentForProject(
    projectId: string,
    lookbackHours = 48,
  ): Promise<{
    groupName?: string;
    groups: number;
    fetched: number;
    added: number;
    skipped: number;
    addedMessages: InboundMessage[];
    error?: string;
  }> {
    if (!this.enabled || !this.dwsJs) {
      return { groups: 0, fetched: 0, added: 0, skipped: 0, addedMessages: [], error: '钉钉抓取未启用或 dws CLI 不可用' };
    }
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { dingtalkConversationId: true, dingtalkGroupName: true },
    });
    if (!project?.dingtalkConversationId) {
      return { groups: 0, fetched: 0, added: 0, skipped: 0, addedMessages: [], error: '项目未关联钉钉群' };
    }
    this.groupNames.set(project.dingtalkConversationId, project.dingtalkGroupName ?? project.dingtalkConversationId);
    const now = new Date();
    const start = new Date(now.getTime() - lookbackHours * 60 * 60 * 1000);
    const r = await this.fetchGroupMessages(project.dingtalkConversationId, start, now);
    return {
      groupName: project.dingtalkGroupName ?? undefined,
      groups: 1,
      ...r,
    };
  }

  /** 拉取单个群 [start, end) 的消息并落库（msgId 去重）；addedMessages 为本批新增入库消息 */
  async fetchGroupMessages(
    conversationId: string,
    start: Date,
    end: Date,
  ): Promise<{ fetched: number; added: number; skipped: number; addedMessages: InboundMessage[]; error?: string }> {
    // 单次调用（不用 --page-all：其依赖服务端 hasMore 翻页校验，偶发报 chat_messages_incomplete）
    // hasMore=true 说明超出单页上限，按时间窗口二分递归拉取（重复消息由 msgId 唯一约束兜底）
    // 钉钉服务端偶发 TIMEOUT_ERROR（retryable），退避重试 2 次后仍失败则交由窗口切分兜底
    const callOnce = async (s: Date, e: Date, attempt = 1): Promise<any> => {
      try {
        const { stdout } = await execFileAsync(
          'node',
          [
            this.dwsJs, 'chat', '+chat-messages',
            '--group', conversationId,
            '--start', fmtBeijing(s),
            '--end', fmtBeijing(e),
            '--order', 'asc',
            '--limit', '100',
            '--format', 'json',
          ],
          { timeout: 300_000, maxBuffer: 64 * 1024 * 1024, windowsHide: true, encoding: 'utf8' },
        );
        return JSON.parse(stdout) as any;
      } catch (err) {
        if (attempt < 3) {
          await new Promise((r) => setTimeout(r, 1500 * attempt));
          return callOnce(s, e, attempt + 1);
        }
        throw err;
      }
    };
    // 大窗口（如手动拉取 1-3 个月）单次调用偶发超时：失败段持续对半切分到 2 小时粒度，
    // 避免整个拉取失败（更小窗口仍失败则放弃该片段，保证其余窗口照常入库）
    const MIN_SPLIT_MS = 2 * 3600_000;
    const fetchRange = async (s: Date, e: Date): Promise<any[]> => {
      const span = e.getTime() - s.getTime();
      let data: any = null;
      try {
        data = await callOnce(s, e);
      } catch {
        // 重试耗尽：落入下方切分逻辑
      }
      if (data) {
        const msgs: any[] = data.messages ?? [];
        if (!data.hasMore) return msgs;
        // 窗口已无法再分（<1 分钟）时放弃继续，返回已拿到的部分
        if (span <= 60_000) return msgs;
      }
      if (span <= MIN_SPLIT_MS) return [];
      const mid = new Date((s.getTime() + e.getTime()) / 2);
      const [head, tail] = await Promise.all([fetchRange(s, mid), fetchRange(mid, e)]);
      return [...head, ...tail];
    };
    try {
      const messages = await fetchRange(start, end);
      let added = 0;
      let skipped = 0;
      const seen = new Set<string>();
      const addedMessages: InboundMessage[] = [];
      for (const m of messages) {
        if (!m.messageId || seen.has(m.messageId)) {
          skipped++;
          continue;
        }
        seen.add(m.messageId);
        const persisted = await this.persist(m);
        if (persisted) {
          added++;
          addedMessages.push(persisted);
        } else {
          skipped++;
        }
      }
      this.logger.log(
        `拉取群「${this.groupNames.get(conversationId) ?? conversationId}」消息 ${messages.length} 条（新增 ${added}，去重 ${skipped}）｜窗口 ${fmtBeijing(start)} ~ ${fmtBeijing(end)}（北京时间）`,
      );
      return { fetched: messages.length, added, skipped, addedMessages };
    } catch (e) {
      const msg = (e as Error).message;
      this.logger.error(`拉取群 ${conversationId} 消息失败: ${msg}`);
      return { fetched: 0, added: 0, skipped: 0, addedMessages: [], error: msg };
    }
  }

  /** 单条 dws 消息 -> 统一结构落库；成功（新增入库）返回消息体，去重失败返回 null */
  private async persist(m: any): Promise<InboundMessage | null> {
    if (!m.messageId || !m.conversationId) return null;
    const inbound: InboundMessage = {
      msgId: m.messageId,
      conversationId: m.conversationId,
      conversationName: this.groupNames.get(m.conversationId),
      senderExternalId: m.senderId,
      senderName: m.sender,
      messageType: 'TEXT',
      content: m.text ?? '[非文本消息]',
      raw: m,
      receivedAt: m.createTime ? parseWallClock(m.createTime) : new Date(),
    };
    return (await this.dingtalk.persist(inbound)) ? inbound : null;
  }

  /**
   * 按群名唯一解析钉钉群（项目关联用）
   * - 只返回「唯一命中」的群，不返回群列表，避免泄露公司群信息
   * - NOT_FOUND：未命中；AMBIGUOUS：多个同名群；UNAVAILABLE：dws 未启用/未登录/异常
   */
  async resolveGroupByName(
    name: string,
  ): Promise<{ ok: true; conversationId: string; name: string } | { ok: false; reason: 'NOT_FOUND' | 'AMBIGUOUS' | 'UNAVAILABLE' }> {
    if (!this.enabled || !this.dwsJs) return { ok: false, reason: 'UNAVAILABLE' };
    const query = (name || '').trim();
    if (!query) return { ok: false, reason: 'NOT_FOUND' };
    try {
      const { stdout } = await execFileAsync(
        'node',
        [this.dwsJs, 'chat', '+chat-search', '--query', query, '--page-all', '--format', 'json'],
        { timeout: 60_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true, encoding: 'utf8' },
      );
      const data = JSON.parse(stdout) as any;
      // 兼容 dws 不同版本的返回结构（实测：+chat-search 返回 chats[]）
      const groups: any[] =
        data.chats ?? data.groups ?? data.conversations ?? data.items ?? data.list ?? data.result ?? [];
      const exact = groups.filter((g: any) => g.name === query || g.title === query);
      const candidates = exact.length ? exact : groups;
      if (candidates.length === 1) {
        const g = candidates[0];
        const conversationId = g.openConversationId ?? g.conversationId ?? g.id ?? g.openId;
        if (conversationId) {
          return { ok: true, conversationId: String(conversationId), name: g.name ?? g.title ?? query };
        }
        return { ok: false, reason: 'NOT_FOUND' };
      }
      if (candidates.length > 1) return { ok: false, reason: 'AMBIGUOUS' };
      // dws 搜索未命中时，降级匹配已落库消息的群（兼容机器人已入群、消息已被收录的场景）
      const inbox = await this.prisma.messageInbox.findMany({
        where: { conversationName: query, conversationId: { not: null } },
        select: { conversationId: true, conversationName: true },
        distinct: ['conversationId'],
        take: 2,
      });
      if (inbox.length === 1 && inbox[0].conversationId) {
        return { ok: true, conversationId: inbox[0].conversationId, name: inbox[0].conversationName ?? query };
      }
      if (inbox.length > 1) return { ok: false, reason: 'AMBIGUOUS' };
      return { ok: false, reason: 'NOT_FOUND' };
    } catch (e) {
      this.logger.error(`解析钉钉群「${query}」失败: ${(e as Error).message}`);
      return { ok: false, reason: 'UNAVAILABLE' };
    }
  }

  /**
   * 查询群成员画像（dws +chat-members-list），用于机器人过滤与发送人身份绑定
   * - bots[] 为群内机器人（含 openDingtalkId，与消息 senderId 同格式）
   * - users[] 为真人成员（openDingtalkId + 钉钉名）
   * - dws 失败/未启用 → 空结果不抛错（不过滤机器人、不绑定身份，不阻塞主流程）
   */
  async listGroupMembers(
    conversationId: string,
  ): Promise<{ users: { openDingtalkId: string; name: string }[]; bots: string[] }> {
    if (!this.enabled || !this.dwsJs || !conversationId) return { users: [], bots: [] };
    const cached = this.groupMembersCache.get(conversationId);
    if (cached && Date.now() - cached.at < 10 * 60_000) return cached;
    try {
      const { stdout } = await execFileAsync(
        'node',
        [this.dwsJs, 'chat', '+chat-members-list', '--group', conversationId, '--format', 'json'],
        { timeout: 60_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true, encoding: 'utf8' },
      );
      const data = JSON.parse(stdout) as any;
      const users = ((data?.users ?? []) as any[])
        .map((u) => ({
          openDingtalkId: u?.openDingtalkId as string | undefined,
          name: (u?.name ?? u?.nick ?? '') as string,
        }))
        .filter((u): u is { openDingtalkId: string; name: string } => Boolean(u.openDingtalkId));
      const bots = ((data?.bots ?? []) as any[])
        .map((b) => b?.openDingtalkId as string | undefined)
        .filter((x): x is string => Boolean(x));
      const result = { users, bots };
      this.groupMembersCache.set(conversationId, { at: Date.now(), ...result });
      return result;
    } catch (e) {
      this.logger.warn(`查询群成员 ${conversationId} 失败: ${(e as Error).message}`);
      return { users: [], bots: [] };
    }
  }

  /**
   * 解析钉钉消息发送人身份（自动绑定到系统用户，供进展归属使用）
   * - 命中 UserIdentity 直接返回；未命中按 senderExternalId 形态处理：
   *   1) `$:` 前缀（机器人回调身份）→ { bot: true }
   *   2) 组织成员 ID（纯数字）→ contact user get 取资料，按钉钉姓名匹配系统用户，
   *      候选唯一时手机号反查（+by-mobile）验证 orgUserId 一致（强匹配）
   *   3) openDingtalkId（非数字）→ 用调用方提供的钉钉名 dingtalkName 匹配系统用户，
   *      候选唯一时手机号反查验证 orgUserName 与钉钉名一致（强匹配）
   * - 验证通过写入 UserIdentity 缓存；无法匹配/异常 → null（不判机器人，消息按钉钉名展示）
   */
  async resolveSenderIdentity(
    senderExternalId: string,
    dingtalkName?: string,
  ): Promise<{ userId: string } | { bot: true } | null> {
    if (!this.enabled || !this.dwsJs || !senderExternalId) return null;
    const bound = await this.prisma.userIdentity.findUnique({
      where: { provider_externalId: { provider: 'dingtalk', externalId: senderExternalId } },
    });
    if (bound) return { userId: bound.userId };
    // 机器人回调身份（$: 前缀）直接判机器人
    if (senderExternalId.startsWith('$:')) return { bot: true };
    try {
      // 组织成员 ID（纯数字）→ 通讯录查询取资料；openDingtalkId 等非组织 ID → 依赖调用方提供的钉钉名
      let orgUserName = '';
      if (/^\d+$/.test(senderExternalId)) {
        const { stdout } = await execFileAsync(
          'node',
          [this.dwsJs, 'contact', 'user', 'get', '--user-id', senderExternalId, '--format', 'json'],
          { timeout: 60_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true, encoding: 'utf8' },
        );
        const data = JSON.parse(stdout) as any;
        const emp = data?.result?.[0]?.orgEmployeeModel;
        orgUserName = (emp?.orgUserName as string | undefined) ?? '';
        // 无组织资料：无法确认身份，不判机器人（消息保留，按钉钉名展示）
        if (!orgUserName) return null;
      } else {
        orgUserName = dingtalkName ?? '';
        if (!orgUserName) return null;
      }
      // 按钉钉姓名匹配系统用户（候选唯一时手机号反查验证）
      const candidates = await this.prisma.user.findMany({
        where: { name: orgUserName, active: true },
        select: { id: true, name: true, phone: true },
        take: 5,
      });
      if (candidates.length !== 1) return null;
      const c = candidates[0];
      let verified = false;
      if (c.phone) {
        try {
          const { stdout: mobOut } = await execFileAsync(
            'node',
            [this.dwsJs, 'contact', '+by-mobile', '--mobile', c.phone, '--format', 'json'],
            { timeout: 60_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true, encoding: 'utf8' },
          );
          const mob = JSON.parse(mobOut) as any;
          const profile = mob?.data?.profile;
          // 纯数字 ID：反查 orgUserId 与消息 sender ID 一致；openDingtalkId：反查姓名与钉钉名一致
          verified = /^\d+$/.test(senderExternalId)
            ? profile?.orgUserId === senderExternalId
            : Boolean(profile?.orgUserName) && profile.orgUserName === dingtalkName;
        } catch {
          verified = false;
        }
      }
      if (verified) {
        await this.prisma.userIdentity.upsert({
          where: { provider_externalId: { provider: 'dingtalk', externalId: senderExternalId } },
          create: {
            provider: 'dingtalk',
            externalId: senderExternalId,
            userId: c.id,
            raw: { dingtalkName: orgUserName, match: 'phone_verified' },
          },
          update: {},
        });
        this.logger.log(`已自动绑定钉钉身份: ${orgUserName} (${senderExternalId}) -> ${c.name}`);
        return { userId: c.id };
      }
      return null;
    } catch (e) {
      this.logger.warn(`解析钉钉发送人 ${senderExternalId} 失败: ${(e as Error).message}`);
      return null;
    }
  }
}
