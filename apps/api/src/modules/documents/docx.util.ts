import { deflateRawSync, inflateRawSync } from 'zlib';

/**
 * docx 在线编辑支撑工具（零新增依赖）
 * - OOXML 本质是 zip：这里自实现 zip 打包/解包（readZip 仅用于自检与往返校验）
 * - buildDocxFromHtml：把在线编辑器（及 mammoth）产出的受限 HTML 转成合法 .docx
 * - docxToHtml：用项目已装的 mammoth 把 .docx 解析为 HTML 供浏览器编辑
 * 已知取舍（与用户确认过的「轻量内置」方案一致）：保留文字/基础排版/表格/列表/链接/图片，
 * 不保留复杂样式（SmartArt、公式、嵌入对象、原文档自定义母版）。
 */

// ---------------- zip ----------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(d: Date) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

export interface ZipEntry {
  name: string;
  data: Buffer;
  /** 已压缩的二进制（图片等）用 stored，避免二次压缩 */
  stored?: boolean;
}

/** 打包 zip（deflate 或 stored），返回 Buffer */
export function createZip(entries: ZipEntry[], mtime = new Date()): Buffer {
  const { time, date } = dosDateTime(mtime);
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const method = e.stored ? 0 : 8;
    const comp = e.stored ? e.data : deflateRawSync(e.data, { level: 9 });
    const crc = crc32(e.data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6); // UTF-8 文件名
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(time, 10);
    lh.writeUInt16LE(date, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(e.data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    locals.push(lh, nameBuf, comp);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(time, 12);
    ch.writeUInt16LE(date, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(e.data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(0, 38); // external attrs
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, nameBuf);

    offset += lh.length + nameBuf.length + comp.length;
  }
  const central = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, central, eocd]);
}

/** 解包 zip（用于校验生成的 docx 结构是否完整） */
export function readZip(buffer: Buffer): Map<string, Buffer> {
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 66000); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('非法 zip：找不到中央目录结束记录');
  const count = buffer.readUInt16LE(eocd + 10);
  let off = buffer.readUInt32LE(eocd + 16);
  const out = new Map<string, Buffer>();
  for (let n = 0; n < count; n++) {
    if (buffer.readUInt32LE(off) !== 0x02014b50) throw new Error('非法 zip：中央目录损坏');
    const method = buffer.readUInt16LE(off + 10);
    const compSize = buffer.readUInt32LE(off + 20);
    const nameLen = buffer.readUInt16LE(off + 28);
    const extraLen = buffer.readUInt16LE(off + 30);
    const commentLen = buffer.readUInt16LE(off + 32);
    const localOff = buffer.readUInt32LE(off + 42);
    const name = buffer.toString('utf8', off + 46, off + 46 + nameLen);
    const lhNameLen = buffer.readUInt16LE(localOff + 26);
    const lhExtraLen = buffer.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lhNameLen + lhExtraLen;
    const raw = buffer.subarray(dataStart, dataStart + compSize);
    out.set(name, method === 0 ? Buffer.from(raw) : inflateRawSync(raw));
    off += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

// ---------------- HTML 解析（容忍式，够覆盖编辑器与 mammoth 产出） ----------------

type HtmlEl = { type: 'el'; tag: string; attrs: Record<string, string>; children: HtmlNode[] };
type HtmlText = { type: 'text'; text: string };
export type HtmlNode = HtmlEl | HtmlText;

const VOID_TAGS = new Set(['br', 'img', 'hr', 'wbr', 'input', 'meta', 'link']);
const BLOCK_TAGS = new Set([
  'p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'ul', 'ol', 'table', 'tbody',
  'thead', 'tfoot', 'tr', 'td', 'th', 'pre', 'blockquote', 'hr', 'figure', 'section',
  'article', 'header', 'footer', 'main', 'fieldset', 'form',
]);
const PARAGRAPHISH = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', middot: '·',
  bull: '•', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', hellip: '…',
  mdash: '—', ndash: '–', copy: '©', reg: '®', trade: '™', deg: '°', times: '×', divide: '÷',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, body: string) => {
    if (body.startsWith('#')) {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : m;
    }
    const key = body.toLowerCase();
    return NAMED_ENTITIES[key] ?? m;
  });
}

function escapeXml(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] as string);
}

function escapeAttr(s: string): string {
  return escapeXml(s).replace(/"/g, '&quot;');
}

function parseAttrs(src: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([a-zA-Z0-9_:.-]+)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const key = m[1].toLowerCase();
    const val = m[2] ?? m[3] ?? m[4] ?? '';
    attrs[key] = decodeEntities(val);
  }
  return attrs;
}

export function parseHtml(html: string): HtmlNode[] {
  const root: HtmlEl = { type: 'el', tag: 'root', attrs: {}, children: [] };
  const stack: HtmlEl[] = [root];
  const top = () => stack[stack.length - 1];
  const re = /<(\/)?([a-zA-Z][a-zA-Z0-9-]*)((?:\s[^>]*?)?)(\/)?>|([^<]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    if (m[5] !== undefined) {
      if (top().tag !== 'style' && top().tag !== 'script') {
        const t = decodeEntities(m[5]);
        if (t) top().children.push({ type: 'text', text: t });
      }
      continue;
    }
    const closing = !!m[1];
    const tag = m[2].toLowerCase();
    if (closing) {
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tag === tag) {
          stack.length = i;
          break;
        }
      }
      continue;
    }
    // 容忍未显式闭合的块级元素
    if (PARAGRAPHISH.has(tag) && PARAGRAPHISH.has(top().tag)) stack.pop();
    if ((tag === 'li' || tag === 'td' || tag === 'th' || tag === 'tr' || tag === 'pre' || tag === 'blockquote')
      && PARAGRAPHISH.has(top().tag)) stack.pop();
    if ((tag === 'td' || tag === 'th') && (top().tag === 'td' || top().tag === 'th')) stack.pop();
    if (tag === 'tr' && (top().tag === 'td' || top().tag === 'th')) stack.pop();
    if (tag === 'li' && top().tag === 'li') stack.pop();

    const el: HtmlEl = { type: 'el', tag, attrs: parseAttrs(m[3] || ''), children: [] };
    top().children.push(el);
    const selfClose = m[4] === '/' || VOID_TAGS.has(tag);
    if (!selfClose) stack.push(el);
  }
  return root.children;
}

// ---------------- 图片尺寸 ----------------

/** 解析 PNG/JPEG/GIF 像素尺寸（用于 docx 内联图尺寸；未知返回 null） */
export function imageDims(buf: Buffer, mime: string): { w: number; h: number } | null {
  try {
    if (mime.includes('png') && buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) {
      return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    }
    if (mime.includes('gif')) return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
    if (mime.includes('jpeg') || mime.includes('jpg')) {
      let off = 2;
      while (off < buf.length - 9) {
        if (buf[off] !== 0xff) { off++; continue; }
        const marker = buf[off + 1];
        const len = buf.readUInt16BE(off + 2);
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return { h: buf.readUInt16BE(off + 5), w: buf.readUInt16BE(off + 7) };
        }
        off += 2 + len;
      }
    }
  } catch {
    return null;
  }
  return null;
}

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/gif': 'gif',
  'image/bmp': 'bmp', 'image/webp': 'png', 'image/svg+xml': 'png',
};

function parseDataUri(src: string): { data: Buffer; mime: string } | null {
  const m = /^data:([^;,]+)?(;base64)?,(.*)$/is.exec(src);
  if (!m) return null;
  const mime = (m[1] || 'image/png').toLowerCase();
  const rest = m[3];
  try {
    const data = m[2]
      ? Buffer.from(rest, 'base64')
      : Buffer.from(decodeURIComponent(rest), 'utf8');
    if (!data.length) return null;
    return { data, mime };
  } catch {
    return null;
  }
}

// ---------------- HTML → OOXML ----------------

type Fmt = {
  b: boolean; i: boolean; u: boolean; s: boolean; sup: boolean; sub: boolean;
  color?: string; mono?: boolean; size?: number; link?: string;
};
type MediaRef = { id: number; ext: string; data: Buffer; w: number; h: number };
type Inline =
  | { kind: 'text'; text: string; fmt: Fmt }
  | { kind: 'br' }
  | { kind: 'img'; media: MediaRef };
type ParaBlock = { type: 'p'; items: Inline[]; style?: string; num?: { numId: number; ilvl: number }; align?: string; hr?: boolean; cellBottom?: boolean };
type TableBlock = { type: 'table'; rows: { cells: { items: Inline[]; bold: boolean }[] }[] };
type Block = ParaBlock | TableBlock;

const BASE_FMT: Fmt = { b: false, i: false, u: false, s: false, sup: false, sub: false };
const MAX_IMG_PX = 600;

class Builder {
  blocks: Block[] = [];
  media: MediaRef[] = [];
  links: string[] = [];
  private pending: Inline[] = [];
  private mid = 0;

  add(x: Inline) {
    this.pending.push(x);
  }

  flush(p?: Omit<ParaBlock, 'type' | 'items'>) {
    const items = this.takePending();
    if (!items.length && !p) return;
    this.blocks.push({ type: 'p', items, ...p });
  }

  /** 仅当已有行内内容时才成段（避免嵌套列表在父条目处产生空编号段） */
  flushIfPending(p?: Omit<ParaBlock, 'type' | 'items'>) {
    if (!this.pending.length) return;
    this.flush(p);
  }

  /** 当前段落是否已有行内内容 */
  hasPending(): boolean {
    return this.pending.length > 0;
  }

  /** 取出并归并当前累积的行内内容（供表格单元格等场景复用） */
  takePending(): Inline[] {
    const items = this.pending;
    this.pending = [];
    return items;
  }

  pushBlock(b: Block) {
    this.blocks.push(b);
  }

  newMedia(buf: Buffer, mime: string): MediaRef {
    const ext = EXT_BY_MIME[mime] || 'png';
    const dims = imageDims(buf, mime);
    const ref: MediaRef = {
      id: ++this.mid,
      ext,
      data: buf,
      w: dims?.w || 320,
      h: dims?.h || 240,
    };
    this.media.push(ref);
    return ref;
  }

  newLink(url: string): number {
    const idx = this.links.indexOf(url);
    if (idx >= 0) return idx + 1;
    this.links.push(url);
    return this.links.length;
  }
}

function styleMap(style: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const decl of style.split(';')) {
    const [k, v] = decl.split(':');
    if (k && v) out[k.trim().toLowerCase()] = v.trim().toLowerCase();
  }
  return out;
}

function applyInlineStyle(fmt: Fmt, style: Record<string, string>): Fmt {
  const next = { ...fmt };
  if (style['font-weight'] === 'bold' || style['font-weight'] === 'bolder' || Number(style['font-weight']) >= 600) next.b = true;
  if (style['font-style'] === 'italic') next.i = true;
  const deco = style['text-decoration'] || '';
  if (deco.includes('underline')) next.u = true;
  if (deco.includes('line-through')) next.s = true;
  if (style['font-family']?.includes('mono') || style['font-family']?.includes('courier')) next.mono = true;
  const color = style['color'];
  if (color) {
    const hex = color.startsWith('#')
      ? color.slice(1).replace(/^([0-9a-f])([0-9a-f])([0-9a-f])$/, (_, a, b, c) => `${a}${a}${b}${b}${c}${c}`)
      : '';
    if (/^[0-9a-f]{6}$/.test(hex)) next.color = hex.toUpperCase();
  }
  return next;
}

function walkNodes(nodes: HtmlNode[], b: Builder, fmt: Fmt, ctx: { ordered: boolean; ilvl: number } | null, align?: string, pre = false) {
  for (const node of nodes) {
    if (node.type === 'text') {
      if (pre) {
        const lines = node.text.replace(/\r\n/g, '\n').split('\n');
        lines.forEach((line, i) => {
          if (i > 0) b.add({ kind: 'br' });
          if (line) b.add({ kind: 'text', text: line, fmt: { ...fmt, mono: true } });
        });
        continue;
      }
      const raw = node.text.replace(/[ \t\r\n]+/g, ' ');
      if (!raw) continue;
      // 段首的纯空白丢弃（HTML 块边界不产生空格），段内空格保留
      if (!raw.trim() && !b.hasPending()) continue;
      b.add({ kind: 'text', text: raw, fmt });
      continue;
    }
    const tag = node.tag;
    const attrs = node.attrs;
    const sty = styleMap(attrs.style || '');

    if (VOID_TAGS.has(tag) && tag === 'br') {
      b.add({ kind: 'br' });
      continue;
    }
    if (tag === 'hr') {
      b.flush({ align });
      b.pushBlock({ type: 'p', items: [], hr: true });
      continue;
    }
    if (tag === 'img') {
      const src = attrs.src || '';
      const parsed = parseDataUri(src);
      if (parsed) {
        b.add({ kind: 'img', media: b.newMedia(parsed.data, parsed.mime) });
      } else if (attrs.alt) {
        b.add({ kind: 'text', text: `[图片：${attrs.alt}]`, fmt });
      }
      continue;
    }
    if (tag === 'style' || tag === 'script' || tag === 'head') continue;

    const f2: Fmt = { ...fmt };
    if (tag === 'b' || tag === 'strong') f2.b = true;
    else if (tag === 'i' || tag === 'em') f2.i = true;
    else if (tag === 'u' || tag === 'ins') f2.u = true;
    else if (tag === 's' || tag === 'strike' || tag === 'del') f2.s = true;
    else if (tag === 'sup') f2.sup = true;
    else if (tag === 'sub') f2.sub = true;
    else if (tag === 'code') f2.mono = true;
    else if (tag === 'h1' || tag === 'h2' || tag === 'h3' || tag === 'h4' || tag === 'h5' || tag === 'h6') f2.size = Number(tag[1]);
    if (tag === 'span' || tag === 'font') Object.assign(f2, applyInlineStyle(f2, sty));
    if (tag === 'a' && attrs.href) f2.link = attrs.href;

    const nextAlign = sty['text-align'] === 'center' ? 'center'
      : sty['text-align'] === 'right' ? 'right'
        : sty['text-align'] === 'left' ? 'left' : align;

    if (tag === 'ul' || tag === 'ol') {
      // 列表嵌在 li 内时，先把父条目按父级编号成段，再以 ilvl+1 展开子列表
      b.flushIfPending(
        ctx
          ? { num: { numId: ctx.ordered ? 2 : 1, ilvl: ctx.ilvl }, align: nextAlign }
          : { align: nextAlign },
      );
      walkList(node, b, fmt, { ordered: tag === 'ol', ilvl: ctx ? ctx.ilvl + 1 : 0 }, nextAlign);
      continue;
    }
    if (tag === 'li') {
      walkNodes(node.children, b, f2, ctx, nextAlign, pre);
      b.flushIfPending(ctx ? { num: { numId: ctx.ordered ? 2 : 1, ilvl: ctx.ilvl }, align: nextAlign } : { align: nextAlign });
      continue;
    }
    if (tag === 'table') {
      b.flush();
      walkTable(node, b, f2, nextAlign);
      continue;
    }
    if (tag === 'pre') {
      b.flush();
      walkNodes(node.children, b, { ...f2, mono: true }, ctx, nextAlign, true);
      b.flush({ style: 'Code', align: nextAlign });
      continue;
    }
    if (tag === 'blockquote') {
      b.flush();
      walkNodes(node.children, b, f2, ctx, nextAlign, pre);
      b.flush({ style: 'Quote', align: nextAlign });
      continue;
    }
    if (PARAGRAPHISH.has(tag)) {
      b.flush();
      walkNodes(node.children, b, f2, ctx, nextAlign, pre);
      b.flush({ style: /^h[1-6]$/.test(tag) ? `Heading${tag[1]}` : undefined, align: nextAlign });
      continue;
    }
    if (tag === 'div' || tag === 'section' || tag === 'article' || tag === 'header' || tag === 'footer' || tag === 'main' || tag === 'figure') {
      walkNodes(node.children, b, f2, ctx, nextAlign, pre);
      if (tag === 'div' || tag === 'figure') b.flush({ align: nextAlign });
      continue;
    }
    // 其余按行内容器处理（p/td/th/span/a/字体标签等）
    walkNodes(node.children, b, f2, ctx, nextAlign, pre);
  }
}

function walkList(listEl: HtmlEl, b: Builder, fmt: Fmt, ctx: { ordered: boolean; ilvl: number }, align?: string) {
  for (const child of listEl.children) {
    if (child.type !== 'el') {
      if (child.text.trim()) b.add({ kind: 'text', text: child.text.trim(), fmt });
      continue;
    }
    if (child.tag === 'li') {
      walkNodes(child.children, b, fmt, ctx, align);
      b.flushIfPending({ num: { numId: ctx.ordered ? 2 : 1, ilvl: ctx.ilvl }, align });
    } else if (child.tag === 'ul' || child.tag === 'ol') {
      walkList(child, b, fmt, { ordered: child.tag === 'ol', ilvl: ctx.ilvl + 1 }, align);
    } else {
      walkNodes([child], b, fmt, ctx, align);
    }
  }
}

function walkTable(tableEl: HtmlEl, b: Builder, fmt: Fmt, align?: string) {
  const rows: TableBlock['rows'] = [];
  const collectRows = (node: HtmlEl) => {
    for (const child of node.children) {
      if (child.type !== 'el') continue;
      if (child.tag === 'tr') {
        const cells: TableBlock['rows'][number]['cells'] = [];
        for (const c of child.children) {
          if (c.type !== 'el' || (c.tag !== 'td' && c.tag !== 'th')) continue;
          walkNodes(c.children, b, fmt, null, align);
          const items = b.takePending();
          cells.push({ items, bold: c.tag === 'th' });
        }
        if (cells.length) rows.push({ cells });
      } else if (['tbody', 'thead', 'tfoot'].includes(child.tag)) collectRows(child);
    }
  };
  collectRows(tableEl);
  if (rows.length) {
    b.pushBlock({ type: 'table', rows });
    b.pushBlock({ type: 'p', items: [] }); // Word 要求表格后接段落
  }
}

function rPrXml(fmt: Fmt): string {
  const parts: string[] = [];
  if (fmt.mono) parts.push('<w:rFonts w:ascii="Courier New" w:hAnsi="Courier New" w:eastAsia="宋体"/>');
  if (fmt.b) parts.push('<w:b/><w:bCs/>');
  if (fmt.i) parts.push('<w:i/><w:iCs/>');
  if (fmt.u) parts.push('<w:u w:val="single"/>');
  if (fmt.s) parts.push('<w:strike/>');
  if (fmt.sup) parts.push('<w:vertAlign w:val="superscript"/>');
  if (fmt.sub) parts.push('<w:vertAlign w:val="subscript"/>');
  if (fmt.color) parts.push(`<w:color w:val="${fmt.color}"/>`);
  if (fmt.size) parts.push(`<w:sz w:val="${28 - (fmt.size - 1) * 3}"/><w:szCs w:val="${28 - (fmt.size - 1) * 3}"/>`);
  return parts.length ? `<w:rPr>${parts.join('')}</w:rPr>` : '';
}

function textRuns(items: Inline[], b: Builder): string {
  let xml = '';
  let openLink: number | null = null;
  const closeLink = () => {
    if (openLink !== null) {
      xml += '</w:hyperlink>';
      openLink = null;
    }
  };
  for (const it of items) {
    if (it.kind === 'br') {
      xml += `<w:r><w:br/></w:r>`;
      continue;
    }
    if (it.kind === 'img') {
      xml += drawingXml(it.media, b);
      continue;
    }
    const linkId = it.fmt.link ? b.newLink(it.fmt.link) : null;
    if (linkId !== openLink) {
      closeLink();
      if (linkId !== null) xml += `<w:hyperlink r:id="${ridForLink(linkId)}" w:history="1">`;
      openLink = linkId;
    }
    if (it.text) {
      xml += `<w:r>${rPrXml(it.fmt)}<w:t xml:space="preserve">${escapeXml(it.text)}</w:t></w:r>`;
    }
  }
  closeLink();
  return xml;
}

function ridForLink(idx: number) {
  return `rId${500 + idx}`;
}
function ridForMedia(id: number) {
  return `rId${100 + id}`;
}

function drawingXml(m: MediaRef, _b: Builder): string {
  let w = m.w;
  let h = m.h;
  if (w > MAX_IMG_PX) {
    h = Math.round((h * MAX_IMG_PX) / w);
    w = MAX_IMG_PX;
  }
  const name = `image${m.id}.${m.ext}`;
  // 采用 VML（w:pict + v:imagedata）而非 DrawingML：Word/WPS/LibreOffice 均正常渲染，
  // 且本项目在线编辑依赖的 mammoth 只能从 VML 读回图片（实测 DrawingML 会被静丢弃）。
  return (
    `<w:r><w:pict><v:shape id="image${m.id}" type="#_x0000_t75" style="width:${w}px;height:${h}px"` +
    ` o:allowincell="f"><v:imagedata r:id="${ridForMedia(m.id)}" o:title="${escapeAttr(name)}"/>` +
    '</v:shape></w:pict></w:r>'
  );
}

function paraXml(p: ParaBlock): string {
  const pr: string[] = [];
  if (p.style) pr.push(`<w:pStyle w:val="${p.style}"/>`);
  if (p.num) pr.push(`<w:numPr><w:ilvl w:val="${p.num.ilvl}"/><w:numId w:val="${p.num.numId}"/></w:numPr>`);
  if (p.hr) pr.push('<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="BFBFBF"/></w:pBdr>');
  if (p.align && p.align !== 'left') pr.push(`<w:jc w:val="${p.align}"/>`);
  const pPr = pr.length ? `<w:pPr>${pr.join('')}</w:pPr>` : '';
  return `<w:p>${pPr}${textRuns(p.items, currentBuilder)}</w:p>`;
}

function tableXml(t: TableBlock): string {
  const borders =
    '<w:tblBorders>' +
    ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
      .map((k) => `<w:${k} w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/>`)
      .join('') +
    '</w:tblBorders>';
  const rows = t.rows
    .map((row) => {
      const cells = row.cells
        .map((c) => {
          const items = c.bold
            ? c.items.map((it): Inline => (it.kind === 'text' ? { ...it, fmt: { ...it.fmt, b: true } } : it))
            : c.items;
          const runs = textRuns(items, currentBuilder);
          return `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/></w:tcPr><w:p><w:pPr><w:spacing w:after="0"/></w:pPr>${runs}</w:p></w:tc>`;
        })
        .join('');
      return `<w:tr>${cells}</w:tr>`;
    })
    .join('');
  return (
    '<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/>' +
    '<w:tblW w:w="0" w:type="auto"/>' +
    borders +
    '<w:tblLayout w:type="autofit"/></w:tblPr>' +
    rows +
    '</w:tbl>'
  );
}

let currentBuilder: Builder;

export function buildDocxFromHtml(html: string, meta: { title?: string } = {}): Buffer {
  const b = new Builder();
  currentBuilder = b;
  walkNodes(parseHtml(html), b, BASE_FMT, null);
  b.flush();
  if (!b.blocks.length) b.pushBlock({ type: 'p', items: [] });

  const body = b.blocks.map((blk) => (blk.type === 'p' ? paraXml(blk) : tableXml(blk))).join('');
  const document =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document ' +
    'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
    'xmlns:v="urn:schemas-microsoft-com:vml" ' +
    'xmlns:o="urn:schemas-microsoft-com:office:office" ' +
    'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
    'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
    'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
    `<w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>` +
    '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/>' +
    '</w:sectPr></w:body></w:document>';

  // document.xml.rels：固定 rId1=styles、rId2=numbering，图片 rId10x，链接 rId5xx
  const rels: string[] = [
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>',
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>',
  ];
  for (const m of b.media) {
    rels.push(`<Relationship Id="${ridForMedia(m.id)}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image${m.id}.${m.ext}"/>`);
  }
  b.links.forEach((url, i) => {
    rels.push(`<Relationship Id="${ridForLink(i + 1)}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${escapeAttr(url)}" TargetMode="External"/>`);
  });
  const documentRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    rels.join('') +
    '</Relationships>';

  const pkgRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
    '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>' +
    '</Relationships>';

  const exts = new Set(b.media.map((m) => m.ext));
  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    [...exts].map((e) => `<Default Extension="${e}" ContentType="image/${e === 'jpg' ? 'jpeg' : e}"/>`).join('') +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
    '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>' +
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
    '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
    '</Types>';

  const heading = (id: string, name: string, lvl: number, sz: number) =>
    `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>` +
    `<w:pPr><w:keepNext/><w:spacing w:before="240" w:after="120"/><w:outlineLvl w:val="${lvl}"/></w:pPr>` +
    `<w:rPr><w:b/><w:bCs/><w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/></w:rPr></w:style>`;

  const styles =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:eastAsia="宋体" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:rPrDefault>' +
    '<w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>' +
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>' +
    heading('Heading1', 'heading 1', 0, 32) +
    heading('Heading2', 'heading 2', 1, 28) +
    heading('Heading3', 'heading 3', 2, 26) +
    heading('Heading4', 'heading 4', 3, 24) +
    heading('Heading5', 'heading 5', 4, 23) +
    heading('Heading6', 'heading 6', 5, 22) +
    '<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>' +
    '<w:pPr><w:ind w:left="480"/><w:pBdr><w:left w:val="single" w:sz="6" w:space="9" w:color="BFBFBF"/></w:pBdr></w:pPr><w:rPr><w:i/><w:color w:val="595959"/></w:rPr></w:style>' +
    '<w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:basedOn w:val="Normal"/><w:qFormat/>' +
    '<w:pPr><w:shd w:val="clear" w:color="auto" w:fill="F5F5F5"/><w:spacing w:after="0"/></w:pPr><w:rPr><w:rFonts w:ascii="Courier New" w:hAnsi="Courier New"/><w:sz w:val="20"/></w:rPr></w:style>' +
    '<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:basedOn w:val="TableNormal"/>' +
    '<w:tblPr><w:tblBorders>' +
    ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
      .map((k) => `<w:${k} w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/>`)
      .join('') +
    '</w:tblBorders></w:tblPr></w:style>' +
    '<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/></w:style>' +
    '</w:styles>';

  const lvl = (ilvl: number, fmt: string, text: string, indent: number) =>
    `<w:lvl w:ilvl="${ilvl}"><w:start w:val="1"/><w:numFmt w:val="${fmt}"/><w:lvlText w:val="${text}"/><w:lvlJc w:val="left"/>` +
    `<w:pPr><w:ind w:left="${indent}" w:hanging="360"/></w:pPr></w:lvl>`;

  const numbering =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>' +
    lvl(0, 'bullet', '&#8226;', 720) + lvl(1, 'bullet', '&#9675;', 1440) + lvl(2, 'bullet', '&#9642;', 2160) +
    '</w:abstractNum>' +
    '<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>' +
    lvl(0, 'decimal', '%1.', 720) + lvl(1, 'decimal', '%2.', 1440) + lvl(2, 'decimal', '%3.', 2160) +
    '</w:abstractNum>' +
    '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>' +
    '<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>' +
    '</w:numbering>';

  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const core =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
    'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    `<dc:title>${escapeXml(meta.title || 'document')}</dc:title>` +
    `<dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created>` +
    `<dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>` +
    '</cp:coreProperties>';
  const app =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">' +
    '<Application>myorgniz web editor</Application></Properties>';

  const entries: ZipEntry[] = [
    { name: '[Content_Types].xml', data: Buffer.from(contentTypes, 'utf8') },
    { name: '_rels/.rels', data: Buffer.from(pkgRels, 'utf8') },
    { name: 'word/document.xml', data: Buffer.from(document, 'utf8') },
    { name: 'word/_rels/document.xml.rels', data: Buffer.from(documentRels, 'utf8') },
    { name: 'word/styles.xml', data: Buffer.from(styles, 'utf8') },
    { name: 'word/numbering.xml', data: Buffer.from(numbering, 'utf8') },
    { name: 'docProps/core.xml', data: Buffer.from(core, 'utf8') },
    { name: 'docProps/app.xml', data: Buffer.from(app, 'utf8') },
    ...b.media.map((m) => ({ name: `word/media/image${m.id}.${m.ext}`, data: m.data, stored: true })),
  ];
  return createZip(entries);
}

// ---------------- docx → HTML（mammoth） ----------------

// eslint-disable-next-line @typescript-eslint/no-var-requires
const mammoth = require('mammoth');

/** 解析 docx 为可编辑 HTML（图片转 data URI，编辑器可原样回传） */
export async function docxToHtml(buf: Buffer): Promise<{ html: string; messages: string[] }> {
  const options = {
    // 把自研样式名映射回 HTML 块元素，保证 docx -> HTML -> docx 往返不降化为普通段落
    styleMap: ["p[style-name='Code'] => pre:fresh", "p[style-name='Quote'] => blockquote:fresh"],
    convertImage: mammoth.images.imgElement((image: { contentType: string; read(): Promise<Buffer> }) =>
      image.read().then((data: Buffer) => ({ src: `data:${image.contentType};base64,${data.toString('base64')}` })),
    ),
  };
  const { value, messages } = await mammoth.convertToHtml({ buffer: buf }, options);
  return { html: value || '', messages: (messages || []).map((m: { message?: string }) => m.message || '').filter(Boolean) };
}

/** 纯文本抽取（预览/搜索/AI 用） */
export async function docxToText(buf: Buffer): Promise<string> {
  const { value } = await mammoth.extractRawText({ buffer: buf });
  return (value || '').trim();
}

/** 是否是可在线编辑的 docx（严格限 docx，不含旧 .doc） */
export function isEditableDocx(name: string, mime?: string) {
  return /\.docx$/i.test(name) || mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
}
