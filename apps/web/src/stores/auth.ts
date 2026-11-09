import { defineStore } from 'pinia';
import { usersApi } from '../api';

/** 读取身份预览时备份的管理员登录态（存在即表示当前处于「以他人身份预览」状态） */
function readAdminBackup(): { token: string; user: any } | null {
  const t = localStorage.getItem('myorgniz_admin_token');
  if (!t) return null;
  const u = localStorage.getItem('myorgniz_admin_user');
  return { token: t, user: u ? JSON.parse(u) : null };
}

export const useAuthStore = defineStore('auth', {
  state: () => ({
    token: localStorage.getItem('myorgniz_token') || '',
    user: JSON.parse(localStorage.getItem('myorgniz_user') || 'null') as any,
    // 管理员身份预览备份：非空表示当前以他人身份预览，退出时据此恢复管理员登录态
    adminBackup: readAdminBackup() as { token: string; user: any } | null,
  }),
  getters: {
    isAdmin: (s) => s.user?.role === 'ADMIN',
    isDeptLeader: (s) => s.user?.role === 'DEPT_LEADER',
    isProjectLeader: (s) => s.user?.role === 'PROJECT_LEADER',
    // 角色层级序：ADMIN(3) > DEPT_LEADER(2) > PROJECT_LEADER(1) > MEMBER(0)
    roleRank: (s) =>
      (({ ADMIN: 3, DEPT_LEADER: 2, PROJECT_LEADER: 1, MEMBER: 0 } as Record<string, number>)[
        s.user?.role
      ] ?? 0),
    loggedIn: (s) => !!s.token,
    /**
     * 待加入组织：普通成员已登录但管理员尚未分配部门。
     * 只针对 MEMBER：ADMIN 首用户本就无部门，DEPT_LEADER/PROJECT_LEADER 的权限依附于任命的部门，
     * 误锁会打断他们已有的项目工作（已在方案里跟你确认过）。
     */
    pendingOrg: (s) => !!s.token && s.user?.role === 'MEMBER' && !s.user?.departmentId,
    // 是否处于「以他人身份预览」状态
    isImpersonating: (s) => !!s.adminBackup,
    // 正在预览的目标用户姓名
    impersonatingName: (s) => s.user?.name ?? '',
  },
  actions: {
    setAuth(token: string, user: any) {
      this.token = token;
      this.user = user;
      localStorage.setItem('myorgniz_token', token);
      localStorage.setItem('myorgniz_user', JSON.stringify(user));
    },
    async fetchMe() {
      const me = await usersApi.me();
      // 预览态下不因目标用户的改密标记弹出强制改密框，避免打断排查
      if (this.isImpersonating && me) me.mustChangePassword = false;
      this.user = me;
      localStorage.setItem('myorgniz_user', JSON.stringify(me));
      return me;
    },
    /** 进入身份预览：先备份当前管理员登录态，再切换到目标用户 */
    startImpersonation(token: string, user: any) {
      this.adminBackup = { token: this.token, user: this.user };
      localStorage.setItem('myorgniz_admin_token', this.token);
      localStorage.setItem('myorgniz_admin_user', JSON.stringify(this.user));
      // 预览用户强制不改密
      const nextUser = user ? { ...user, mustChangePassword: false } : user;
      this.setAuth(token, nextUser);
    },
    /** 退出身份预览：恢复管理员登录态 */
    stopImpersonation() {
      if (!this.adminBackup) return;
      this.setAuth(this.adminBackup.token, this.adminBackup.user);
      localStorage.removeItem('myorgniz_admin_token');
      localStorage.removeItem('myorgniz_admin_user');
      this.adminBackup = null;
    },
    logout() {
      this.token = '';
      this.user = null;
      this.adminBackup = null;
      localStorage.removeItem('myorgniz_token');
      localStorage.removeItem('myorgniz_user');
      localStorage.removeItem('myorgniz_admin_token');
      localStorage.removeItem('myorgniz_admin_user');
    },
  },
});
