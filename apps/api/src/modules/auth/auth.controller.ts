import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { IsEmail, IsNotEmpty, IsString, Matches, MinLength } from 'class-validator';
import { Role } from '@prisma/client';
import { AuthService } from './auth.service';
import { JwtAuthGuard, RolesGuard } from '../../common/guards';
import { Roles } from '../../common/roles.decorator';
import { AllowNoOrg } from '../../common/no-org.decorator';
import { CurrentUser } from '../../common/current-user.decorator';

class LoginDto {
  @IsString()
  account: string; // 邮箱或用户名

  @IsString()
  password: string;
}

class RegisterDto {
  @IsString()
  @Matches(/^[A-Za-z0-9_]{2,20}$/, { message: '用户名需 2-20 位字母/数字/下划线' })
  username: string; // 登录用户名（登录也可用邮箱）

  @IsString()
  @MinLength(2)
  name: string;

  @IsEmail()
  email: string;

  @IsString()
  @IsNotEmpty({ message: '手机号必填' })
  phone: string; // 手机号（仅记录，团队通讯用）

  @IsString()
  @MinLength(6)
  password: string;
}

@Controller('auth')
export class AuthController {
  constructor(private auth: AuthService) {}

  @Post('login')
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto.account, dto.password);
  }

  /** 修改密码：管理员创建的账号首次登录会被强制改密，此时可能尚未分配部门，故豁免组织准入 */
  @Post('change-password')
  @AllowNoOrg()
  @UseGuards(JwtAuthGuard)
  changePassword(
    @CurrentUser('id') userId: string,
    @Body() dto: { oldPassword: string; newPassword: string },
  ) {
    return this.auth.changePassword(userId, dto.oldPassword, dto.newPassword);
  }

  @Post('register')
  register(@Body() dto: RegisterDto) {
    return this.auth.register(dto);
  }

  /** 管理员身份预览：以指定用户身份签发一个带预览标记的短期 token（仅 ADMIN） */
  @Post('impersonate')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  impersonate(@CurrentUser('id') adminId: string, @Body() dto: { userId: string }) {
    return this.auth.impersonate(adminId, dto.userId);
  }
}
