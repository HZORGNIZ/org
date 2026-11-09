/**
 * 文档空间服务层集成验证（本地 PostgreSQL + 假对象存储）
 * 运行：pnpm --filter api test:documents
 * 覆盖：空间权限、文件夹、上传三种重名策略、版本、可见范围与审批流、docx 在线编辑往返、下载/删除
 */
import assert from 'assert';
import { existsSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import 'reflect-metadata';
import { PrismaClient, FileVisibility, FileApproval, Role } from '@prisma/client';
import { Readable } from 'stream';
import { DocumentsService } from '../dist/modules/documents/documents.service.js';
import { buildDocxFromHtml } from '../dist/modules/documents/docx.util.js';

/** PrismaClient 不会自动读 .env（只有 CLI 会），此处手动加载 apps/api/.env 与仓库根 .env */
const here = path.dirname(fileURLToPath(import.meta.url));
for (const cand of [path.join(here, '..', '.env'), path.join(here, '..', '..', '..', '.env')]) {
  if (!existsSync(cand)) continue;
  for (const line of readFileSync(cand, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}
if (!process.env.DATABASE_URL) throw new Error('缺 DATABASE_URL，无法连本地库');

const prisma = new PrismaClient();

/** 假对象存储：记录 key -> Buffer，可校验对象是否被真正删除 */
const objects = new Map();
const filesStub = {
  buildSpaceKey(name) {
    return `space/${Date.now()}-${Math.random().toString(36).slice(2)}-${name}`;
  },
  async putStream(key, stream) {
    const chunks = [];
    for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
    objects.set(key, Buffer.concat(chunks));
    return key;
  },
  async getStream(key) {
    const buf = objects.get(key);
    return buf ? Readable.from(buf) : null;
  },
  async download(key) {
    return objects.get(key) ?? null;
  },
  async removeObject(key) {
    objects.delete(key);
    return true;
  },
};
const notifications = { sent: [], async create(userId, payload) { this.sent.push({ userId, payload }); }, async createMany(ids, payload) { ids.forEach((userId) => this.sent.push({ userId, payload })); } };
const svc = new DocumentsService(prisma, filesStub, notifications);

const ok = (label) => console.log(`  ✔ ${label}`);
let step = 0;
const next = (name) => console.log(`\n[${++step}] ${name}`);

// ---------------- 测试数据 ----------------
// 先清理上一次可能中途中断留下的数据，保证脚本可重复执行
await prisma.documentFile.deleteMany({ where: { uploader: { email: { startsWith: 'test.doc.' } } } });
await prisma.documentFolder.deleteMany({ where: { creator: { email: { startsWith: 'test.doc.' } } } });

const PW = 'x';
async function mkUser(name, email, role, departmentId) {
  return prisma.user.upsert({ where: { email }, update: { role, departmentId }, create: { name, email, password: PW, role, departmentId } });
}

const deptA = await prisma.department.upsert({ where: { name: 'TEST-文档A部' }, update: {}, create: { name: 'TEST-文档A部' } });
const deptB = await prisma.department.upsert({ where: { name: 'TEST-文档B部' }, update: {}, create: { name: 'TEST-文档B部' } });
const admin = await mkUser('TEST-文档管理员', 'test.doc.admin@example.com', Role.ADMIN, deptA.id);
const leaderA = await mkUser('TEST-A负责人', 'test.doc.leadera@example.com', Role.DEPT_LEADER, deptA.id);
const memA = await mkUser('TEST-A成员', 'test.doc.membera@example.com', Role.MEMBER, deptA.id);
const memB = await mkUser('TEST-B成员', 'test.doc.memberb@example.com', Role.MEMBER, deptB.id);
await prisma.department.update({ where: { id: deptA.id }, data: { leaderId: leaderA.id } });

const proj = await prisma.project.upsert({
  where: { id: (await prisma.project.findFirst({ where: { name: 'TEST-文档项目' }, select: { id: true } }))?.id ?? '' },
  update: { ownerId: leaderA.id },
  create: { name: 'TEST-文档项目', ownerId: leaderA.id },
});
await prisma.projectDepartment.upsert({ where: { projectId_departmentId: { projectId: proj.id, departmentId: deptA.id } }, update: {}, create: { projectId: proj.id, departmentId: deptA.id } });
await prisma.projectMember.upsert({ where: { projectId_userId: { projectId: proj.id, userId: memA.id } }, update: {}, create: { projectId: proj.id, userId: memA.id } });

const U = (u) => ({ id: u.id, role: u.role, departmentId: u.departmentId });
const A = U(admin);
const LA = U(leaderA);
const MA = U(memA);
const MB = U(memB);

async function upload(spaceUser, { scope, targetId, name, html, folderId, visibility, note, conflict, buffer }) {
  const data = buffer ?? Buffer.from(html ?? '<p>plain content</p>');
  const mime = name.endsWith('.docx')
    ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    : 'application/octet-stream';
  return svc.upload(spaceUser, {
    scope,
    targetId,
    name,
    mimeType: mime,
    size: data.length,
    buffer: data,
    folderId,
    visibility,
    note,
    conflict,
  });
}

const cleanupFileIds = [];
const track = (f) => {
  if (f?.id) cleanupFileIds.push(f.id);
  return f;
};

// ---------------- 1. 空间可见性 ----------------
next('空间权限：本部门可看、他部门禁止');
{
  const sp = await svc.space(MA, { scope: 'department', targetId: deptA.id });
  assert.equal(sp.spaceName, deptA.name);
  assert.equal(sp.canManage, false);
  const spLeader = await svc.space(LA, { scope: 'department', targetId: deptA.id });
  assert.equal(spLeader.canManage, true);
  await assert.rejects(() => svc.space(MB, { scope: 'department', targetId: deptA.id }), /仅可查看本部门文档空间/);
  await assert.rejects(() => svc.space(MB, { scope: 'department', targetId: deptA.id }), (e) => e.getStatus() === 403);
  ok('部门空间权限（成员可读 / 负责人 canManage / 他部门 403）');

  const spProj = await svc.space(MA, { scope: 'project', targetId: proj.id });
  assert.equal(spProj.canManage, false);
  await assert.rejects(() => svc.space(MB, { scope: 'project', targetId: proj.id }), /仅项目成员或主要关联部门负责人/);
  ok('项目空间权限（成员可读、关联部门负责人可管理、无关成员 403）');
}

// ---------------- 2. 文件夹 ----------------
next('文件夹：创建 / 同级重名阻断 / 重命名 / 非空删除阻断');
const folder = await svc.createFolder(MA, { scope: 'department', targetId: deptA.id, name: '设计稿' });
{
  assert.equal(folder.name, '设计稿');
  await assert.rejects(
    () => svc.createFolder(MA, { scope: 'department', targetId: deptA.id, name: '设计稿' }),
    /同级已有同名文件夹/,
  );
  const renamed = await svc.renameFolder(MA, folder.id, '设计稿V2');
  assert.equal(renamed.name, '设计稿V2');
  const crumb = await svc.breadcrumb(MA, folder.id);
  assert.deepEqual(crumb.map((c) => c.name), ['设计稿V2']);
  ok('创建 / 重名阻断 / 重命名 / 面包屑');
}

// ---------------- 3. 上传与重名策略 ----------------
next('上传：默认可见范围=本部门、备注、大小、上传者');
{
  const f1 = track(await upload(MA, { scope: 'department', targetId: deptA.id, name: '需求说明.docx', html: '<h1>需求</h1><p>第一版</p>', note: '初稿' }));
  assert.equal(f1.version, 1);
  assert.equal(f1.visibility, FileVisibility.DEPARTMENT);
  assert.equal(f1.approval, FileApproval.NONE);
  assert.equal(f1.note, '初稿');
  assert.equal(f1.uploaderId, memA.id);
  assert.ok(f1.editable, 'docx 应标记为可在线编辑');
  assert.ok(f1.canManage, '上传者可管理');
  ok('首次上传生成 v1（DEPARTMENT / NONE / 备注 / editable）');

  const cf = await svc.conflict(MA, { scope: 'department', targetId: deptA.id, name: '需求说明.docx' });
  assert.equal(cf.exists, true);
  assert.equal(cf.file.version, 1);
  ok('重名探测 /documents/conflict');

  const f2 = track(await upload(MA, { scope: 'department', targetId: deptA.id, name: '需求说明.docx', html: '<h1>需求</h1><p>第二版</p>', conflict: 'version' }));
  assert.equal(f2.id, f1.id);
  assert.equal(f2.version, 2);
  const vers = await svc.listVersions(MA, f1.id);
  assert.equal(vers.versions.length, 2);
  assert.equal(vers.current, 2);
  ok('保留版本：同名上传追加 v2，历史版本可列');

  const f3 = track(await upload(MA, { scope: 'department', targetId: deptA.id, name: '需求说明.docx', html: '<p>另存</p>', conflict: 'rename' }));
  assert.equal(f3.name, '需求说明(2).docx');
  ok('另存新名：唯一文件名后缀 (2)');

  const f4 = track(await upload(MA, { scope: 'department', targetId: deptA.id, name: '需求说明.docx', html: '<p>覆盖</p>', conflict: 'overwrite' }));
  assert.equal(f4.version, 1);
  const vers2 = await svc.listVersions(MA, f1.id);
  assert.equal(vers2.versions.length, 1, '覆盖后仅保留当前版本');
  ok('删除历史版本：覆盖上传重置为 v1 且历史快照清空');

  const sp = await svc.space(MA, { scope: 'department', targetId: deptA.id });
  assert.ok(sp.files.some((x) => x.name === '需求说明(2).docx'));
  ok('空间列表含大小/上传者/时间字段：' + sp.files[0].uploader.name + ' / ' + sp.files[0].size + ' B');

  const inFolder = track(await upload(MA, { scope: 'department', targetId: deptA.id, name: '结构图.stl', folderId: folder.id }));
  assert.equal(inFolder.folderId, folder.id);
  assert.equal(inFolder.visibility, FileVisibility.DEPARTMENT);
  await assert.rejects(() => svc.deleteFolder(MA, folder.id), /文件夹非空/);
  ok('上传到指定文件夹 / 非空文件夹删除阻断');

  await assert.rejects(() => upload(MA, { scope: 'department', targetId: deptA.id, name: '空.bin', buffer: Buffer.alloc(0) }), /空文件不可上传/);
  ok('空文件阻断');
}

// ---------------- 4. 可见范围与审批 ----------------
next('全员可见审批流：PENDING → 管理员同意 → 他部门可下载');
let approvalFileId = '';
{
  const f = track(await upload(MA, { scope: 'department', targetId: deptA.id, name: '全员公告素材.pdf', visibility: FileVisibility.PUBLIC, buffer: Buffer.from('%PDF-1.4 test') }));
  approvalFileId = f.id;
  assert.equal(f.approval, FileApproval.PENDING);
  assert.equal(f.visibility, FileVisibility.PUBLIC);
  assert.ok(notifications.sent.some((n) => n.userId === admin.id && /待审批/.test(n.payload.title)), '应通知管理员');
  ok('上传即申请：PENDING + 通知管理员');

  // 待审批期间：仅上传者与管理员可见
  await assert.rejects(() => svc.content(MB, f.id), /文件不存在或无权限/);
  const spLeaderView = await svc.space(LA, { scope: 'department', targetId: deptA.id });
  assert.ok(!spLeaderView.files.some((x) => x.id === f.id), '负责人在未审批前不应看到他人私有申请');

  // 列表：他部门成员看不到该空间
  await assert.rejects(() => svc.space(MB, { scope: 'department', targetId: deptA.id }), /仅可查看本部门/);

  const list = await svc.approvals(A);
  assert.ok(list.pending >= 1);
  assert.ok(list.files.some((x) => x.id === f.id));
  ok('管理员审批列表含待审批项');

  await assert.rejects(() => svc.approvals(MA), /仅管理员可查看审批列表/);
  ok('非管理员访问审批列表 403');

  const approved = await svc.review(A, f.id, 'APPROVE', '内容合规');
  assert.equal(approved.approval, FileApproval.APPROVED);
  assert.equal(approved.visibility, FileVisibility.PUBLIC);
  assert.equal(approved.reviewNote, '内容合规');
  const lastNotif = notifications.sent[notifications.sent.length - 1];
  assert.equal(lastNotif.userId, memA.id);
  assert.match(lastNotif.payload.title, /全员共享已同意/);
  ok('同意后 PUBLIC 生效 + 通知上传者');

  const seen = await svc.content(MB, f.id);
  const chunks = [];
  for await (const c of seen.stream) chunks.push(c);
  assert.equal(Buffer.concat(chunks).toString(), '%PDF-1.4 test');
  assert.equal(seen.name, '全员公告素材.pdf');
  ok('他部门成员可下载已审批文件（流式内容一致）');
}

next('审批驳回：降为仅自己可见');
{
  const f = track(await upload(MA, { scope: 'department', targetId: deptA.id, name: '敏感数据.xlsx', visibility: FileVisibility.PUBLIC, buffer: Buffer.from('PK fake xlsx') }));
  const rejected = await svc.review(A, f.id, 'REJECT', '含未公开成本');
  assert.equal(rejected.approval, FileApproval.REJECTED);
  assert.equal(rejected.visibility, FileVisibility.PRIVATE);
  await assert.rejects(() => svc.content(MB, f.id), /文件不存在或无权限/);
  await assert.rejects(() => svc.review(A, f.id, 'APPROVE'), /不在待审批状态/);
  ok('驳回后降为 PRIVATE，他部门仍不可见，重复审批被阻断');

  const again = await svc.patchFile(MA, f.id, { visibility: FileVisibility.PUBLIC });
  assert.equal(again.approval, FileApproval.PENDING);
  assert.equal(again.reviewedById, null);
  ok('再次申请回到 PENDING 并清空审查字段');
}

next('PATCH 权限：仅上传者/负责人/管理员可改');
{
  const f = track(await upload(MA, { scope: 'department', targetId: deptA.id, name: '归属测试.txt', buffer: Buffer.from('own') }));
  await assert.rejects(() => svc.patchFile(MB, f.id, { note: 'x' }), /文件不存在或无权限/);
  const byLeader = await svc.patchFile(LA, f.id, { note: '负责人补充说明' });
  assert.equal(byLeader.note, '负责人补充说明');
  const moved = await svc.patchFile(MA, f.id, { folderId: folder.id });
  assert.equal(moved.folderId, folder.id);
  const toRoot = await svc.patchFile(MA, f.id, { folderId: null });
  assert.equal(toRoot.folderId, null);
  ok('备注编辑 / 移动到文件夹 / 移回根目录');
}

// ---------------- 5. docx 在线编辑 ----------------
next('docx 在线编辑：mammoth 读取 → 编辑 → 重新生成新版本');
{
  const origin = buildDocxFromHtml('<h1>产品说明</h1><p>本项目<strong>采用</strong>新技术。</p><ul><li>要点甲</li><li>要点乙</li></ul><table><tr><th>项</th><td>值</td></tr></table>', { title: '在线编辑样例' });
  const f = track(await upload(MA, { scope: 'department', targetId: deptA.id, name: '在线编辑样例.docx', buffer: origin }));
  const ed = await svc.editableHtml(MA, f.id);
  assert.equal(ed.canEdit, true);
  assert.match(ed.html, /产品说明/);
  assert.match(ed.html, /要点乙/);
  ok(`读取为 HTML（${ed.html.length} 字符，警告 ${ed.warnings.length} 条）`);

  const saved = await svc.saveEditable(MA, f.id, '<h1>产品说明（已修订）</h1><p>新增段落：<em>斜体</em>与<strong>加粗</strong>。</p><ol><li>步骤一</li></ol>', '在线编辑');
  assert.equal(saved.version, 2);
  const round = await svc.editableHtml(MA, f.id);
  assert.match(round.html, /已修订/);
  assert.match(round.html, /步骤一/);
  if (round.warnings.length) console.log(`    · mammoth 警告（不阻断）：${round.warnings.map((w) => w.message).join('；')}`);
  ok('保存生成 v2 且内容可再次读回');

  const v1 = await svc.versionContent(MA, f.id, 1);
  assert.equal(v1.size, origin.length, '历史版本大小等于原文件');
  await assert.rejects(() => svc.removeVersion(MA, f.id, 2), /当前版本不可删除/);
  await svc.removeVersion(MA, f.id, 1);
  const after = await svc.listVersions(MA, f.id);
  assert.equal(after.versions.length, 1);
  ok('历史版本可下载并可删除，当前版本受保护');

  await assert.rejects(() => svc.editableHtml(MA, approvalFileId), /仅 .docx 文档支持在线编辑/);
  ok('非 docx 拒绝在线编辑');
}

// ---------------- 6. 删除文件 ----------------
next('删除文件：元数据与全部对象一并清理');
{
  const f = track(await upload(MA, { scope: 'department', targetId: deptA.id, name: '待删除.zip', buffer: Buffer.from('zipcontent') }));
  await upload(MA, { scope: 'department', targetId: deptA.id, name: '待删除.zip', buffer: Buffer.from('zipcontent v2'), conflict: 'version' });
  const keys = (await prisma.documentFileVersion.findMany({ where: { fileId: f.id }, select: { fileKey: true } })).map((v) => v.fileKey);
  assert.equal(keys.length, 2);
  assert.ok(keys.every((k) => objects.has(k)));
  await svc.removeFile(MA, f.id);
  assert.ok(keys.every((k) => !objects.has(k)), 'MinIO 对象应全部删除');
  assert.equal(await prisma.documentFile.count({ where: { id: f.id } }), 0);
  ok('删除文件后版本行与对象存储均无残留');
}

// ---------------- 7. 项目空间与部门统计 ----------------
next('项目空间上传 + 部门统计（fileCount/folderCount）');
{
  const pf = track(await upload(LA, { scope: 'project', targetId: proj.id, name: '项目验收单.docx', buffer: buildDocxFromHtml('<h2>验收</h2>', { title: '验收' }) }));
  assert.equal(pf.visibility, FileVisibility.PROJECT);
  const spProj = await svc.space(MA, { scope: 'project', targetId: proj.id });
  assert.ok(spProj.files.some((x) => x.id === pf.id));
  ok('项目空间文件对成员可见');
}

// ---------------- 收尾：清理测试数据 ----------------
next('清理测试数据');
{
  const files = await prisma.documentFile.findMany({ where: { uploader: { email: { startsWith: 'test.doc.' } } }, select: { id: true, fileKey: true } });
  for (const f of files) {
    const keys = (await prisma.documentFileVersion.findMany({ where: { fileId: f.id }, select: { fileKey: true } })).map((v) => v.fileKey);
    await prisma.documentFile.delete({ where: { id: f.id } });
    for (const k of new Set([...keys, f.fileKey])) await filesStub.removeObject(k);
  }
  await prisma.documentFolder.deleteMany({ where: { creatorId: { in: [memA.id, leaderA.id, admin.id] } } });
  await prisma.projectMember.deleteMany({ where: { projectId: proj.id } });
  await prisma.projectDepartment.deleteMany({ where: { projectId: proj.id } });
  await prisma.project.delete({ where: { id: proj.id } });
  await prisma.notification.deleteMany({ where: { OR: [{ userId: admin.id }, { userId: memA.id }], title: { contains: '全员' } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: 'test.doc.' } } });
  await prisma.department.update({ where: { id: deptA.id }, data: { leaderId: null } });
  await prisma.department.deleteMany({ where: { id: { in: [deptA.id, deptB.id] } } });
  assert.equal(await prisma.documentFile.count(), 0);
  assert.equal(await prisma.documentFolder.count(), 0);
  ok(`已清理 ${files.length} 个文件与测试部门/用户，剩余对象 ${objects.size} 个`);
}

console.log(`\n全部通过：${step} 组断言，对象存储残留 ${objects.size} 个`);
await prisma.$disconnect();
