import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const port = Number(process.env.PORT ?? 3000);
  const webOrigin = process.env.WEB_ORIGIN ?? 'http://localhost:5173';

  app.setGlobalPrefix('api');
  app.enableCors({ origin: webOrigin.split(','), credentials: true });
  // docx 在线编辑保存时 HTML 可能内联 base64 图片，默认 100kb 请求体上限不够
  //（二进制文件上传走 multipart + 磁盘暂存，不受此限制）
  app.useBodyParser('json', { limit: '32mb' });
  app.useBodyParser('urlencoded', { limit: '32mb', extended: true });
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true }),
  );

  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`API 已启动: http://localhost:${port}/api`);
}
bootstrap();
