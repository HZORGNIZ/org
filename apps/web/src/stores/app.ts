import { defineStore } from 'pinia';
import { notificationsApi } from '../api';

/** 全局应用状态：未读通知数（轮询刷新） */
export const useAppStore = defineStore('app', {
  state: () => ({
    unreadCount: 0,
    timer: null as any,
  }),
  actions: {
    async refreshUnread() {
      try {
        this.unreadCount = await notificationsApi.unreadCount();
      } catch {
        /* 忽略轮询错误 */
      }
    },
    startPolling(intervalMs = 30000) {
      this.stopPolling();
      this.refreshUnread();
      this.timer = setInterval(() => this.refreshUnread(), intervalMs);
    },
    stopPolling() {
      if (this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
    },
  },
});
