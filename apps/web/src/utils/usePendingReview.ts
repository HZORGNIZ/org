import { computed, ref } from 'vue';
import dayjs from 'dayjs';
import { pbcApi, projectsApi } from '../api';
import { useAuthStore } from '../stores/auth';

/**
 * 「待我审核」聚合数据：三个来源，全部走既有接口（权限已在后端过滤）
 * 1. 项目审批：GET /projects/pending（ADMIN 全量；其他人仅被指定审批人/加签人）
 * 2. PBC 计划审批：GET /pbc/team（仅 ADMIN/部门负责人可调），筛 SUBMITTED 且 canApprove
 * 3. PBC 考核评分：GET /pbc/review-queue（ADMIN 全量；其他人仅自己是打分上级的），筛 SELF_DONE
 * 普通成员三个来源通常都为空 → 调用方据此隐藏「待审核」入口（成员不需要该功能）
 */
export function usePendingReview() {
  const auth = useAuthStore();
  const projects = ref<any[]>([]);
  const pbcPlans = ref<any[]>([]);
  const pbcScores = ref<any[]>([]);
  const loading = ref(false);

  async function load() {
    loading.value = true;
    try {
      const jobs: Promise<any>[] = [
        projectsApi.pending().catch(() => []),
        pbcApi.reviewQueue().catch(() => null),
      ];
      // 计划审批只有管理员/部门负责人能看团队表：本月 + 上月（防止上月漏审的计划被漏掉）
      if (auth.isAdmin || auth.isDeptLeader) {
        for (const m of [dayjs().format('YYYY-MM'), dayjs().subtract(1, 'month').format('YYYY-MM')]) {
          jobs.push(
            pbcApi.team(m).then((rows: any[]) => (Array.isArray(rows) ? rows.map((r) => ({ ...r, month: m })) : [])),
          );
        }
      }
      const [pendingProjects, queue, ...teams] = await Promise.all(jobs);
      projects.value = Array.isArray(pendingProjects) ? pendingProjects : [];
      pbcScores.value = (queue?.rows || []).filter((r: any) => r.reviewStatus === 'SELF_DONE');
      const teamRows = teams.flat();
      const seen = new Set<string>();
      pbcPlans.value = teamRows.filter((r: any) => {
        if (r.status !== 'SUBMITTED' || !r.canApprove) return false;
        const key = `${r.userId}-${r.month}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    } finally {
      loading.value = false;
    }
  }

  const total = computed(() => projects.value.length + pbcPlans.value.length + pbcScores.value.length);

  return { projects, pbcPlans, pbcScores, loading, total, load };
}
