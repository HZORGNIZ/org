import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { appendFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { PromptService } from './prompt.service';
import { CN_OFFSET_MS, fmtBeijing, fmtBeijingDate } from '../../common/beijing-time';
import { PrismaService } from '../../common/prisma.service';

export interface AiGenerateOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  /** 追加到 prompt 末尾的系统说明 */
  system?: string;
  /**
   * 多轮对话前置消息（管理者 Agent 用）：置于渲染 prompt 之前，作为历史上下文；
   * prompt 本体（含最新指令/工具约定）仍排最后，不影响提示词日志与 AiCallLog 落库链路
   */
  extraMessages?: { role: 'system' | 'user' | 'assistant'; content: string }[];
}

/** AI 提示词日志目录：AI_PROMPT_LOG_DIR 优先，默认 <进程工作目录>/logs（写入与发送共用同一口径） */
export function resolvePromptLogDir(config: ConfigService): string {
  return (config.get<string>('AI_PROMPT_LOG_DIR', '') || '').trim() || join(process.cwd(), 'logs');
}

/** 提示词日志文件名（按北京日期，每天一个文件）；dateText 形如 2026-09-20 */
export function promptLogFileName(dateText: string): string {
  return `ai-prompts-${dateText}.log`;
}

/**
 * AI 服务：统一封装 DeepSeek（OpenAI 兼容协议）
 * - 模型与地址通过环境变量配置，可切换到任意兼容模型
 * - 提示词全部来自 PromptService（prompts/ 目录）
 * - 直接使用原生 fetch 非流式调用（部分模型与 @ai-sdk 流式解析不兼容，会返回空内容）
 * - AI 不可用时返回 null（业务层降级，不影响主流程）
 * - 每次调用的输入提示词按北京时间日期写入 logs/ai-prompts-YYYY-MM-DD.log（每天一个文件）
 * - 每次实际调用同时异步落库 AiCallLog（管理后台「大模型调用」页可按天查看提示词与返回结果）
 */
@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);
  private baseURL = 'https://api.deepseek.com/v1';
  private apiKey = '';
  private defaultModel = 'deepseek-chat';
  private timeoutMs = 60000;
  /** 提示词日志目录（默认 <进程工作目录>/logs，可用 AI_PROMPT_LOG_DIR 指向挂载路径） */
  private promptLogDir = '';
  /** 日志串行写队列：并发调用时按顺序落盘，异步写入不阻塞 AI 主流程 */
  private promptLogChain: Promise<void> = Promise.resolve();

  constructor(
    private config: ConfigService,
    private prompts: PromptService,
    private prisma: PrismaService,
  ) {
    this.baseURL = this.config.get<string>('AI_BASE_URL', 'https://api.deepseek.com/v1').replace(/\/+$/, '');
    this.apiKey = this.config.get<string>('AI_API_KEY', '');
    this.defaultModel = this.config.get<string>('AI_MODEL', 'deepseek-chat');
    this.timeoutMs = Number(this.config.get<string>('AI_TIMEOUT_MS', '60000'));
    this.promptLogDir = resolvePromptLogDir(this.config);
    if (!this.apiKey) {
      this.logger.warn('未配置 AI_API_KEY，AI 功能将不可用（业务层会自动降级）');
    }
  }

  get enabled() {
    return !!this.apiKey;
  }

  /** 按 prompt 名生成文本 */
  async generate(
    promptName: string,
    variables: Record<string, unknown>,
    options: AiGenerateOptions = {},
  ): Promise<string | null> {
    return this.generateInternal(promptName, variables, options, this.detectCaller(new Error().stack ?? ''));
  }

  /**
   * 生成核心（generate / generateJson 共用）
   * - 调用来源在同步入口处捕获后传入：重试或跨 await 恢复时栈上已无调用方，只能在入口处截获
   */
  private async generateInternal(
    promptName: string,
    variables: Record<string, unknown>,
    options: AiGenerateOptions,
    caller: string,
  ): Promise<string | null> {
    if (!this.apiKey) return null;
    const promptText = this.prompts.render(promptName, variables);
    const meta = this.prompts.meta(promptName);
    const messages: { role: string; content: string }[] = [];
    if (options.system) messages.push({ role: 'system', content: options.system });
    // 多轮对话：历史消息在前，本次渲染的 prompt（角色设定+最新数据+输出契约）在最后
    if (options.extraMessages?.length) messages.push(...options.extraMessages);
    messages.push({ role: 'user', content: promptText });
    const body: { model: string; messages: any[]; temperature?: number; max_tokens?: number } = {
      model: options.model ?? meta.model ?? this.defaultModel,
      messages,
      temperature: options.temperature ?? meta.temperature,
      max_tokens: options.maxTokens ?? meta.maxTokens,
    };
    // 推理模型（如 deepseek-v4-flash）会先输出大段 reasoning_content：
    // 其思考长度波动极大（同一任务有时 <1000 token 直接成功，有时 >8000 仍被截断），
    // 实测放大 max_tokens 到 8192 仍会 length 且单次耗时 70s+、费用高——因此不放大预算，
    // 改为同预算最多重试 3 次（思考短的采样会成功）；仍空则尝试从 reasoning_content 提取 JSON 块
    const description = this.prompts.meta(promptName).description;
    // 完整输入提示词（按角色拼接），每次调用落库用
    const callPromptText = messages
      .map((m) => `--- ${m.role} ---\n${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`)
      .join('\n');
    for (let attempt = 1; attempt <= 3; attempt++) {
      // 记录本次 DeepSeek 调用的输入提示词（按日期分文件；失败不影响调用）
      this.writePromptLog(promptName, body.model, messages, attempt, caller);
      const startedAt = Date.now();
      try {
        const res = await fetch(`${this.baseURL}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (!res.ok) {
          const detail = await res.text().catch(() => '');
          // 账户级错误（402 余额不足 / 401 密钥失效）：重试无意义，直接降级
          if (res.status === 402 || res.status === 401) {
            this.logger.error(`AI 调用被拒 [${promptName}]（HTTP ${res.status}，账户级错误，不再重试）`);
            this.recordCall({
              promptName, description, caller, model: body.model, attempt,
              status: 'ERROR', error: `HTTP ${res.status} ${detail.slice(0, 200)}`,
              durationMs: Date.now() - startedAt, promptText: callPromptText,
            });
            return null;
          }
          throw new Error(`HTTP ${res.status} ${detail.slice(0, 200)}`);
        }
        const data = (await res.json()) as any;
        const choice = data?.choices?.[0];
        const message = choice?.message;
        const truncated = choice?.finish_reason === 'length';
        let content: string | undefined = message?.content;
        if (!(typeof content === 'string' && content.trim())) {
          const reasoning = message?.reasoning_content;
          if (typeof reasoning === 'string' && reasoning.trim()) {
            const jsonBlock = reasoning.match(/\{[\s\S]*\}/);
            if (jsonBlock) content = jsonBlock[0];
          }
        }
        const usable = typeof content === 'string' && !!content.trim() && !truncated;
        // 每次实际调用落库（含成功/截断/空返回），供管理后台「大模型调用」页查看
        this.recordCall({
          promptName, description, caller, model: body.model, attempt, promptText: callPromptText,
          status: usable ? 'SUCCESS' : truncated ? 'TRUNCATED' : 'EMPTY',
          response: typeof content === 'string' && content.trim() ? content : null,
          finishReason: choice?.finish_reason ?? null,
          promptTokens: data?.usage?.prompt_tokens ?? null,
          completionTokens: data?.usage?.completion_tokens ?? null,
          durationMs: Date.now() - startedAt,
        });
        // 完整输出（或从 reasoning 兜底提取到内容）且未被截断 → 直接返回
        if (usable) return content as string;
        if (attempt >= 3) break;
        this.logger.warn(
          truncated
            ? `AI 输出被 token 截断 [${promptName}]（finish_reason=length，思考过长），同预算重试 ${3 - attempt} 次`
            : `AI 返回空内容 [${promptName}]，重试 ${3 - attempt} 次`,
        );
      } catch (e: any) {
        this.recordCall({
          promptName, description, caller, model: body.model, attempt, promptText: callPromptText,
          status: 'ERROR', error: String(e?.message ?? e),
          durationMs: Date.now() - startedAt,
        });
        this.logger.error(`AI 调用失败 [${promptName}]（attempt ${attempt}）: ${e?.message ?? e}`);
        if (attempt >= 3) return null;
      }
    }
    this.logger.warn(`AI 连续三次未返回可用内容 [${promptName}]，已降级`);
    return null;
  }

  /** 生成并尝试解析 JSON（失败返回 null；解析失败时重试一次，兜底提取 JSON 块） */
  async generateJson<T>(
    promptName: string,
    variables: Record<string, unknown>,
    options: AiGenerateOptions = {},
  ): Promise<T | null> {
    // 在入口同步捕获来源：进入重试轮次后栈上已无真实调用方
    const caller = this.detectCaller(new Error().stack ?? '');
    for (let round = 1; round <= 2; round++) {
      const text = await this.generateInternal(promptName, variables, options, caller);
      if (!text) return null;
      const parsed = this.tryParseJson(text);
      if (parsed !== undefined) return parsed as T;
      if (round === 1) this.logger.warn(`AI 返回内容不是合法 JSON [${promptName}]，重试一次`);
    }
    this.logger.warn(`AI 返回内容不是合法 JSON [${promptName}]，已降级`);
    return null;
  }

  /**
   * 记录一次 DeepSeek 调用的输入提示词
   * - 文件按北京时间日期分：logs/ai-prompts-YYYY-MM-DD.log，每天一个文件
   * - 不依赖容器时区（线上为 UTC，用 UTC 日期会让 0-8 点间的记录串到前一天）
   * - 每次调用带醒目分隔横幅：标注 来源（调用方类.方法）与 功能（提示词功能说明），末尾带 END 标记
   * - 异步串行追加，失败仅告警，绝不影响 AI 主流程
   */
  private writePromptLog(promptName: string, model: string, messages: any[], attempt: number, caller: string) {
    const now = new Date();
    const time = fmtBeijing(now);
    const file = join(this.promptLogDir, promptLogFileName(fmtBeijingDate(now)));
    const desc = this.prompts.meta(promptName).description;
    const banner = '='.repeat(96);
    const lines = [
      '', // 段前空行：与上一次调用内容拉开距离
      banner,
      `===== ${time} | prompt=${promptName} | model=${model} | attempt=${attempt}/3 =====`,
      `===== 来源: ${caller || 'unknown'} =====`,
    ];
    if (desc) lines.push(`===== 功能: ${desc} =====`);
    lines.push(banner);
    for (const m of messages) {
      lines.push(`--- ${m.role} ---`);
      lines.push(typeof m.content === 'string' ? m.content : JSON.stringify(m.content));
    }
    lines.push('-'.repeat(96));
    lines.push(`===== END | ${time} | prompt=${promptName} | attempt=${attempt}/3 =====`);
    const text = lines.join('\n') + '\n';
    this.promptLogChain = this.promptLogChain
      .then(() => mkdir(this.promptLogDir, { recursive: true }))
      .then(() => appendFile(file, text, 'utf8'))
      .catch((e: any) => {
        this.logger.warn(`提示词日志写入失败（${file}）: ${e?.message ?? e}`);
      });
  }

  /**
   * 每次实际调用大模型落一条记录（管理后台「大模型调用」页，按天查看调用缘由/完整提示词/返回结果）
   * - 时间口径：与 MessageInbox.receivedAt 相同，存【北京墙钟字面量】（不依赖容器时区，按天查询无需换算）
   * - 异步写库、失败仅告警，绝不影响 AI 主流程
   */
  private recordCall(entry: {
    promptName: string;
    description?: string;
    caller: string;
    model: string;
    attempt: number;
    status: 'SUCCESS' | 'TRUNCATED' | 'EMPTY' | 'ERROR';
    durationMs: number;
    promptText: string;
    response?: string | null;
    finishReason?: string | null;
    promptTokens?: number | null;
    completionTokens?: number | null;
    error?: string | null;
  }) {
    const createdAt = new Date(Date.now() + CN_OFFSET_MS); // 北京墙钟字面量（当 UTC 存）
    this.prisma.aiCallLog
      .create({
        data: {
          createdAt,
          promptName: entry.promptName,
          description: entry.description ?? null,
          caller: entry.caller || null,
          model: entry.model,
          attempt: entry.attempt,
          status: entry.status,
          durationMs: entry.durationMs,
          promptText: entry.promptText,
          response: entry.response ?? null,
          finishReason: entry.finishReason ?? null,
          promptTokens: entry.promptTokens ?? null,
          completionTokens: entry.completionTokens ?? null,
          error: entry.error ? entry.error.slice(0, 500) : null,
        },
      })
      .catch((e: any) => this.logger.warn(`AI 调用记录写库失败 [${entry.promptName}]: ${e?.message ?? e}`));
  }

  /**
   * 从调用栈推断调用来源（首个非 AiService 帧的「类.方法」）
   * - 用于日志标注这次调用是哪个模块/功能触发的；识别不出时返回空串（日志显示 unknown）
   * - 编译产物由 tsc 生成、无混淆，类名与方法名保留，线上容器同样可用
   */
  private detectCaller(stack: string): string {
    const skip = new Set(['AiService', 'Object', 'Promise', 'Array', 'Function', 'Module', 'AsyncResource']);
    for (const line of stack.split('\n')) {
      const m = /^\s*at\s+(?:async\s+)?([A-Za-z_$][\w$]*)\.([\w$<>]+)\s+\(/.exec(line);
      if (!m || skip.has(m[1])) continue;
      return `${m[1]}.${m[2]}`;
    }
    return '';
  }

  /** 尝试解析 JSON：先整体解析，失败则提取首个 { 到最后一个 } 的 JSON 块（模型可能附加说明文字） */
  private tryParseJson(text: string): unknown {
    const candidates: string[] = [text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()];
    const jsonBlock = text.match(/\{[\s\S]*\}/);
    if (jsonBlock) {
      candidates.push(jsonBlock[0].replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim());
    }
    for (const candidate of candidates) {
      try {
        return JSON.parse(candidate);
      } catch {
        // 尝试下一个候选
      }
    }
    return undefined;
  }
}
