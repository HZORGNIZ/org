import { PrismaService } from './prisma.service';
import { CN_OFFSET_MS } from './beijing-time';

/** 留痕动作：进入详情 / 浏览器内预览 / 下载 */
export type AccessAction = 'ENTER' | 'VIEW' | 'DOWNLOAD';

/** 留痕资源类型：项目详情 / 文档空间上传文件 / 知识库文档 */
export type AccessResType = 'PROJECT' | 'DOCFILE' | 'KNOWLEDGE_DOC';

export interface AccessLogEntry {
  userId: string;
  userName: string;
  action: AccessAction;
  resType: AccessResType;
  resId: string;
  resName: string;
  projectId?: string | null;
  ip?: string;
  userAgent?: string;
}

/**
 * 从请求上取客户端 IP 与 UA。
 * IP 取 x-forwarded-for 首段（Caddy 反向代理透传真实来源），没有则回退 socket.remoteAddress。
 */
export function requestMeta(req: any): { ip?: string; userAgent?: string } {
  const xff = req?.headers?.['x-forwarded-for'];
  const first = Array.isArray(xff) ? xff[0] : xff;
  const ip = (first || req?.socket?.remoteAddress || '').toString().split(',')[0].trim();
  const ua = (req?.headers?.['user-agent'] || '').toString().trim().slice(0, 200);
  return { ip: ip || undefined, userAgent: ua || undefined };
}

/**
 * 写一条保密项目访问留痕（只在资源所属项目 confidential=true 时调用）。
 * 刻意做成「发射后不管」：日志写失败绝不能影响业务响应（与 AiService 落 AiCallLog 同一写法），
 * 因此这里不抛异常，只在控制台留一行告警。
 */
export function writeAccessLog(prisma: PrismaService, e: AccessLogEntry): void {
  const entry = {
    // 全库时间口径：createdAt 存北京墙钟字面量（同 AiCallLog），展示与按天查询都不做时区换算
    createdAt: new Date(Date.now() + CN_OFFSET_MS),
    userId: e.userId,
    userName: e.userName,
    action: e.action,
    resType: e.resType,
    resId: e.resId,
    resName: (e.resName || '').slice(0, 200),
    projectId: e.projectId ?? null,
    ip: e.ip ?? null,
    userAgent: e.userAgent ?? null,
  };
  prisma.accessLog
    .create({ data: entry })
    .then(() => undefined)
    .catch((err: any) => {
      // eslint-disable-next-line no-console
      console.warn(`保密访问日志写入失败（${e.resType}/${e.action}）: ${err?.message ?? err}`);
    });
}
