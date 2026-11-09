/** 榜单行：rank 名次 / name 姓名 / sub 部门等副信息 / value 已格式化的得分、时长或篇数 */
export interface RankRow {
  rank: number;
  name: string;
  sub?: string;
  value: string;
}

/** 首页轮播榜单卡的一页：小 tab 的标题 + 副标题 + 行数据 */
export interface RankTab {
  key: string;
  label: string;
  subtitle?: string;
  rows: RankRow[];
  emptyText?: string;
}
