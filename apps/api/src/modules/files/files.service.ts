import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { Readable } from 'stream';
import * as Minio from 'minio';
import { PrismaService } from '../../common/prisma.service';


/** MinIO 对象存储：附件/图片统一存放 */
@Injectable()
export class FilesService implements OnModuleInit {
  private readonly logger = new Logger(FilesService.name);
  private client: Minio.Client | null = null;
  private bucket = 'myorgniz';

  constructor(
    private config: ConfigService,
    private prisma: PrismaService,
  ) {}

  onModuleInit() {
    const endPoint = this.config.get<string>('MINIO_ENDPOINT', 'localhost');
    const port = Number(this.config.get<string>('MINIO_PORT', '9000'));
    const useSSL = this.config.get<string>('MINIO_USE_SSL', 'false') === 'true';
    const accessKey = this.config.get<string>('MINIO_ACCESS_KEY', 'minioadmin');
    const secretKey = this.config.get<string>('MINIO_SECRET_KEY', 'minioadmin');
    this.bucket = this.config.get<string>('MINIO_BUCKET', 'myorgniz');
    this.client = new Minio.Client({ endPoint, port, useSSL, accessKey, secretKey });
    // 初始化 bucket（不存在则创建）
    this.client
      .bucketExists(this.bucket)
      .then((exists) => {
        if (!exists) return this.client!.makeBucket(this.bucket);
      })
      .catch((e) => this.logger.error('MinIO 初始化失败', e));
  }

  get ready() {
    return !!this.client;
  }

  /** 上传文件流，返回元数据 */
  async upload(data: {
    file: Buffer;
    fileName: string;
    mimeType: string;
    size: number;
    uploaderId: string;
    taskId?: string;
    docId?: string;
    meetingId?: string;
  }) {
    if (!this.client) throw new Error('对象存储未初始化');
    const ext = data.fileName.includes('.')
      ? data.fileName.slice(data.fileName.lastIndexOf('.'))
      : '';
    const key = `${new Date().toISOString().slice(0, 10)}/${randomUUID()}${ext}`;
    await this.client.putObject(this.bucket, key, data.file, data.size, {
      'Content-Type': data.mimeType,
    });
    const attachment = await this.prisma.attachment.create({
      data: {
        taskId: data.taskId,
        docId: data.docId,
        meetingId: data.meetingId,
        uploaderId: data.uploaderId,
        fileName: data.fileName,
        fileKey: key,
        mimeType: data.mimeType,
        size: data.size,
      },
    });
    return { ...attachment, url: await this.presignedUrl(key) };
  }

  /** 生成临时访问链接（7 天） */
  async presignedUrl(key: string) {
    if (!this.client) return '';
    return this.client.presignedGetObject(this.bucket, key, 7 * 86400);
  }

  /** 读取对象内容为 Buffer（MinIO 不可用/对象不存在/读取失败时返回 null） */
  async download(key: string): Promise<Buffer | null> {
    if (!this.client) return null;
    try {
      const stream = await this.client.getObject(this.bucket, key);
      const chunks: Buffer[] = [];
      return await new Promise<Buffer | null>((resolve) => {
        stream.on('data', (c: Buffer) => chunks.push(c));
        stream.on('end', () => resolve(Buffer.concat(chunks)));
        stream.on('error', () => resolve(null));
      });
    } catch {
      return null;
    }
  }

  async remove(fileKey: string) {
    if (this.client) {
      await this.client.removeObject(this.bucket, fileKey).catch(() => undefined);
    }
    return this.prisma.attachment.deleteMany({ where: { fileKey } });
  }

  /** 仅删除 MinIO 对象（不动 Attachment 元数据表；文档空间自己维护元数据） */
  async removeObject(fileKey: string) {
    if (!this.client || !fileKey) return;
    await this.client.removeObject(this.bucket, fileKey).catch(() => undefined);
  }

  /** 流式写入对象（大文件不入内存）；size 未知时传 -1 由 SDK 分块处理 */
  async putStream(key: string, stream: Readable, size: number, mimeType: string) {
    if (!this.client) throw new Error('对象存储未初始化');
    await this.client.putObject(this.bucket, key, stream, size, { 'Content-Type': mimeType });
    return key;
  }

  /** 流式读取对象（供下载代理；对象不存在/服务不可用时抛错由调用方处理） */
  async getStream(key: string): Promise<Readable | null> {
    if (!this.client) return null;
    try {
      return await this.client.getObject(this.bucket, key);
    } catch {
      return null;
    }
  }

  /** 对象统计（存在性 + 大小），不存在返回 null */
  async stat(key: string) {
    if (!this.client) return null;
    try {
      return await this.client.statObject(this.bucket, key);
    } catch {
      return null;
    }
  }

  /** 文档空间对象前缀（按天 + uuid，与附件同一桶不同目录） */
  buildSpaceKey(fileName: string, prefix = 'docs') {
    const ext = fileName.includes('.') ? fileName.slice(fileName.lastIndexOf('.')) : '';
    return `${prefix}/${new Date().toISOString().slice(0, 10)}/${randomUUID()}${ext}`;
  }
}
