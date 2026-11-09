import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { PrismaService } from '../../common/prisma.service';
import { OrgGuard } from '../../common/guards';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtStrategy } from './jwt.strategy';

@Module({
  imports: [
    PassportModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('JWT_SECRET', 'dev-secret'),
        signOptions: { expiresIn: config.get<string>('JWT_EXPIRES_IN', '7d') as any },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    JwtStrategy,
    PrismaService,
    // 组织准入：未分配部门的 MEMBER 只能访问 @AllowNoOrg 接口（全局守卫在此注册，因为 JwtService 已在本模块导入）
    { provide: APP_GUARD, useClass: OrgGuard },
  ],
})
export class AuthModule {}
