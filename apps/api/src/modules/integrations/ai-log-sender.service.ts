import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { execFile } from 'child_process';
import { existsSync } from 'fs';
import { basename, dirname, join, resolve } from 'path';
import { promisify } from 'util';
import { fmtBeijingDate } from '../../common/beijing-time';
import { PrismaService } from '../../common/prisma.service';
import { promptLogFileName, resolvePromptLogDir } from '../ai/ai.service';
import { resolveDwsJs } from './dingtalk-fetch.service';
import { AI_LOG_ENABLED_KEY } from './ai-log-sender.queue';

const execFileAsync = promisify(execFile);

interface SendResult {
  ok: boolean;
  error?: string;
}

/**
 * 每日 AI 提示词日志发送（默认每天 08:00，见 AiLogSenderQueue）
 * - 把前一天（北京时间）的 ai-prompts-YYYY-MM-DD.log（AiService 每次 DeepSeek 调用写入）
 *   通过钉钉私聊发送给 DINGTALK_DIGEST_TO（默认杨力）
 * - 日志文件不存在（当日无 AI 调用）时发一条文本说明，不算失败
 * - dws 文件消息要求 --file 为相对路径：以日志目录的父目录为工作目录传 `logs/文件名`
 *   （dws 拒绝绝对路径：--file must be a relative path within the current directory）
 * - 「每天自动发送」开关存 Setting 表（管理后台设置，见 AiLogSenderQueue）；
 *   自动路径（worker）在关闭时跳过；manual=true（管理后台「立即发送」）不受开关限制
 */
@Injectable()
export class AiLogSenderService {
  private readonly logger = new Logger(AiLogSenderService.name);
  private readonly dwsJs: string;
  /** 日志目录（绝对路径；与 AiService 写入共用 resolvePromptLogDir 口径） */
  private readonly logDir: string;
  private readonly to: string;

  constructor(
    private config: ConfigService,
    private prisma: PrismaService,
  ) {
    this.dwsJs = resolveDwsJs(this.config.get<string>('DINGTALK_DWS_JS', ''));
    this.logDir = resolve(resolvePromptLogDir(this.config));
    this.to = this.config.get<string>('DINGTALK_DIGEST_TO', '杨力');
    if (!this.dwsJs) {
      this.logger.warn('未找到 dws.js（dingtalk-workspace-cli），AI 日志发送将不可用（可用 DINGTALK_DWS_JS 指定路径）');
    }
  }

  /** 每天自动发送开关：Setting 表优先（管理后台），未设置回退 DINGTALK_AI_LOG_ENABLED（默认 true） */
  private async resolveEnabled(): Promise<boolean> {
    try {
      const row = await this.prisma.setting.findUnique({ where: { key: AI_LOG_ENABLED_KEY } });
      const enabled = (row?.value as any)?.enabled;
      if (typeof enabled === 'boolean') return enabled;
    } catch (e) {
      this.logger.error(`读取 AI 日志开关设置失败（回退环境变量）: ${(e as Error).message}`);
    }
    return this.config.get<string>('DINGTALK_AI_LOG_ENABLED', 'true') === 'true';
  }

  /**
   * 发送某天的 AI 提示词日志文件到钉钉
   * - manual=true（管理后台「立即发送」）：不受「每天自动发送」开关限制
   * - 自动路径（worker）：开关关闭时跳过，双保险（调度器已移除）
   */
  async run(opts: { date?: string; dryRun?: boolean; manual?: boolean } = {}) {
    const dryRun = !!opts.dryRun;
    if (!opts.manual && !dryRun && !(await this.resolveEnabled())) {
      return { skipped: true, reason: '「每天自动发送」已关闭（管理后台开关）' };
    }
    const date = this.normalizeDate(opts.date);
    const fileName = promptLogFileName(date);
    const file = join(this.logDir, fileName);
    const base = { date, file, to: this.to, dwsAvailable: !!this.dwsJs };

    // 文件不存在（当日无 AI 调用）：发文本说明，不算失败
    if (!existsSync(file)) {
      const text = `📄 AI 调用日志（${date}）：当日无 DeepSeek 调用记录（未生成 ${fileName}）。`;
      if (dryRun) return { ...base, exists: false, sent: false, preview: text };
      const r = await this.sendDws(['chat', '+dm', '--to', this.to, '--content', text]);
      if (r.ok) this.logger.log(`已私聊「${this.to}」告知：${date} 无 AI 调用日志`);
      else this.logger.error(`无日志通知发送失败（${this.to}）: ${r.error}`);
      return { ...base, exists: false, sent: r.ok, error: r.error };
    }

    // dws 要求 --file 为相对路径（相对其进程工作目录）：以日志目录的父目录为 cwd，传 `logs/文件名`
    const cwd = dirname(this.logDir);
    const relFile = `${basename(this.logDir)}/${fileName}`;
    const args = ['chat', '+messages-send', '--as', 'user', '--user', this.to, '--msg-type', 'file', '--file', relFile];
    if (dryRun) args.push('--dry-run');
    const r = await this.sendDws(args, cwd);
    if (dryRun) this.logger.log(`AI 调用日志（${date}）dryRun 预览${r.ok ? '通过' : `失败: ${r.error}`}（未实际发送）`);
    else if (r.ok) this.logger.log(`AI 调用日志（${date}）已私聊发送给「${this.to}」`);
    else this.logger.error(`AI 调用日志发送失败（${this.to}）: ${r.error}`);
    return { ...base, exists: true, cwd, relFile, sent: r.ok, error: r.error };
  }

  /** 目标日期：默认前一天（北京时间）；入参须为 YYYY-MM-DD */
  private normalizeDate(date?: string) {
    const d = (date ?? '').trim();
    if (d) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) {
        throw new BadRequestException('date 格式须为 YYYY-MM-DD（北京时间日期）');
      }
      return d;
    }
    return fmtBeijingDate(new Date(Date.now() - 86400_000));
  }

  /** 调用 dws CLI；失败仅返回错误信息，不中断主流程（cwd 用于 --file 相对路径基准） */
  private async sendDws(args: string[], cwd?: string): Promise<SendResult> {
    if (!this.dwsJs) return { ok: false, error: 'dws.js 未找到（请配置 DINGTALK_DWS_JS）' };
    try {
      const { stdout } = await execFileAsync('node', [this.dwsJs, ...args, '--yes', '--format', 'json'], {
        timeout: 90_000,
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
        encoding: 'utf8',
        cwd,
      });
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
}
