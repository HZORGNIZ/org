// docx 在线编辑往返验证（可复现）：
//   pnpm --filter api test:docx
// 前置：pnpm --filter api build（或本脚本经 test:docx 调用 nest build 自动完成）
// 断言链：受限 HTML -> 自研 buildDocxFromHtml -> zip/XML 良构 -> mammoth 读回 -> 二次往返稳定
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { buildDocxFromHtml, readZip, docxToHtml, docxToText } = require(join(here, '..', 'dist', 'modules', 'documents', 'docx.util.js'));

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const html = `
<h1>项目周报</h1>
<p>本周<b>完成</b>了<i>联调</i>，<u>下划</u>、<s>删除线</s>、<span style="color:#ff0000">红字</span>、H<sub>2</sub>O、x<sup>2</sup>，末尾。</p>
<p>第一行<br>第二行</p>
<div style="text-align:center">居中段落</div>
<h2>列表</h2>
<ul><li>要点甲</li><li>要点乙<ul><li>子要点</li></ul></li></ul>
<ol><li>第一步</li><li>第二步</li></ol>
<h2>表格</h2>
<table><tr><th>指标</th><th>值</th></tr><tr><td>营收</td><td>120万</td></tr><tr><td>环比</td><td>+8%</td></tr></table>
<h2>代码与引用</h2>
<pre>const a = 1;
console.log(a);</pre>
<blockquote>引用：结论先行</blockquote>
<hr>
<p>链接：<a href="https://example.com/docs">示例文档</a></p>
<p>图片：<img src="data:image/png;base64,${PNG_1PX.toString('base64')}" alt="点"></p>
<p>中文标点「」《》&amp;&lt;&gt;实体 &#20320;&#22909;</p>
`;

const fail = [];
const ok = (cond, label) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}`);
  if (!cond) fail.push(label);
};

// 栈式 XML 良构检查：标签配对 + 命名空间前缀声明（正则计数法会把 w:pStyle 误计入 w:p）
function checkWellFormed(label, xml) {
  const stack = [];
  const declared = new Set();
  const re = /<(\/)?([\w.-]+)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/)?>/g;
  let m;
  while ((m = re.exec(xml))) {
    if (m[1]) {
      const top = stack.pop();
      if (top !== m[2]) return `${label}: </${m[2]}> 与栈顶 <${top}> 不匹配 @${m.index}`;
      continue;
    }
    const attrs = m[3];
    for (const d of attrs.matchAll(/xmlns:([\w.-]+)="([^"]+)"/g)) declared.add(d[1]);
    for (const p of attrs.matchAll(/\s([\w.-]+):[\w.-]+=/g)) {
      if (p[1] === 'xmlns' || p[1] === 'xml') continue; // 命名空间声明本身不是前缀引用
      if (!declared.has(p[1])) return `${label}: 属性前缀 ${p[1]} 未声明 @${m.index}`;
    }
    const prefix = m[2].includes(':') ? m[2].split(':')[0] : null;
    if (prefix && !declared.has(prefix) && prefix !== 'xml') return `${label}: 元素前缀 ${prefix} 未声明 @${m.index}`;
    if (!m[4]) stack.push(m[2]);
  }
  return stack.length ? `${label}: 未闭合 ${stack.join(',')}` : '';
}

const buf = buildDocxFromHtml(html, { title: '往返验证' });
const outPath = join(mkdtempSync(join(tmpdir(), 'docx-rt-')), 'roundtrip.docx');
writeFileSync(outPath, buf);
console.log(`docx bytes = ${buf.length} -> ${outPath}`);

const zip = readZip(buf);
const names = [...zip.keys()];
console.log('parts =', names.join(', '));
for (const need of ['[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/_rels/document.xml.rels', 'word/styles.xml', 'word/numbering.xml', 'docProps/core.xml'])
  ok(names.includes(need), `部件存在 ${need}`);
ok(names.some((n) => n.startsWith('word/media/image')), '图片媒体部件存在');

for (const [name, data] of zip) {
  if (/\.(xml|rels)$/.test(name)) {
    const s = data.toString('utf8');
    ok(!s.includes('undefined') && !s.includes('NaN'), `无 undefined/NaN ${name}`);
  }
}

const doc = zip.get('word/document.xml').toString('utf8');
for (const [name, data] of zip) {
  if (!/\.(xml|rels)$/.test(name)) continue;
  const err = checkWellFormed(name, data.toString('utf8'));
  ok(!err, `XML 良构 ${name}${err ? ' -> ' + err : ''}`);
}

ok(/<w:numId w:val="[12]"\/>/.test(doc), '列表编号引用存在');
ok(/<w:ilvl w:val="1"\/>/.test(doc), '嵌套列表 ilvl=1 存在');
ok(/<w:tblBorders>/.test(doc), '表格边框存在');
ok(/<w:hyperlink r:id="rId/.test(doc), '超链接 r:id 存在');
ok(/<v:imagedata r:id="rId\d+"/.test(doc), '图片 v:imagedata r:id 存在');
ok(/<w:pStyle w:val="Heading1"\/>/.test(doc), '标题样式存在');
ok(/<w:jc w:val="center"\/>/.test(doc), '居中对齐存在');
ok(/<w:pStyle w:val="Quote"\/>/.test(doc), '引用样式存在');
ok(/<w:pStyle w:val="Code"\/>/.test(doc), '代码样式存在');
// 嵌套列表的父条目必须仍带本级编号（曾被误退化为普通段落）
const yiParagraphs = doc.split('<w:p>').filter((p) => p.includes('要点乙'));
ok(yiParagraphs.length === 1 && yiParagraphs[0].includes('<w:numPr>'), `嵌套列表父条目保留编号（命中 ${yiParagraphs.length} 段）`);

const rels = zip.get('word/_rels/document.xml.rels').toString('utf8');
const relIds = [...rels.matchAll(/Id="(rId\d+)"/g)].map((m) => m[1]);
ok(new Set(relIds).size === relIds.length, `rels 中 rId 唯一 (${relIds.length} 个)`);
const embeds = [...doc.matchAll(/r:(?:id|embed)="(rId\d+)"/g)].map((m) => m[1]);
ok(embeds.every((r) => relIds.includes(r)), '文档内所有 r:id 在 rels 中有声明');
const declared = relIds.filter((r) => !embeds.includes(r));
ok(declared.every((r) => ['rId1', 'rId2'].includes(r)), `多余声明仅限 styles/numbering: ${declared.join(',') || '无'}`);

const { html: back, messages } = await docxToHtml(buf);
console.log('\n--- mammoth 读回 HTML ---\n' + back + '\n');
console.log('mammoth messages:', messages.length ? messages : '无');
const text = await docxToText(buf);
for (const kw of ['项目周报', '红字', '要点甲', '子要点', '第一步', '指标', '营收', 'console.log(a)', '结论先行', '示例文档', '中文标点', '你好'])
  ok(text.includes(kw), `文本回读 ${kw}`);
ok(!text.includes('undefined'), '文本无 undefined');
ok(back.includes('<table>') || back.includes('<tr>'), 'HTML 回读含表格');
ok(/<img src="data:image\/png;base64,/.test(back), 'HTML 回读含图片（data URI）');
ok(back.includes('<blockquote>'), 'HTML 回读保留引用块');
ok(back.includes('<pre>'), 'HTML 回读保留代码块');
ok(back.includes('<ul>') && back.includes('<ol>'), 'HTML 回读保留列表类型');
ok(/<li>子要点<\/li>/.test(back), 'HTML 回读保留嵌套列表条目');
ok(messages.length === 0, `mammoth 无告警（实际：${messages.join(' | ') || '无'}）`);

// 第二次往返：读回的 HTML 再写成 docx，仍应被 mammoth 正常解析（编辑器循环稳定）
const buf2 = buildDocxFromHtml(back, { title: '往返二次' });
const back2 = await docxToText(buf2);
for (const kw of ['项目周报', '要点乙', '子要点', '营收', '结论先行', '示例文档'])
  ok(back2.includes(kw), `二次往返文本回读 ${kw}`);
const err2 = checkWellFormed('二次 document.xml', readZip(buf2).get('word/document.xml').toString('utf8'));
ok(!err2, `二次往返 XML 良构${err2 ? ' -> ' + err2 : ''}`);

console.log(fail.length ? `\n=> ${fail.length} 项失败: ${fail.join(' | ')}` : '\n=> 全部通过');
process.exit(fail.length ? 1 : 0);
