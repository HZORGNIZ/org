import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { FileApproval, FileVisibility } from '@prisma/client';
import { randomUUID } from 'crypto';
import { diskStorage } from 'multer';
import { tmpdir } from 'os';
import { extname } from 'path';
import { unlink } from 'fs/promises';
import { Response } from 'express';
import { CurrentUser, CurrentUserPayload } from '../../common/current-user.decorator';
import { requestMeta } from '../../common/access-log';
import { JwtAuthGuard } from '../../common/guards';
import { ConflictPolicy, DocumentsService, SpaceScope } from './documents.service';

/** 上传落盘临时目录（避免大文件整体进内存），服务读完即删 */
const uploadStorage = diskStorage({
  destination: tmpdir(),
  filename: (_req, file, cb) => {
    const ext = extname(file.originalname || '').slice(0, 12);
    cb(null, `docspace-${Date.now()}-${randomUUID()}${ext}`);
  },
});

@Controller('documents')
@UseGuards(JwtAuthGuard)
export class DocumentsController {
  constructor(private documents: DocumentsService) {}

  // ---- 空间浏览（静态路由，需在 :id 之前声明） ----

  @Get('space')
  space(
    @CurrentUser() user: CurrentUserPayload,
    @Query('scope') scope: SpaceScope,
    @Query('targetId') targetId: string,
    @Query('folderId') folderId?: string,
    @Query('keyword') keyword?: string,
    @Query('docType') docType?: string,
  ) {
    return this.documents.space(this.ctx(user), { scope, targetId, folderId, keyword, docType });
  }

  @Get('breadcrumb/:folderId')
  breadcrumb(@CurrentUser() user: CurrentUserPayload, @Param('folderId') folderId: string) {
    return this.documents.breadcrumb(this.ctx(user), folderId);
  }

  @Get('conflict')
  conflict(
    @CurrentUser() user: CurrentUserPayload,
    @Query('scope') scope: SpaceScope,
    @Query('targetId') targetId: string,
    @Query('name') name: string,
    @Query('folderId') folderId?: string,
  ) {
    return this.documents.conflict(this.ctx(user), { scope, targetId, name, folderId });
  }

  @Get('approvals')
  approvals(@CurrentUser() user: CurrentUserPayload, @Query('status') status?: FileApproval) {
    return this.documents.approvals(this.ctx(user), status);
  }

  @Post('approvals/:id/review')
  review(
    @CurrentUser() user: CurrentUserPayload,
    @Param('id') id: string,
    @Body() body: { decision: 'APPROVE' | 'REJECT'; note?: string },
  ) {
    return this.documents.review(this.ctx(user), id, body.decision, body.note);
  }

  // ---- 文件夹 ----

  @Post('folders')
  createFolder(
    @CurrentUser() user: CurrentUserPayload,
    @Body() body: { scope: SpaceScope; targetId: string; name: string; parentId?: string },
  ) {
    return this.documents.createFolder(this.ctx(user), body);
  }

  @Patch('folders/:id')
  renameFolder(
    @CurrentUser() user: CurrentUserPayload,
    @Param('id') id: string,
    @Body() body: { name: string },
  ) {
    return this.documents.renameFolder(this.ctx(user), id, body.name);
  }

  @Delete('folders/:id')
  deleteFolder(@CurrentUser() user: CurrentUserPayload, @Param('id') id: string) {
    return this.documents.deleteFolder(this.ctx(user), id);
  }

  // ---- 上传（拖拽/多选均走同一接口，前端逐个文件调用） ----

  @Post('upload')
  @UseInterceptors(FileInterceptor('file', { storage: uploadStorage, limits: { fileSize: 500 * 1024 * 1024 } }))
  async upload(
    @CurrentUser() user: CurrentUserPayload,
    @UploadedFile() file: Express.Multer.File,
    @Body() body: {
      scope: SpaceScope;
      targetId: string;
      folderId?: string;
      visibility?: FileVisibility;
      externalPassword?: string;
      externalValidDays?: string;
      note?: string;
      docType?: string;
      conflict?: ConflictPolicy;
    },
  ) {
    if (!file) throw new BadRequestException('缺少上传文件');
    try {
      return await this.documents.upload(this.ctx(user), {
        scope: body.scope,
        targetId: body.targetId,
        folderId: body.folderId || undefined,
        name: file.originalname,
        mimeType: file.mimetype,
        size: file.size,
        path: file.path,
        visibility: body.visibility,
        externalPassword: body.externalPassword,
        externalValidDays: body.externalValidDays,
        note: body.note,
        docType: body.docType,
        conflict: body.conflict,
      });
    } finally {
      // 暂存文件由本拦截器写入磁盘，无论成功还是校验/权限失败都要清掉，避免 /tmp 堆积
      await unlink(file.path).catch(() => undefined);
    }
  }

  // ---- 文件内容（下载/预览，API 流式代理） ----

  @Get('files/:id/content')
  async content(
    @CurrentUser() user: CurrentUserPayload,
    @Param('id') id: string,
    @Query('version') version: string,
    @Query('inline') inline: string,
    @Req() req: any,
    @Res() res: Response,
  ) {
    // 保密项目的文件：inline=1 计为预览（VIEW），否则计为下载（DOWNLOAD）
    const meta = { action: (inline === '1' ? 'VIEW' : 'DOWNLOAD') as 'VIEW' | 'DOWNLOAD', ...requestMeta(req) };
    const payload = version
      ? await this.documents.versionContent(this.ctx(user), id, Number(version), meta)
      : await this.documents.content(this.ctx(user), id, meta);
    this.sendFile(res, payload.stream, payload.name, payload.mimeType, payload.size, inline === '1');
  }

  @Get('files/:id/editable')
  editable(@CurrentUser() user: CurrentUserPayload, @Param('id') id: string) {
    return this.documents.editableHtml(this.ctx(user), id);
  }

  @Patch('files/:id/content')
  saveContent(
    @CurrentUser() user: CurrentUserPayload,
    @Param('id') id: string,
    @Body() body: { html: string; note?: string },
  ) {
    return this.documents.saveEditable(this.ctx(user), id, body.html, body.note);
  }

  @Get('files/:id/versions')
  versions(@CurrentUser() user: CurrentUserPayload, @Param('id') id: string) {
    return this.documents.listVersions(this.ctx(user), id);
  }

  @Delete('files/:id/versions/:version')
  deleteVersion(
    @CurrentUser() user: CurrentUserPayload,
    @Param('id') id: string,
    @Param('version') version: string,
  ) {
    return this.documents.removeVersion(this.ctx(user), id, Number(version));
  }

  @Patch('files/:id')
  patchFile(
    @CurrentUser() user: CurrentUserPayload,
    @Param('id') id: string,
    @Body() body: { name?: string; note?: string | null; docType?: string | null; visibility?: FileVisibility; externalPassword?: string; externalValidDays?: number | string | null; folderId?: string | null },
  ) {
    return this.documents.patchFile(this.ctx(user), id, body);
  }

  @Delete('files/:id')
  deleteFile(@CurrentUser() user: CurrentUserPayload, @Param('id') id: string) {
    return this.documents.removeFile(this.ctx(user), id);
  }

  private ctx(user: CurrentUserPayload) {
    // name 只用于保密访问留痕的姓名快照（日志表不建外键，改名/删号后仍可读）
    return { id: user.id, role: user.role, departmentId: user.departmentId, name: user.name };
  }

  /** 流式输出：inline=1 供浏览器内预览（pdf/图片/视频），否则作为附件下载 */
  private sendFile(
    res: Response,
    stream: NodeJS.ReadableStream,
    name: string,
    mimeType: string,
    size: number,
    inline: boolean,
  ) {
    res.setHeader('Content-Type', mimeType || 'application/octet-stream');
    if (Number.isFinite(size) && size > 0) res.setHeader('Content-Length', String(size));
    const encoded = encodeURIComponent(name);
    res.setHeader(
      'Content-Disposition',
      `${inline ? 'inline' : 'attachment'}; filename="${encoded.replace(/\+/g, '%20')}"; filename*=UTF-8''${encoded}`,
    );
    res.setHeader('Cache-Control', 'private, max-age=60');
    stream.on('error', () => {
      if (!res.headersSent) res.status(500);
      res.end();
    });
    stream.pipe(res);
  }
}
