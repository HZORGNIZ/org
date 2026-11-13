import { BadRequestException } from '@nestjs/common';

/**
 * 文档类型字典（项目文档 / 部门文档 / 在线知识文档共用）
 * 预置 6 类业务文档 + 「其他」兜底；同时允许 ≤12 字的自定义类型，
 * 支撑后续新增类型（如「测试用例」「验收报告」）时无需改代码。
 * 存库直接存中文名：展示零映射、DB 里可直接读懂，类型名属于稳定词表，无需 i18n。
 */
export const DOC_TYPE_PRESETS = [
  '产品需求文档',
  '硬件清单',
  '功能清单',
  '技术方案',
  '开发提示词',
  '接线文档',
  '其他',
] as const;

/** 自定义类型最大长度（中文按字符计，不含首尾空白） */
export const DOC_TYPE_MAX_LEN = 12;

/**
 * 收敛文档类型入参：空 → null（未分类）；去首尾空白、压缩连续空白；超长报 400。
 * 不限定必须在预置词表内——「等」的扩展靠自定义类型承接。
 */
export function normalizeDocType(input?: string | null): string | null {
  const v = String(input ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!v) return null;
  if (v.length > DOC_TYPE_MAX_LEN) {
    throw new BadRequestException(`文档类型不超过 ${DOC_TYPE_MAX_LEN} 个字`);
  }
  return v;
}
