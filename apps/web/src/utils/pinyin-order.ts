/**
 * 姓名拼音排序与 A–Z 分段（全员补签矩阵用）。
 *
 * 只借浏览器自带的 ICU：`Intl.Collator('zh-Hans-CN')` 对简体中文默认就是拼音序，
 * 不额外引第三方拼音库（容器里的 Node 不一定带 full-icu，矩阵反正只在浏览器渲染，排序就放前端）。
 */

const collator = new Intl.Collator('zh-Hans-CN', { sensitivity: 'base' });

/**
 * 各字母段在拼音排序下的起始代表字（该段第一个常见汉字）。
 * 汉语拼音方案里没有独立 I / U / Ü 声母段，所以表里不列，自然并入相邻段。
 */
const BOUNDS: Array<[string, string]> = [
  ['A', '阿'],
  ['B', '芭'],
  ['C', '擦'],
  ['D', '搭'],
  ['E', '蛾'],
  ['F', '发'],
  ['G', '噶'],
  ['H', '哈'],
  ['J', '击'],
  ['K', '喀'],
  ['L', '垃'],
  ['M', '妈'],
  ['N', '拿'],
  ['O', '哦'],
  ['P', '啪'],
  ['Q', '期'],
  ['R', '然'],
  ['S', '撒'],
  ['T', '塌'],
  ['W', '挖'],
  ['X', '昔'],
  ['Y', '压'],
  ['Z', '匝'],
];

/** 只认常用汉字区，英文/数字/符号开头的名字一律归到末尾的 # 段 */
const HAN = /[一-鿿]/;

/** 姓名首字属于哪个字母段；多音姓氏（曾/单/查 等）按本音归段，所以矩阵必须配搜索框兜底 */
export function pinyinLetter(name: string): string {
  const ch = String(name ?? '').trim().charAt(0);
  if (!ch || !HAN.test(ch)) return '#';
  // BOUNDS 本身按字母升序，倒着找第一个「不大于该字」的边界就是它所在段
  for (let i = BOUNDS.length - 1; i >= 0; i--) {
    if (collator.compare(ch, BOUNDS[i][1]) >= 0) return BOUNDS[i][0];
  }
  return 'A';
}

/** 按拼音全拼比较；同名同字时退回原串比较，保证顺序稳定 */
export function byPinyin(a: { name?: string | null }, b: { name?: string | null }) {
  const x = String(a?.name ?? '');
  const y = String(b?.name ?? '');
  return collator.compare(x, y) || x.localeCompare(y);
}

/** 分成 A–Z 段（# 段排最后），组内按拼音排序 */
export function groupByLetter<T extends { name?: string | null }>(list: T[]): { letter: string; items: T[] }[] {
  const map = new Map<string, T[]>();
  for (const it of list) {
    const key = pinyinLetter(String(it?.name ?? ''));
    const bucket = map.get(key);
    if (bucket) bucket.push(it);
    else map.set(key, [it]);
  }
  return [...map.entries()]
    .sort((a, b) => (a[0] === '#' ? 1 : b[0] === '#' ? -1 : a[0].localeCompare(b[0])))
    .map(([letter, items]) => ({ letter, items: items.sort(byPinyin) }));
}
