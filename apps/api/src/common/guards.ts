import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { JwtService } from '@nestjs/jwt';
import { Role } from '@prisma/client';
import { ROLES_KEY } from './roles.decorator';
import { NO_ORG_KEY } from './no-org.decorator';
import { roleRank } from './permissions';
import { PrismaService } from './prisma.service';
import { CurrentUserPayload } from './current-user.decorator';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  handleRequest(err: any, user: any) {
    if (err || !user) throw err || new UnauthorizedException('未登录或登录已过期');
    return user;
  }
}

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;
    const { user } = context.switchToHttp().getRequest();
    if (!user) return false;
    // 层级放行：用户角色序 ≥ 所需角色列表中的最低序（如 @Roles(ADMIN) 仍为纯管理员上限）
    const threshold = Math.min(...required.map((r) => roleRank(r)));
    return roleRank(user.role) >= threshold;
  }
}

/**
 * 组织准入守卫（在 AuthModule 里以 APP_GUARD 全局注册）：
 * 自助注册、管理员尚未为其分配部门的普通成员（MEMBER），除 @AllowNoOrg 标记的接口外一律 403，
 * 前端捕获后展示「请联系管理员加入组织」缺省页，避免新人在未入组状态下看到任何业务数据。
 *
 * 实现取舍：全局 APP_GUARD 先于控制器级 JwtAuthGuard 执行，此时 request.user 尚未注入，
 * 因此这里自行验签 Authorization 头里的 JWT（与 JwtStrategy 同一密钥，验签失败不报错、
 * 留给各接口自己的 JwtAuthGuard 出 401），从而无需逐个控制器改 @UseGuards 列表。
 * 放行次序以「代价最小」为先：豁免标记 → 无 token → 非 MEMBER → token 里已有部门（快路径，不查库）。
 */
@Injectable()
export class OrgGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    private jwt: JwtService,
    private prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // 1) 接口显式豁免（首次改密 / 我的资料 / 我的站内信）
    if (this.reflector.getAllAndOverride<boolean>(NO_ORG_KEY, [context.getHandler(), context.getClass()])) {
      return true;
    }
    const req = context.switchToHttp().getRequest();
    const token = this.readBearer(req.headers?.authorization);
    if (!token) return true; // 未带凭证：公开接口（对外分享页等）正常放行，需登录的接口自有 401
    let payload: CurrentUserPayload;
    try {
      payload = await this.jwt.verifyAsync<CurrentUserPayload>(token);
    } catch {
      return true; // token 过期/伪造：交由 JwtAuthGuard 统一报「未登录或登录已过期」
    }
    if (payload.impersonatorId) return true; // 管理员身份预览：以目标用户身份排查问题，不受准入限制
    if (payload.role !== Role.MEMBER) return true; // ADMIN/DEPT_LEADER/PROJECT_LEADER 不受组织准入限制
    if (payload.departmentId) return true; // 登录快照里已有部门：绝大多数请求到此结束，不查库
    // 2) 快照无部门：可能是登录后才被分配（无需重新登录），回源确认一次
    const fresh = await this.prisma.user.findUnique({
      where: { id: payload.id },
      select: { departmentId: true },
    });
    if (fresh?.departmentId) return true;
    throw new ForbiddenException({
      code: 'ORG_NOT_JOINED',
      message: '你的账号尚未加入组织，请联系管理员为你分配部门',
    });
  }

  private readBearer(header?: string): string {
    if (!header) return '';
    const [scheme, value] = String(header).split(' ');
    return scheme?.toLowerCase() === 'bearer' ? (value ?? '').trim() : '';
  }
}
