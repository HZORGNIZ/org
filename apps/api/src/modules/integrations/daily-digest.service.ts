import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { PrismaService } from '../../common/prisma.service';
import { CN_OFFSET_MS, fmtBeijing } from '../../common/beijing-time';
import { AiService } from '../ai/ai.service';
import { resolveDwsJs } from './dingtalk-fetch.service';

const execFileAsync = promisify(execFile);

/** 北京时间日期标签「M.D」（如 9.17）：periodEnd 存北京墙钟字面量，直接取字面量月日 */
export function mdLabel(d: Date): string {
  const iso = d.toISOString();
  return `${Number(iso.slice(5, 7))}.${Number(iso.slice(8, 10))}`;
}

/** 今日的北京日期标签「M.D」（入参为真实时刻，需 +8h 换算北京墙钟） */
function todayMd(now: Date): string {
  return mdLabel(new Date(now.getTime() + CN_OFFSET_MS));
}

/** 结尾补句号（已有句末标点则原样） */
function ensureDot(s: string): string {
  const t = (s ?? '').trim();
  return /[。！？!?；;]$/.test(t) ? t : `${t}。`;
}

interface DigestItem {
  name: string;
  summary: string;
}

interface SendResult {
  ok: boolean;
  error?: string;
}

/**
 * 每日团队工作进展总结（发送时间可在管理后台设置，默认每天 20:00，见 DailyDigestQueue）
 * - 私聊汇总（发给 DINGTALK_DIGEST_TO：姓名或钉钉 userId，默认杨力；同名多人时必须传 userId）：所有项目最近 2 天进展，
 *   无进展项目显示「无进展」，排除 DINGTALK_DIGEST_EXCLUDE 中的项目；末尾附当日金句
 * - 群发：有进展、已关联钉钉群且 dailyDigestEnabled=true 的项目，按项目发到对应群（无进展不发；开关仅控制群发；默认关闭，需在项目设置中手动开启）
 * - 排版：小红书风格（emoji 标题 + 各项目独立段落空行分隔 + 金句收尾）
 * - 进展来源：ProjectUpdate（AI 群聊总结产物），窗口 [now-48h, now)
 * - AI 一次调用同时浓缩各项目进展并生成金句；失败降级：
 *   summary 用「日期+原文」（最近 3 条）拼接，金句用 DINGTALK_DIGEST_MOTTO_DEFAULT
 * - dryRun：只生成文本不发送；onlyDm：只发私聊（群消息仅生成供预览）
 */
@Injectable()
export class DailyDigestService {
  private readonly logger = new Logger(DailyDigestService.name);
  private readonly enabled: boolean;
  private readonly dwsJs: string;

  constructor(
    private config: ConfigService,
    private prisma: PrismaService,
    private ai: AiService,
  ) {
    this.enabled = this.config.get<string>('DINGTALK_DIGEST_ENABLED', 'true') === 'true';
    this.dwsJs = resolveDwsJs(this.config.get<string>('DINGTALK_DWS_JS', ''));
    if (!this.dwsJs) {
      this.logger.warn('未找到 dws.js（dingtalk-workspace-cli），每日总结将无法发送（可用 DINGTALK_DWS_JS 指定路径）');
    }
  }

  async run(opts: { dryRun?: boolean; onlyDm?: boolean } = {}) {
    const dryRun = !!opts.dryRun;
    const onlyDm = !!opts.onlyDm;
    if (!this.enabled && !dryRun) {
      return { skipped: true, reason: 'DINGTALK_DIGEST_ENABLED=false（可传 dryRun=true 预览文本）' };
    }
    const now = new Date();
    const since = new Date(now.getTime() - 48 * 3600_000);
    const projects = await this.prisma.project.findMany({
      where: { archived: false },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        name: true,
        confidential: true,
        dingtalkConversationId: true,
        dingtalkGroupName: true,
        dailyDigestEnabled: true,
      },
    });
    const updates = await this.prisma.projectUpdate.findMany({
      where: { createdAt: { gte: since } },
      orderBy: { periodEnd: 'asc' },
      select: { projectId: true, content: true, periodEnd: true },
    });
    const byProject = new Map<string, typeof updates>();
    for (const u of updates) {
      const arr = byProject.get(u.projectId) ?? [];
      arr.push(u);
      byProject.set(u.projectId, arr);
    }
    const withProgress = projects.filter((p) => (byProject.get(p.id)?.length ?? 0) > 0);

    // AI 一次调用：浓缩各项目进展 + 生成当日金句（无进展项目不进 AI，直接显示「无进展」）
    let aiItems: DigestItem[] = [];
    let aiMotto = '';
    if (withProgress.length) {
      const blocks = withProgress.map((p) => {
        const lines = (byProject.get(p.id) ?? [])
          .slice(-10)
          .map((u) => `- ${mdLabel(u.periodEnd)} ${u.content}`);
        return `【${p.name}】\n${lines.join('\n')}`;
      });
      const ai = await this.ai.generateJson<{ motto?: string; items?: DigestItem[] }>('digest.daily', {
        projects: blocks.join('\n\n'),
      });
      if (ai?.items?.length) aiItems = ai.items;
      if (ai?.motto) aiMotto = ai.motto.trim();
    }
    const aiMap = new Map(
      aiItems.map((it) => [String(it.name ?? '').trim(), String(it.summary ?? '').trim()]),
    );
    /** 项目摘要：AI 结果优先；AI 缺失/失败时用「日期+原文」（最近 3 条）拼接兜底 */
    const summaryOf = (p: { id: string; name: string }) => {
      const us = byProject.get(p.id);
      if (!us?.length) return '无进展';
      const aiSum = aiMap.get(p.name);
      if (aiSum) return aiSum;
      return us
        .slice(-3)
        .map((u) => `${mdLabel(u.periodEnd)}${u.content}`)
        .join('');
    };
    const motto =
      aiMotto || this.config.get<string>('DINGTALK_DIGEST_MOTTO_DEFAULT', '做有心人，干困难事，立大格局');

    // 私聊汇总文本（排除配置中的项目，如「项目push」）
    const excludeNames = new Set(
      (this.config.get<string>('DINGTALK_DIGEST_EXCLUDE', '项目push') ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    );
    const dmTo = this.config.get<string>('DINGTALK_DIGEST_TO', '杨力');
    // 小红书风格排版：标题 + 每项目独立段落（空行分隔）+ 金句收尾
    const dmText = [
      `📣 团队工作进展（${todayMd(now)}）`,
      ...projects
        .filter((p) => !excludeNames.has(p.name))
        .map((p) => `📌 **${p.name}**\n${ensureDot(summaryOf(p))}`),
      `✨ ${ensureDot(motto)}`,
    ].join('\n\n');

    // 各项目群消息（有进展 + 已关联群 + 未关闭定时发送开关；保密项目不群发到外部钉钉群）
    const groupPayloads = withProgress
      .filter((p) => !p.confidential && !!p.dingtalkConversationId && p.dailyDigestEnabled)
      .map((p) => ({
        project: p.name,
        group: p.dingtalkGroupName ?? p.dingtalkConversationId!,
        conversationId: p.dingtalkConversationId!,
        text: `📣 **${p.name}** · 团队工作进展\n\n${ensureDot(summaryOf(p))}\n\n✨ ${ensureDot(motto)}`,
      }));

    // 私聊发送
    const dm: { to: string; text: string; sent: boolean; error?: string } = { to: dmTo, text: dmText, sent: false };
    if (!dryRun) {
      const r = await this.sendDws(['chat', '+dm', '--to', dmTo, '--content', dmText]);
      dm.sent = r.ok;
      dm.error = r.error;
      if (r.ok) this.logger.log(`每日总结已私聊发送给「${dmTo}」`);
      else this.logger.error(`每日总结私聊发送失败（${dmTo}）: ${r.error}`);
    }

    // 群发（onlyDm 只预览不发送）
    const groups: { project: string; group: string; text: string; sent: boolean; skipped: boolean; error?: string }[] =
      groupPayloads.map((g) => ({ project: g.project, group: g.group, text: g.text, sent: false, skipped: false }));
    if (!dryRun && !onlyDm) {
      for (const [i, g] of groupPayloads.entries()) {
        const r = await this.sendDws(['chat', '+send-to-group', '--group', g.conversationId, '--content', g.text]);
        groups[i].sent = r.ok;
        groups[i].error = r.error;
        if (r.ok) this.logger.log(`每日总结已发送到群「${g.group}」（${g.project}）`);
        else this.logger.error(`每日总结群发失败（${g.group}）: ${r.error}`);
      }
    } else if (onlyDm) {
      for (const g of groups) g.skipped = true;
    }

    return {
      dryRun,
      onlyDm,
      enabled: this.enabled,
      dwsAvailable: !!this.dwsJs,
      window: { since: fmtBeijing(since), until: fmtBeijing(now) },
      projects: projects.length,
      withProgress: withProgress.length,
      aiUsed: aiItems.length > 0,
      motto,
      dm,
      groups,
    };
  }

  /**
   * 单个项目：生成最近 48h 进展的小红书风群发文本（与全局总结同排版/同提示词）
   * - 无进展返回 hasProgress=false；AI 失败降级为「日期+原文」拼接 + 默认金句
   */
  async buildProjectDigestText(projectId: string): Promise<{ hasProgress: boolean; text?: string; name?: string }> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, name: true, dingtalkConversationId: true },
    });
    if (!project) throw new Error('项目不存在');
    const now = new Date();
    const since = new Date(now.getTime() - 48 * 3600_000);
    const us = await this.prisma.projectUpdate.findMany({
      where: { projectId, createdAt: { gte: since } },
      orderBy: { periodEnd: 'asc' },
      select: { content: true, periodEnd: true },
    });
    if (!us.length) return { hasProgress: false, name: project.name };
    const block = us
      .slice(-10)
      .map((u) => `- ${mdLabel(u.periodEnd)} ${u.content}`)
      .join('\n');
    let summary = '';
    let aiMotto = '';
    try {
      const ai = await this.ai.generateJson<{ motto?: string; items?: DigestItem[] }>('digest.daily', {
        projects: `【${project.name}】\n${block}`,
      });
      if (ai?.motto) aiMotto = ai.motto.trim();
      const hit = ai?.items?.find((it) => String(it.name ?? '').trim() === project.name) ?? ai?.items?.[0];
      if (hit?.summary) summary = String(hit.summary).trim();
    } catch {
      // AI 失败降级
    }
    if (!summary) {
      summary = us
        .slice(-3)
        .map((u) => `${mdLabel(u.periodEnd)}${u.content}`)
        .join('');
    }
    const motto = aiMotto || this.config.get<string>('DINGTALK_DIGEST_MOTTO_DEFAULT', '做有心人，干困难事，立大格局');
    const text = `📣 **${project.name}** · 团队工作进展\n\n${ensureDot(summary)}\n\n✨ ${ensureDot(motto)}`;
    return { hasProgress: true, text, name: project.name };
  }

  /**
   * 立即把某项目最近进展发到其绑定钉钉群（不要求开关/时间；无进展或无群则跳过）
   * - 发送成功则记录 digestLastSentDate=今日，避免当日定时 tick 重复发送
   */
  async sendProjectGroupNow(projectId: string): Promise<{ ok: boolean; skipped?: boolean; reason?: string; text?: string; error?: string }> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, name: true, confidential: true, dingtalkConversationId: true, dingtalkGroupName: true },
    });
    if (!project) throw new Error('项目不存在');
    // 保密项目不进外部钉钉群（无论定时还是手动“立即发送”）
    if (project.confidential) return { ok: false, skipped: true, reason: '保密项目不群发钉钉进展' };
    if (!project.dingtalkConversationId) return { ok: false, skipped: true, reason: '该项目未关联钉钉群' };
    const built = await this.buildProjectDigestText(projectId);
    if (!built.hasProgress) return { ok: false, skipped: true, reason: '该项目最近 48 小时无进展，未发送' };
    const r = await this.sendDws(['chat', '+send-to-group', '--group', project.dingtalkConversationId, '--content', built.text!]);
    if (r.ok) {
      const today = fmtBeijing(new Date()).slice(0, 10);
      await this.prisma.project.update({ where: { id: projectId }, data: { digestLastSentDate: today } });
      this.logger.log(`项目「${project.name}」进展已即时发送到群「${project.dingtalkGroupName ?? project.dingtalkConversationId}」`);
    } else {
      this.logger.error(`项目「${project.name}」即时群发失败: ${r.error}`);
    }
    return { ok: r.ok, text: built.text, error: r.error };
  }

  /**
   * 群发 tick（每 15 分钟一次，见 DailyDigestQueue）：逐个判定已开启的项目是否到期
   * 到期条件：当前北京时刻 >= 项目 digestTime 且 今日未发过（digestLastSentDate != today）
   *   且距上次发送天数 >= digestEveryDays（every<=1 视为每天）
   */
  async runGroupTick(): Promise<{ checked: number; sent: number }> {
    const now = new Date();
    const bj = fmtBeijing(now);
    const today = bj.slice(0, 10);
    const nowHHmm = bj.slice(11, 16);
    const due = await this.prisma.project.findMany({
      // 保密项目一律不进每日群发队列
      where: { archived: false, confidential: false, dailyDigestEnabled: true, dingtalkConversationId: { not: null } },
      select: { id: true, digestTime: true, digestEveryDays: true, digestLastSentDate: true },
    });
    let sent = 0;
    for (const p of due) {
      if (p.digestLastSentDate === today) continue; // 今天已发
      if (nowHHmm < (p.digestTime || '20:00')) continue; // 未到当日发送时刻
      const every = Math.max(1, p.digestEveryDays || 1);
      if (every > 1 && p.digestLastSentDate) {
        const gap = this.daysBetweenBeijing(p.digestLastSentDate, today);
        if (gap < every) continue; // 未达频率间隔
      }
      const r = await this.sendProjectGroupNow(p.id);
      if (r.ok) sent++;
      else if (r.skipped) {
        // 无进展/无群：标记今天已处理，避免下次 tick 重复尝试（到明天重新判定）
        await this.prisma.project.update({ where: { id: p.id }, data: { digestLastSentDate: today } });
      }
    }
    return { checked: due.length, sent };
  }

  /** 两个北京日期字符串 'YYYY-MM-DD' 相差天数（b - a；按 UTC 午夜解析，确定性） */
  private daysBetweenBeijing(a: string, b: string): number {
    return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
  }

  /** 调用 dws CLI 发送一条钉钉消息；失败仅返回错误信息，不中断其他发送 */
  private async sendDws(args: string[]): Promise<SendResult> {
    if (!this.dwsJs) return { ok: false, error: 'dws.js 未找到（请配置 DINGTALK_DWS_JS）' };
    try {
      const { stdout } = await execFileAsync('node', [this.dwsJs, ...args, '--yes', '--format', 'json'], {
        timeout: 90_000,
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
        encoding: 'utf8',
      });
      const text = (stdout ?? '').trim();
      if (text) {
        try {
          const data = JSON.parse(text) as any;
          if (data?.success === false) {
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
}
