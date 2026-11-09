import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  Post,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { CurrentUser } from '../../common/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards';
import { FilesService } from './files.service';

@Controller('files')
@UseGuards(JwtAuthGuard)
export class FilesController {
  constructor(private files: FilesService) {}

  @Post('upload')
  @UseInterceptors(FileInterceptor('file'))
  async upload(
    @UploadedFile() file: Express.Multer.File,
    @CurrentUser('id') userId: string,
    @Query('taskId') taskId?: string,
    @Query('docId') docId?: string,
  ) {
    if (!file) throw new BadRequestException('缺少文件');
    return this.files.upload({
      file: file.buffer,
      fileName: file.originalname,
      mimeType: file.mimetype,
      size: file.size,
      uploaderId: userId,
      taskId,
      docId,
    });
  }

  @Get('presign')
  presign(@Query('key') key: string) {
    if (!key) throw new BadRequestException('缺少 key');
    return this.files.presignedUrl(key).then((url) => ({ url }));
  }

  @Delete()
  remove(@Query('key') key: string) {
    if (!key) throw new BadRequestException('缺少 key');
    return this.files.remove(key);
  }
}
