import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../../common/prisma.service';
import { CurrentUserPayload } from '../../common/current-user.decorator';
import { nextEmployeeNo } from '../../common/employee-no';

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
  ) {}

  /** 账号可以是邮箱或用户名；两者登录均不区分大小写并去除首尾空格（密码仍是硬校验，不会因此降低安全性） */
  async validateUser(rawAccount: string, password: string) {
    const account = (rawAccount ?? '').trim();
    if (!account) return null;
    const user =
      (await this.prisma.user.findFirst({ where: { email: { equals: account, mode: 'insensitive' } } })) ??
      (await this.prisma.user.findFirst({ where: { username: { equals: account, mode: 'insensitive' } } }));
    if (!user || !user.active) return null;
    const ok = await bcrypt.compare(password, user.password);
    return ok ? user : null;
  }

  /** 登录：账号可为邮箱或用户名 */
  async login(account: string, password: string) {
    const user = await this.validateUser(account, password);
    if (!user) throw new UnauthorizedException('账号或密码错误');
    return this.buildToken(user);
  }

  /**
   * 管理员身份预览：为指定目标用户签发一个带预览标记的短期 token，
   * 供管理员以该用户视角排查问题。仅 ADMIN 可调用（控制器层已做角色守卫），
   * 这里再校验一次发起者身份。返回的 user 强制 mustChangePassword=false，
   * 避免预览时弹出强制改密框打断排查。
   */
  async impersonate(adminId: string, userId: string) {
    const admin = await this.prisma.user.findUnique({ where: { id: adminId } });
    if (!admin || admin.role !== 'ADMIN') {
      throw new ForbiddenException('仅管理员可使用身份预览');
    }
    const target = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!target || !target.active) {
      throw new BadRequestException('目标用户不存在或已停用');
    }
    const payload: CurrentUserPayload = {
      id: target.id,
      name: target.name,
      email: target.email,
      role: target.role,
      departmentId: target.departmentId ?? null,
      impersonatorId: admin.id,
      impersonatorName: admin.name,
    };
    return {
      accessToken: this.jwt.sign(payload),
      user: { ...payload, mustChangePassword: false },
    };
  }

  /** 修改密码：校验旧密码；同时清除首次登录强制改密标记 */
  async changePassword(userId: string, oldPassword: string, newPassword: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException('用户不存在');
    const ok = await bcrypt.compare(oldPassword, user.password);
    if (!ok) throw new BadRequestException('原密码错误');
    if (newPassword.length < 6) throw new BadRequestException('新密码至少 6 位');
    await this.prisma.user.update({
      where: { id: userId },
      data: { password: await bcrypt.hash(newPassword, 10), mustChangePassword: false },
    });
  }

  /** 自注册：用户名/姓名/邮箱/手机号必填；首个注册用户自动成为管理员，其余为普通成员 */
  async register(data: {
    name: string;
    username: string;
    email: string;
    phone: string;
    password: string;
  }) {
    const username = data.username.trim();
    const phone = data.phone?.trim();
    if (!phone) throw new BadRequestException('手机号必填');
    const email = data.email.trim();
    // 邮箱唯一性按忽略大小写判重，避免同一邮箱大小写变体重复注册
    const emailExists = await this.prisma.user.findFirst({ where: { email: { equals: email, mode: 'insensitive' } } });
    if (emailExists) throw new ConflictException('该邮箱已注册');
    const usernameExists = await this.prisma.user.findUnique({ where: { username } });
    if (usernameExists) throw new ConflictException('用户名已存在');
    const count = await this.prisma.user.count();
    const user = await this.prisma.user.create({
      data: {
        name: data.name,
        username,
        email,
        phone,
        employeeNo: await nextEmployeeNo(this.prisma),
        password: await bcrypt.hash(data.password, 10),
        role: count === 0 ? 'ADMIN' : 'MEMBER',
      },
    });
    return this.buildToken(user);
  }

  private buildToken(user: {
    id: string;
    name: string;
    email: string;
    role: string;
    departmentId?: string | null;
    mustChangePassword: boolean;
  }) {
    const payload: CurrentUserPayload = {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      departmentId: user.departmentId ?? null,
    };
    return {
      accessToken: this.jwt.sign(payload),
      user: { ...payload, mustChangePassword: user.mustChangePassword },
    };
  }
}
