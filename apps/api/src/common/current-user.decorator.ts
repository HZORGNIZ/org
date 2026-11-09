import { createParamDecorator, ExecutionContext } from '@nestjs/common';

export interface CurrentUserPayload {
  id: string;
  name: string;
  email: string;
  role: string;
  departmentId?: string | null;
  /** 管理员身份预览（impersonation）时记录发起预览的管理员，便于审计；普通登录不带此字段 */
  impersonatorId?: string;
  impersonatorName?: string;
}

export const CurrentUser = createParamDecorator(
  (data: keyof CurrentUserPayload | undefined, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest();
    const user = request.user as CurrentUserPayload;
    return data ? user?.[data] : user;
  },
);
