import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { DocVisibility } from '@prisma/client';
import { requestMeta } from '../../common/access-log';
import { CurrentUser, CurrentUserPayload } from '../../common/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards';
import { DocShareInput, KnowledgeService } from './knowledge.service';

@Controller('knowledge')
@UseGuards(JwtAuthGuard)
export class KnowledgeController {
  constructor(private knowledge: KnowledgeService) {}

  // ---- 分类 ----
  @Get('categories')
  listCategories() {
    return this.knowledge.listCategories();
  }

  @Post('categories')
  createCategory(@Body() body: { name: string; projectId?: string }) {
    return this.knowledge.createCategory(body.name, body.projectId);
  }

  @Delete('categories/:id')
  removeCategory(@Param('id') id: string) {
    return this.knowledge.removeCategory(id);
  }

  // ---- 文档 ----
  @Get()
  listDocs(
    @CurrentUser() user: CurrentUserPayload,
    @Query('keyword') keyword?: string,
    @Query('categoryId') categoryId?: string,
    @Query('projectId') projectId?: string,
    @Query('departmentId') departmentId?: string,
  ) {
    return this.knowledge.listDocs(
      { id: user.id, role: user.role, departmentId: user.departmentId },
      { keyword, categoryId, projectId, departmentId },
    );
  }

  @Get(':id')
  getDoc(
    @Param('id') id: string,
    @CurrentUser() user: CurrentUserPayload,
    @Req() req: any,
  ) {
    // 保密项目文档的阅读留痕需要姓名快照与来源信息
    return this.knowledge.getDoc(
      id,
      { id: user.id, role: user.role, departmentId: user.departmentId, name: user.name },
      requestMeta(req),
    );
  }

  @Post()
  createDoc(
    @CurrentUser() user: CurrentUserPayload,
    @Body()
    body: {
      title: string;
      content: string;
      categoryId?: string;
      projectId?: string;
      departmentId?: string;
      visibility?: DocVisibility;
      shares?: DocShareInput[];
    },
  ) {
    return this.knowledge.createDoc(
      { id: user.id, role: user.role, departmentId: user.departmentId },
      body,
    );
  }

  @Patch(':id')
  updateDoc(
    @Param('id') id: string,
    @CurrentUser() user: CurrentUserPayload,
    @Body()
    body: {
      title?: string;
      content?: string;
      categoryId?: string | null;
      projectId?: string | null;
      departmentId?: string | null;
      visibility?: DocVisibility;
      shares?: DocShareInput[];
    },
  ) {
    return this.knowledge.updateDoc(id, { id: user.id, role: user.role, departmentId: user.departmentId }, body);
  }

  @Delete(':id')
  removeDoc(@Param('id') id: string, @CurrentUser() user: CurrentUserPayload) {
    return this.knowledge.removeDoc(id, { id: user.id, role: user.role, departmentId: user.departmentId });
  }

  @Get(':id/versions')
  versions(@Param('id') id: string) {
    return this.knowledge.versions(id);
  }

  @Get(':id/versions/:version')
  getVersion(@Param('id') id: string, @Param('version') version: string) {
    return this.knowledge.getVersion(id, Number(version));
  }
}
