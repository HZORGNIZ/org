// 「日报文档式时间轴」（components/ReportDoc.vue）的数据形状。
// 单独放一个文件：SFC 的 <script setup> 里不能写 ES 导出，但调用方要复用这些类型。

/** 小标签（工时、归属项目、状态…）——文案由调用方拼好，组件只管排版 */
export interface DocTag {
  label: string;
  type?: 'success' | 'warning' | 'info' | 'danger' | 'primary';
}

export interface DocEntry {
  key?: string | number;
  /** 姓名（或「我」「团队」） */
  name: string;
  tags?: DocTag[];
  /** 姓名右侧的灰色补充信息：来源、更新时间、部门等，调用方拼成一串 */
  meta?: string;
  /** 分组标题（如部门名）；与上一条不同则在其上方插一行组标题 */
  dept?: string | null;
  /** false = 未提交：姓名置灰并标「未提交」 */
  submitted?: boolean;
  content?: string;
  /** 原对象，open 事件原样回传给调用方（如用它打开日报详情抽屉） */
  raw?: any;
}

export interface DocDay {
  key: string | number;
  /** 日期节点主文字，如「2026-10-30」或周标签 */
  label: string;
  /** 日期下的补充说明，如「周五」 */
  sub?: string;
  entries: DocEntry[];
}
