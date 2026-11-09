/**
 * 人名头像：现场看板与自由组队共用，保证同一个人两边颜色、文字一致
 */
const AVATAR_COLORS = ['#3b6ef6', '#7c4dcc', '#0f9d7c', '#e6632b', '#c9a227', '#2a9df4', '#d0482f', '#5aa469', '#8a63d2', '#e2b93b'];

/** 同一名字稳定映射同一个颜色，全场头像不撞脸也好认人 */
export function avatarColor(name: string) {
  let h = 0;
  for (const ch of name || '?') h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

/** 中文取末两字（更像昵称），英文取首字母 */
export function avatarText(name: string) {
  const n = (name || '?').trim();
  if ([...n].length <= 2) return n;
  return /[\u4e00-\u9fff]/.test(n) ? [...n].slice(-2).join('') : n.slice(0, 2).toUpperCase();
}

/** 签到时二选一的性别：只认男 / 女，其它（老数据、没扫过码的同事）返回空 */
export function genderOf(v: unknown): '' | 'MALE' | 'FEMALE' {
  const g = String(v ?? '').trim().toUpperCase();
  if (g === 'MALE' || g === 'M' || g === '男') return 'MALE';
  if (g === 'FEMALE' || g === 'F' || g === '女') return 'FEMALE';
  return '';
}

/**
 * 性别配色：男士浅蓝、女士浅粉（浅底要配深色字才看得清）
 * 没填性别的沿用名字散列色，所以这里返回 null 让调用方自己兜底
 */
export function genderTone(v: unknown): { background: string; color: string; borderColor: string } | null {
  const g = genderOf(v);
  if (g === 'MALE') return { background: '#d7e8ff', color: '#1a4c9e', borderColor: '#a9c9f2' };
  if (g === 'FEMALE') return { background: '#ffdcea', color: '#a33166', borderColor: '#f5b8cf' };
  return null;
}

/** 实心圆头像（管理面板 / 自由组队）：有性别用浅蓝浅粉 + 深色字，没性别按名字散列 + 白字 */
export function avatarInk(person: { name?: string; gender?: unknown }): { background: string; color: string } {
  const tone = genderTone(person.gender);
  if (tone) return { background: tone.background, color: tone.color };
  return { background: avatarColor(person.name || '?'), color: '#fff' };
}
