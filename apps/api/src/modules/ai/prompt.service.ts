import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Prompt 集中管理服务
 * - 所有 AI 提示词存放在 prompts/ 目录下的 .md/.txt 文本文件，人工可直接编辑
 * - 推荐集中写在单个 PROMPTS.md 中，一个文件可包含多个提示词块
 * - 每个提示词块以 front-matter 开头：--- 块内 name/model/temperature/maxTokens（可带「# 功能说明：...」注释），--- 后为正文
 * - 正文使用 {{变量名}} 占位符
 * - 目录变化时热重载，修改提示词无需重启服务（注意：正文中避免使用行首 --- 作为分隔线）
 */
export interface PromptDefinition {
  name: string; // 提示词名（front-matter name，缺省用文件名）
  filePath: string;
  body: string; // 渲染后正文
  variables: string[]; // 用到的占位变量
  meta: {
    model?: string;
    temperature?: number;
    maxTokens?: number;
    /** 功能说明：front-matter 内「# 功能说明：...」注释，写入 AI 调用日志便于查看调用用途 */
    description?: string;
  };
  version: number; // 自增版本号，便于回溯
  updatedAt: Date;
}

const VAR_RE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

@Injectable()
export class PromptService implements OnModuleInit {
  private readonly logger = new Logger(PromptService.name);
  private promptsDir = '';
  private cache = new Map<string, PromptDefinition>();
  private watcher: fs.FSWatcher | null = null;
  private reloadTimer: NodeJS.Timeout | null = null;

  constructor(private config: ConfigService) {}

  onModuleInit() {
    this.promptsDir = this.resolvePromptsDir();
    if (!fs.existsSync(this.promptsDir)) {
      this.logger.warn(`prompts 目录不存在: ${this.promptsDir}，AI 提示词将不可用`);
      return;
    }
    this.loadAll();
    // 热重载：目录变化后 300ms 防抖重新加载
    this.watcher = fs.watch(this.promptsDir, () => {
      if (this.reloadTimer) clearTimeout(this.reloadTimer);
      this.reloadTimer = setTimeout(() => {
        this.loadAll();
        this.logger.log('prompts 目录已变更，已热重载');
      }, 300);
    });
    this.logger.log(`Prompt 服务已启动，目录: ${this.promptsDir}`);
  }

  /**
   * 定位 prompts 目录：优先使用 PROMPTS_DIR 环境变量，
   * 否则从当前工作目录逐级向上查找（兼容 monorepo 中不同启动位置）
   */
  private resolvePromptsDir(): string {
    const fromEnv = this.config.get<string>('PROMPTS_DIR');
    if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
    let dir = process.cwd();
    for (let i = 0; i < 5; i++) {
      const candidate = path.join(dir, 'prompts');
      if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) return candidate;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return path.join(process.cwd(), 'prompts');
  }

  onModuleDestroy() {
    this.watcher?.close();
  }

  private loadAll() {
    const files = fs
      .readdirSync(this.promptsDir)
      .filter((f) => f.endsWith('.md') || f.endsWith('.txt'));
    this.cache.clear();
    for (const file of files) {
      try {
        const raw = fs.readFileSync(path.join(this.promptsDir, file), 'utf-8');
        const fileBase = file.replace(/\.(md|txt)$/, '');
        // 一个文件可含多个提示词块：front-matter（--- 起止）+ 正文；
        // 正文 = 本块 front-matter 结束到下一块 front-matter 开始之间的文本
        const fmMatches: { fm: string; start: number; end: number }[] = [];
        const fmRe = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/gm;
        let fmMatch: RegExpExecArray | null;
        while ((fmMatch = fmRe.exec(raw)) !== null) {
          fmMatches.push({ fm: fmMatch[1], start: fmMatch.index, end: fmMatch.index + fmMatch[0].length });
        }
        let registered = 0;
        for (let i = 0; i < fmMatches.length; i++) {
          const cur = fmMatches[i];
          const body = raw
            .slice(cur.end, i + 1 < fmMatches.length ? fmMatches[i + 1].start : raw.length)
            .trim();
          if (!body) continue;
          const meta = this.parseFrontMatterKeys(cur.fm);
          this.register(meta.name ?? fileBase, file, body, meta);
          registered++;
        }
        // 整个文件都没有 front-matter：视为旧格式单 prompt
        if (registered === 0) {
          const { body, meta } = this.parseFrontMatter(raw);
          if (body) this.register(fileBase, file, body, meta);
        }
      } catch (e) {
        this.logger.error(`加载 prompt 失败: ${file}`, e as Error);
      }
    }
    this.logger.log(`已加载 ${this.cache.size} 个 prompt: ${[...this.cache.keys()].join(', ')}`);
  }

  private register(name: string, file: string, body: string, meta: PromptDefinition['meta'] & { name?: string }) {
    const { name: _n, ...rest } = meta;
    const variables = [...new Set(body.match(VAR_RE)?.map((m) => m.replace(VAR_RE, '$1')) ?? [])];
    const stat = fs.statSync(path.join(this.promptsDir, file));
    this.cache.set(name, {
      name,
      filePath: path.join(this.promptsDir, file),
      body,
      variables,
      meta: rest,
      version: Math.floor(stat.mtimeMs),
      updatedAt: stat.mtime,
    });
  }

  /** 解析 YAML front-matter 键值（name/model/temperature/maxTokens；「# 功能说明：...」注释提取为 description） */
  private parseFrontMatterKeys(fmText: string): PromptDefinition['meta'] & { name?: string } {
    const meta: PromptDefinition['meta'] & { name?: string } = {};
    for (const line of fmText.split(/\r?\n/)) {
      const desc = line.match(/^\s*#\s*功能说明[：:]\s*(.+?)\s*$/);
      if (desc) {
        meta.description = desc[1];
        continue;
      }
      const kv = line.match(/^\s*([a-zA-Z0-9_]+)\s*:\s*(.+)\s*$/);
      if (!kv) continue;
      const [, key, value] = kv;
      if (key === 'name') meta.name = value.trim();
      else if (key === 'model') meta.model = value.trim();
      else if (key === 'temperature') meta.temperature = Number(value.trim());
      else if (key === 'maxTokens') meta.maxTokens = Number(value.trim());
    }
    return meta;
  }

  /** 解析 YAML front-matter（--- ... ---）与正文（兼容旧格式单文件） */
  private parseFrontMatter(raw: string): { body: string; meta: PromptDefinition['meta'] & { name?: string } } {
    const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
    if (m) {
      return { body: m[2].trim(), meta: this.parseFrontMatterKeys(m[1]) };
    }
    return { body: raw.trim(), meta: {} };
  }

  list(): Omit<PromptDefinition, 'body'>[] {
    return [...this.cache.values()].map(({ body: _b, ...rest }) => rest);
  }

  get(name: string): PromptDefinition | undefined {
    return this.cache.get(name);
  }

  /** 渲染 prompt：填充 {{变量}}，缺失变量保持原样（便于发现） */
  render(name: string, variables: Record<string, unknown>): string {
    const prompt = this.cache.get(name);
    if (!prompt) throw new Error(`prompt 不存在: ${name}（请检查 prompts/ 目录）`);
    let out = prompt.body;
    for (const v of prompt.variables) {
      const value = variables[v];
      if (value !== undefined && value !== null) {
        out = out.split(`{{${v}}}`).join(typeof value === 'string' ? value : JSON.stringify(value));
      }
    }
    return out;
  }

  meta(name: string) {
    return this.cache.get(name)?.meta ?? {};
  }
}
