import { BadRequestException, Body, Controller, Get, Param, Post, Query, Res } from '@nestjs/common';
import { Response } from 'express';
import { DocumentsService } from './documents.service';

/**
 * 对外部可见文档分享页（游客免登录）：
 * 项目文档空间里标为「对外部可见」的文件，外部人员通过分享链接 + 访问密码查看与下载。
 * 该类不加 JwtAuthGuard，路由公开；仅返回密码匹配的 EXTERNAL 文件，不泄露其他内容。
 */
@Controller('public')
export class PublicDocumentsController {
  constructor(private documents: DocumentsService) {}

  /** 分享页头部信息（项目名 + 对外文件数） */
  @Get('projects/:id')
  project(@Param('id') id: string) {
    return this.documents.publicProject(id);
  }

  /** 校验访问密码，返回该项目中密码匹配的对外可见文件列表 */
  @Post('projects/:id/docs')
  docs(@Param('id') id: string, @Body() body: { password?: string }) {
    const password = (body?.password ?? '').trim();
    if (!password) throw new BadRequestException('请输入访问密码');
    return this.documents.matchExternalFiles(id, password);
  }

  /** 全局访客入口（登录页）：只输密码，跨所有项目匹配对外可见文件 */
  @Post('docs')
  searchDocs(@Body() body: { password?: string }) {
    const password = (body?.password ?? '').trim();
    if (!password) throw new BadRequestException('请输入访问密码');
    return this.documents.searchExternalByPassword(password);
  }

  /** 游客下载：密码随查询参数带上，服务端二次校验后流式输出 */
  @Get('documents/files/:id/content')
  async content(
    @Param('id') id: string,
    @Query('password') password: string,
    @Query('inline') inline: string,
    @Res() res: Response,
  ) {
    const payload = await this.documents.publicContent(id, (password ?? '').trim());
    this.sendFile(res, payload.stream, payload.name, payload.mimeType, payload.size, inline === '1');
  }

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
    res.setHeader('Cache-Control', 'private, no-store');
    stream.on('error', () => {
      if (!res.headersSent) res.status(500);
      res.end();
    });
    stream.pipe(res);
  }
}
