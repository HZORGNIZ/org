import axios from 'axios';
import { ElMessage } from 'element-plus';

/** axios 实例：自动携带 JWT，401 时跳转登录 */
export const http = axios.create({
  baseURL: '/api',
  timeout: 30000,
});

/**
 * 活动对外页访问密码票据：解锁后按 token 存在 localStorage，
 * 拦截器对 /public/meetings/<token> 请求自动附加 ?pwdTicket=，服务端验票后才放行。
 */
const PWD_TICKET_PREFIX = 'myorgniz_meeting_pwd_';
export function setMeetingPwdTicket(token: string, ticket: string) {
  try {
    if (ticket) localStorage.setItem(PWD_TICKET_PREFIX + token, ticket);
    else localStorage.removeItem(PWD_TICKET_PREFIX + token);
  } catch {
    // 隐私模式等存不了就每次进页重输密码，不影响功能可用
  }
}
export function getMeetingPwdTicket(token: string): string {
  try {
    return localStorage.getItem(PWD_TICKET_PREFIX + token) || '';
  } catch {
    return '';
  }
}
/** 从对外接口 URL 里提出活动 token，命中则附本机票据 */
function withPwdTicket(url: string): string {
  const m = /^\/public\/meetings\/([0-9a-f]+)(\?|$)/.exec(url);
  if (!m) return url;
  const ticket = getMeetingPwdTicket(m[1]);
  if (!ticket) return url;
  return url + (url.includes('?') ? '&' : '?') + 'pwdTicket=' + encodeURIComponent(ticket);
}

http.interceptors.request.use((config) => {
  const token = localStorage.getItem('myorgniz_token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  if (config.url) config.url = withPwdTicket(config.url);
  return config;
});

http.interceptors.response.use(
  (res) => res.data,
  (err) => {
    const status = err.response?.status;
    const msg = err.response?.data?.message;
    // 活动密码门：交由页面展示密码输入卡片，不弹错、不跳登录（轮询命中也不刷屏）
    if (status === 403 && msg?.code === 'NEED_PASSWORD') {
      return Promise.reject(err);
    }
    if (status === 401) {
      localStorage.removeItem('myorgniz_token');
      if (!location.pathname.startsWith('/login')) {
        // 带上当前页面：从 /mobile 等直达入口被踢回登录时，登录后要原路回去（不能一律丢回首页）
        const back = location.pathname + location.search;
        location.href = `/login?redirect=${encodeURIComponent(back)}`;
      }
    } else {
      // 校验类错误 message 可能为数组（class-validator），取首条提示
      ElMessage.error(
        Array.isArray(msg) ? msg[0] : typeof msg === 'string' ? msg : '请求失败，请稍后重试',
      );
    }
    return Promise.reject(err);
  },
);

/** 通用 CRUD 封装 */
export const api = {
  get: <T>(url: string, params?: any) => http.get<T, T>(url, { params }),
  post: <T>(url: string, data?: any) => http.post<T, T>(url, data),
  put: <T>(url: string, data?: any) => http.put<T, T>(url, data),
  patch: <T>(url: string, data?: any) => http.patch<T, T>(url, data),
  del: <T>(url: string) => http.delete<T, T>(url),
};
