/**
 * 文档类型字典（前端）——与后端 apps/api/src/common/doc-types.ts 保持一致
 *
 * 预置 6 类业务文档 + 「其他」兜底，另允许 ≤12 字自定义类型（上传/修改时可直接输入），
 * 支撑「等」的扩展：以后要加「测试用例」「验收报告」直接用自定义类型，不必改代码。
 * 存库即中文名，展示零映射。
 */
export type DocTypeColor = 'primary' | 'success' | 'warning' | 'info' | 'danger';

export const DOC_TYPE_MAX_LEN = 12;

export const DOC_TYPE_PRESETS: { value: string; color: DocTypeColor; hint?: string }[] = [
  { value: '产品需求文档', color: 'primary', hint: '需求背景、目标用户、功能范围、验收标准' },
  { value: '功能清单', color: 'success', hint: '功能点、优先级、开发状态' },
  { value: '技术方案', color: 'warning', hint: '架构、技术选型、接口与数据设计' },
  { value: '硬件清单', color: 'warning', hint: '元件型号、数量、供应商' },
  { value: '接线文档', color: 'danger', hint: '引脚定义、接线图、供电说明' },
  { value: '开发提示词', color: 'info', hint: '给 AI 的开发上下文与约束' },
  { value: '其他', color: 'info' },
];

export const DOC_TYPE_NAMES = DOC_TYPE_PRESETS.map((d) => d.value);

/** 类型 → 标签样式；未知/自定义类型统一走 info，未分类走空类型（灰） */
export function docTypeMeta(v?: string | null): { label: string; color: DocTypeColor; custom: boolean } {
  const value = (v ?? '').trim();
  if (!value) return { label: '未分类', color: 'info', custom: false };
  const hit = DOC_TYPE_PRESETS.find((d) => d.value === value);
  if (hit) return { label: value, color: hit.color, custom: false };
  return { label: value, color: 'info', custom: true };
}

/** 下拉可选类型：预置词表 + 本空间已用过的自定义类型（去重，保持预置在前） */
export function docTypeOptions(used: (string | null | undefined)[] = []): string[] {
  const extra = Array.from(
    new Set(
      used
        .map((u) => (u ?? '').trim())
        .filter((u) => !!u && !DOC_TYPE_NAMES.includes(u)),
    ),
  ).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
  return [...DOC_TYPE_NAMES, ...extra];
}
