import { SetMetadata } from '@nestjs/common';

/** 组织准入豁免标记的元数据键（见 OrgGuard） */
export const NO_ORG_KEY = 'noOrgAllowed';

/**
 * 标记「未加入组织的用户也可以访问」的接口。
 * 背景：自助注册的新人在管理员为其分配部门之前应处于「等待入职」状态，
 * 全局 OrgGuard 会拦住其余所有接口；但登录后的首次改密、查看自己的资料、
 * 读取自己的站内信必须放行，否则用户连等待页的基础信息都拿不到。
 */
export const AllowNoOrg = () => SetMetadata(NO_ORG_KEY, true);
