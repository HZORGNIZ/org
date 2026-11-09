import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NotificationType, Role } from '@prisma/client';
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../../common/prisma.service';
import { hasAtLeast } from '../../common/permissions';
import { NotificationsService } from '../notifications/notifications.service';
import { MeetingActor, MeetingService } from './meeting.service';

/** 单次加分上限（防手滑打错数量级） */
const MAX_SCORE = 50;
/** 陌生人签到手机号：国内 11 位手机号 */
const PHONE_RE = /^1\d{10}$/;
/** 访问密码解锁票据有效期：30 天（同一设备输一次就行） */
const PWD_TICKET_TTL_MS = 30 * 24 * 3600 * 1000;

/**
 * 会议活动的现场互动：对外链接（陌生人看活动/签到/答题加分）、助教任命、
 * 加分与审批、座位相邻自主分组、实时组得分。
 *
 * 权限口径：
 * - 组织者 = 发起人本人或管理员，可任命助教、改答题、对外链接
 * - 管理层 = 组织者 + 本场助教，可加分、审批、管理小组
 */
@Injectable()
export class MeetingActivityService {
  private readonly logger = new Logger(MeetingActivityService.name);

  constructor(
    private prisma: PrismaService,
    private meeting: MeetingService,
    private notifications: NotificationsService,
    private config: ConfigService,
  ) {}

  // ============ 对外链接 ============

  /** 取（或首次生成）对外开放链接：陌生人凭此链接免登录看活动与得分、签到、答题加分 */
  async publicLink(me: MeetingActor, id: string) {
    const m = await this.meeting.mustFind(id);
    this.meeting.assertManager(me, m);
    if (m.publicToken) return this.linkPayload(m.publicToken);
    for (let i = 0; i < 5; i++) {
      const token = randomBytes(10).toString('hex');
      try {
        await this.prisma.meeting.update({ where: { id }, data: { publicToken: token } });
        this.logger.log(`活动对外链接已生成 meeting=${id} by=${me.id}`);
        return this.linkPayload(token);
      } catch {
        // token 撞了唯一键就重试；其它错误下一轮仍会抛出
      }
    }
    throw new BadRequestException('生成对外链接失败，请稍后重试');
  }

  private linkPayload(token: string) {
    return { ok: true, token, path: `/share/meeting/${token}` };
  }

  // ============ 访问密码（活动对所有人开放，发起者可加一道密码门） ============

  /** 设置 / 清除对外访问密码：空密码即取消，输密码才能进活动主页 */
  async setPublicPassword(me: MeetingActor, id: string, password?: string) {
    const m = await this.meeting.mustFind(id);
    this.meeting.assertManager(me, m);
    const pwd = (password ?? '').trim();
    if (!pwd) {
      await this.prisma.meeting.update({ where: { id }, data: { publicPassword: null } });
      this.logger.log(`活动访问密码已取消 meeting=${id} by=${me.id}`);
      return { ok: true, protected: false };
    }
    if (pwd.length < 4 || pwd.length > 20) throw new BadRequestException('访问密码请设 4~20 位');
    await this.prisma.meeting.update({ where: { id }, data: { publicPassword: await bcrypt.hash(pwd, 10) } });
    this.logger.log(`活动访问密码已设置 meeting=${id} by=${me.id}`);
    return { ok: true, protected: true };
  }

  /** 对外页入口探测：是否设了密码、本机票据是否仍有效（不泄露活动信息） */
  async publicAccess(token: string, ticket?: string) {
    const t = (token ?? '').trim();
    if (!t) throw new NotFoundException('链接无效');
    const m = await this.prisma.meeting.findFirst({ where: { publicToken: t, deletedAt: null } });
    if (!m) throw new NotFoundException('活动不存在或链接已失效');
    const needPassword = !!m.publicPassword;
    return { needPassword, valid: !needPassword || this.verifyTicket(t, ticket, m.id) };
  }

  /** 输入访问密码换取解锁票据：此后本机 30 天内免再输 */
  async publicUnlock(token: string, password?: string) {
    const t = (token ?? '').trim();
    if (!t) throw new NotFoundException('链接无效');
    const m = await this.prisma.meeting.findFirst({ where: { publicToken: t, deletedAt: null } });
    if (!m) throw new NotFoundException('活动不存在或链接已失效');
    if (!m.publicPassword) return { ok: true, ticket: '' };
    const pwd = (password ?? '').trim();
    if (!pwd || !(await bcrypt.compare(pwd, m.publicPassword))) {
      this.logger.log(`活动密码错误 meeting=${m.id}`);
      throw new ForbiddenException('访问密码错误');
    }
    return { ok: true, ticket: this.signTicket(t, m.id) };
  }

  /** 票据 = HMAC(secret, token.meetingId.过期时间戳)，不落库；发起人改/清密码后旧票立即作废 */
  private signTicket(token: string, meetingId: string) {
    const exp = Date.now() + PWD_TICKET_TTL_MS;
    return `${exp}.${this.ticketSig(token, meetingId, exp)}`;
  }

  private verifyTicket(token: string, ticket: string | undefined, meetingId: string) {
    const raw = (ticket ?? '').trim();
    if (!raw) return false;
    const sep = raw.indexOf('.');
    if (sep < 0) return false;
    const exp = Number(raw.slice(0, sep));
    const sig = raw.slice(sep + 1);
    if (!Number.isFinite(exp) || exp < Date.now() || !sig) return false;
    const expect = Buffer.from(this.ticketSig(token, meetingId, exp), 'hex');
    const got = Buffer.from(sig, 'hex');
    return expect.length === got.length && timingSafeEqual(expect, got);
  }

  private ticketSig(token: string, meetingId: string, exp: number) {
    return createHmac('sha256', this.secretKey()).update(`${token}.${meetingId}.${exp}`).digest('hex');
  }

  private secretKey() {
    return this.config.get<string>('JWT_SECRET', 'dev-secret');
  }

  /** 公开入口：token 换会议；设了访问密码时验票，失效/删除都按不存在处理 */
  private async byToken(token: string, ticket?: string) {
    const t = (token ?? '').trim();
    if (!t) throw new NotFoundException('链接无效');
    const m = await this.prisma.meeting.findFirst({ where: { publicToken: t, deletedAt: null } });
    if (!m) throw new NotFoundException('活动不存在或链接已失效');
    if (m.publicPassword && !this.verifyTicket(t, ticket, m.id)) {
      throw new ForbiddenException({ code: 'NEED_PASSWORD', message: '该活动已设置访问密码，请输入密码后访问' });
    }
    return m;
  }

  // ============ 助教 ============

  /** 任命助教：必须是本场参会人员（发起人本人天然是管理层，不需要任命） */
  async setAssistant(me: MeetingActor, id: string, userId: string, enable: boolean) {
    const m = await this.meeting.mustFind(id);
    this.meeting.assertManager(me, m);
    const target = (userId ?? '').trim();
    if (!target) throw new BadRequestException('请选择要任命的人员');
    if (target === m.ownerId) throw new BadRequestException('发起人本身就是活动管理者');
    if (!m.participantIds.includes(target)) throw new BadRequestException('助教必须是本场活动的参会人员');
    const current = m.assistantIds ?? [];
    const next = enable
      ? Array.from(new Set([...current, target]))
      : current.filter((x) => x !== target);
    await this.prisma.meeting.update({ where: { id }, data: { assistantIds: next } });
    return { ok: true, assistantIds: next };
  }

  // ============ 答题加分设置（组织者） ============

  /** 设置答题加分：题目 + 标准答案 + 每题分值；题目与答案都留空表示关闭 */
  async saveQuiz(me: MeetingActor, id: string, input: { question?: string; answer?: string; points?: number }) {
    const m = await this.meeting.mustFind(id);
    this.meeting.assertManager(me, m);
    const question = (input.question ?? '').trim();
    const answer = (input.answer ?? '').trim();
    if (!question && !answer) {
      await this.prisma.meeting.update({ where: { id }, data: { quizQuestion: null, quizAnswer: null } });
      return { ok: true, enabled: false };
    }
    if (!question) throw new BadRequestException('请填写题目');
    if (!answer) throw new BadRequestException('请填写标准答案');
    const points = this.normPoints(input.points ?? m.quizPoints);
    await this.prisma.meeting.update({ where: { id }, data: { quizQuestion: question, quizAnswer: answer, quizPoints: points } });
    return { ok: true, enabled: true, points };
  }

  // ============ 加分 / 审批 ============

  /** 组织者或助教直接给某个人（内部成员或陌生签到人）加分 */
  async addScore(me: MeetingActor, id: string, input: { targetType?: string; userId?: string; guestId?: string; points?: number; reason?: string }) {
    const m = await this.meeting.mustFind(id);
    this.assertManager(m, me);
    if (m.status === 'CANCELLED') throw new BadRequestException('活动已取消，不能加分');
    const points = this.normPoints(input.points);
    const reason = (input.reason ?? '').trim().slice(0, 200) || null;
    const guestId = (input.guestId ?? '').trim();
    const isGuest = (input.targetType ?? '').toUpperCase() === 'GUEST' || !!guestId;
    if (isGuest) {
      const g = guestId
        ? await this.prisma.meetingGuest.findFirst({ where: { id: guestId, meetingId: id } })
        : null;
      if (!g) throw new BadRequestException('请选择陌生的签到人员');
      // 该来宾已关联注册用户（扫码时命中同名同手机号）时，加分直接记在用户名下，避免同一个人两份分
      const ownerId = g.userId;
      const row = await this.prisma.meetingScore.create({
        data: {
          meetingId: id,
          ...(ownerId ? { userId: ownerId } : { guestId: g.id }),
          points,
          reason,
          source: 'MANUAL',
          status: 'APPROVED',
          createdById: me.id,
          approvedById: me.id,
          approvedAt: new Date(),
        },
      });
      return { ok: true, id: row.id, name: g.name, points, guestId: g.id, userId: ownerId };
    }
    const userId = (input.userId ?? '').trim();
    if (!userId) throw new BadRequestException('请选择要加分的人员');
    if (!m.participantIds.includes(userId) && m.ownerId !== userId) throw new BadRequestException('该人不在本场活动的参会名册中');
    const u = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true, name: true } });
    if (!u) throw new BadRequestException('人员不存在');
    const row = await this.prisma.meetingScore.create({
      data: { meetingId: id, userId, points, reason, source: 'MANUAL', status: 'APPROVED', createdById: me.id, approvedById: me.id, approvedAt: new Date() },
    });
    return { ok: true, id: row.id, name: u.name, points, userId };
  }

  /** 审批陌生人的答题自助加分 */
  async reviewScore(me: MeetingActor, id: string, scoreId: string, approve: boolean) {
    const m = await this.meeting.mustFind(id);
    this.assertManager(m, me);
    const s = await this.prisma.meetingScore.findFirst({ where: { id: scoreId, meetingId: id } });
    if (!s) throw new NotFoundException('加分记录不存在');
    if (s.status !== 'PENDING') throw new BadRequestException('该记录已审批过了');
    const row = await this.prisma.meetingScore.update({
      where: { id: scoreId },
      data: { status: approve ? 'APPROVED' : 'REJECTED', approvedById: me.id, approvedAt: new Date() },
    });
    return { ok: true, status: row.status };
  }

  /** 撤销一条加分（加错了） */
  async removeScore(me: MeetingActor, id: string, scoreId: string) {
    const m = await this.meeting.mustFind(id);
    this.assertManager(m, me);
    const s = await this.prisma.meetingScore.findFirst({ where: { id: scoreId, meetingId: id } });
    if (!s) throw new NotFoundException('加分记录不存在');
    await this.prisma.meetingScore.delete({ where: { id: scoreId } });
    return { ok: true };
  }

  // ============ 自主分组（座位相邻的人抱团） ============

  /** 建组：自己一定在组里，可顺手拉上旁边的同事；组长默认自己 */
  async createGroup(me: MeetingActor, id: string, input: { name?: string; leaderId?: string; memberIds?: string[] }) {
    const m = await this.meeting.mustFind(id);
    this.assertParticipant(m, me);
    const name = (input.name ?? '').trim().slice(0, 20);
    if (!name) throw new BadRequestException('请给小组起个名字');
    const dup = await this.prisma.meetingGroup.findUnique({ where: { meetingId_name: { meetingId: id, name } } });
    if (dup) throw new BadRequestException('组名已被占用，换一个吧');
    const roster = new Set<string>([m.ownerId, ...m.participantIds]);
    const members = new Set<string>([me.id]);
    for (const uid of input.memberIds ?? []) if (roster.has(uid)) members.add(uid);
    const leaderId = input.leaderId && members.has(input.leaderId) ? input.leaderId : me.id;
    // 一人一组：先退出其它组
    const groupIds = (await this.prisma.meetingGroup.findMany({ where: { meetingId: id }, select: { id: true } })).map((g) => g.id);
    if (groupIds.length) {
      await this.prisma.meetingGroupMember.deleteMany({ where: { userId: { in: Array.from(members) }, groupId: { in: groupIds } } });
    }
    const g = await this.prisma.meetingGroup.create({
      data: { meetingId: id, name, leaderId, createdById: me.id, members: { create: Array.from(members).map((userId) => ({ userId })) } },
    });
    return { ok: true, id: g.id, name: g.name };
  }

  /** 加入某个组（自动从原组退出） */
  async joinGroup(me: MeetingActor, id: string, groupId: string) {
    const m = await this.meeting.mustFind(id);
    this.assertParticipant(m, me);
    const g = await this.prisma.meetingGroup.findFirst({ where: { id: groupId, meetingId: id } });
    if (!g) throw new NotFoundException('小组不存在');
    const groupIds = (await this.prisma.meetingGroup.findMany({ where: { meetingId: id }, select: { id: true } })).map((x) => x.id);
    await this.prisma.meetingGroupMember.deleteMany({ where: { userId: me.id, groupId: { in: groupIds } } });
    await this.prisma.meetingGroupMember.create({ data: { groupId, userId: me.id } });
    return { ok: true, groupId };
  }

  /**
   * 拖头像入组：把某个成员 / 来宾分进指定小组，或拖到空白处新建一个小组
   * - 管理层（发起人 / 管理员 / 助教）可以拖任何人；本人拖自己 = 自己加入，走参会人校验
   * - 一人一组：入组前先从原来的组里摘出来，原组空了就收掉
   */
  async assignGroup(
    me: MeetingActor,
    id: string,
    input: { groupId?: string; name?: string; userId?: string; guestId?: string },
  ) {
    const m = await this.meeting.mustFind(id);
    const userId = (input.userId ?? '').trim() || null;
    const guestId = (input.guestId ?? '').trim() || null;
    if (!userId && !guestId) throw new BadRequestException('请先选择要分组的成员');
    const isSelf = !!userId && userId === me.id;
    if (isSelf) this.assertParticipant(m, me);
    else this.assertManager(m, me);

    // 目标必须是本场的人：注册用户看名单，来宾看签到记录
    let memberName = '';
    if (userId) {
      if (m.ownerId !== userId && !(m.participantIds ?? []).includes(userId)) {
        throw new BadRequestException('这位成员不在本场名单里');
      }
      memberName = (await this.prisma.user.findUnique({ where: { id: userId }, select: { name: true } }))?.name ?? '成员';
    } else {
      const g = await this.prisma.meetingGuest.findFirst({ where: { id: guestId!, meetingId: m.id }, select: { name: true } });
      if (!g) throw new BadRequestException('这位来宾还没有签到，没法分组');
      memberName = g.name;
    }

    const groupId = (input.groupId ?? '').trim();
    if (!groupId) {
      const name = await this.freeGroupName(m.id, input.name);
      // 一人一组：新建组也要先把 TA（注册账号 + 签到记录两个身份）从原来的组里摘出来
      await this.dropPerson(m.id, userId, guestId);
      const g = await this.prisma.meetingGroup.create({
        data: {
          meetingId: m.id,
          name,
          createdById: me.id,
          leaderId: userId,
          leaderGuestId: guestId,
          members: { create: [userId ? { userId } : { guestId: guestId! }] },
        },
      });
      this.logger.log(`拖头像新建小组「${m.title}」group=${g.id} name=${name} 成员=${memberName}`);
      return { ok: true, groupId: g.id, name: g.name, memberName };
    }

    const g = await this.groupOf(m.id, groupId);
    const dup = await this.prisma.meetingGroupMember.findFirst({
      where: { groupId: g.id, ...(userId ? { userId } : { guestId }) },
      select: { id: true },
    });
    if (dup) return { ok: true, groupId: g.id, name: g.name, memberName }; // 重复拖进来不报错

    await this.dropPerson(m.id, userId, guestId);
    await this.prisma.meetingGroupMember.create({
      data: userId ? { groupId: g.id, userId } : { groupId: g.id, guestId: guestId! },
    });
    // 组里原本没组长（组长退位或被清空）时，进来的人顺手当组长，避免留下无主组
    if (!g.leaderId && !g.leaderGuestId) {
      await this.prisma.meetingGroup.update({
        where: { id: g.id },
        data: userId ? { leaderId: userId } : { leaderGuestId: guestId },
      });
    }
    this.logger.log(`拖头像入组「${m.title}」group=${g.id} name=${g.name} 成员=${memberName}`);
    return { ok: true, groupId: g.id, name: g.name, memberName };
  }

  /** 新建小组时的组名：用户没起名字就按「第 N 组」顺延，起了名字要查重 */
  private async freeGroupName(meetingId: string, wanted?: string) {
    const text = (wanted ?? '').trim().slice(0, 20);
    if (text) {
      const dup = await this.prisma.meetingGroup.findUnique({ where: { meetingId_name: { meetingId, name: text } } });
      if (dup) throw new BadRequestException('组名已被占用，换一个吧');
      return text;
    }
    const used = new Set(
      (await this.prisma.meetingGroup.findMany({ where: { meetingId }, select: { name: true } })).map((g) => g.name),
    );
    for (let i = used.size + 1; i < used.size + 100; i++) {
      const name = `第${i}组`;
      if (!used.has(name)) return name;
    }
    return `第${Date.now() % 1000}组`;
  }

  /** 一人一组（注册用户版）：先从本场所有组里摘掉，原组空了就收掉 */
  private async dropUserFromGroups(meetingId: string, userId: string) {
    const groupIds = (await this.prisma.meetingGroup.findMany({ where: { meetingId }, select: { id: true } })).map((x) => x.id);
    if (!groupIds.length) return;
    const mine = await this.prisma.meetingGroupMember.findMany({
      where: { userId, groupId: { in: groupIds } },
      select: { groupId: true },
    });
    if (!mine.length) return;
    await this.prisma.meetingGroupMember.deleteMany({ where: { userId, groupId: { in: groupIds } } });
    await this.prisma.meetingGroup.updateMany({ where: { meetingId, leaderId: userId }, data: { leaderId: null } });
    for (const gid of new Set(mine.map((x) => x.groupId))) await this.dropEmptyGroup(gid);
  }

  /** 退出小组（组长退出则组长位清空，组内重新选） */
  async leaveGroup(me: MeetingActor, id: string, groupId: string) {
    const m = await this.meeting.mustFind(id);
    this.assertParticipant(m, me);
    const g = await this.prisma.meetingGroup.findFirst({ where: { id: groupId, meetingId: id } });
    if (!g) throw new NotFoundException('小组不存在');
    await this.prisma.meetingGroupMember.deleteMany({ where: { groupId, userId: me.id } });
    if (g.leaderId === me.id) await this.prisma.meetingGroup.update({ where: { id: groupId }, data: { leaderId: null } });
    // 最后一个人退了，空组直接收掉
    await this.dropEmptyGroup(groupId);
    return { ok: true };
  }

  /**
   * 把人移出小组（座位图 / 管理面板里拖到「移出小组」区）：回到未分组
   * - 管理层（发起人 / 管理员 / 本场助教）可以移任何人；本人只能移自己
   * - 注册账号与扫码签到两个身份一起摘，原组空了就收掉，组长位同时清空
   */
  async leaveMember(me: MeetingActor, id: string, input: { userId?: string; guestId?: string }) {
    const m = await this.meeting.mustFind(id);
    const userId = (input.userId ?? '').trim() || null;
    const guestId = (input.guestId ?? '').trim() || null;
    if (!userId && !guestId) throw new BadRequestException('请先选择要移出的成员');

    // 目标必须是本场的人：注册用户看名单，来宾看签到记录
    let memberName = '';
    let guestUserId: string | null = null;
    if (userId) {
      if (m.ownerId !== userId && !(m.participantIds ?? []).includes(userId)) {
        throw new BadRequestException('这位成员不在本场名单里');
      }
      memberName = (await this.prisma.user.findUnique({ where: { id: userId }, select: { name: true } }))?.name ?? '成员';
    } else {
      const g = await this.prisma.meetingGuest.findFirst({
        where: { id: guestId!, meetingId: m.id },
        select: { name: true, userId: true },
      });
      if (!g) throw new BadRequestException('这位来宾还没有签到，没法分组');
      memberName = g.name;
      guestUserId = g.userId;
    }
    // 不是管理层就只能是移自己（签到记录已关联到本人也算本人）
    if (!this.isManager(m, me)) {
      const self = (userId && userId === me.id) || (!!guestUserId && guestUserId === me.id);
      if (!self) throw new ForbiddenException('只有本人或活动管理者可以把人移出小组');
    }

    const groupIds = (await this.prisma.meetingGroup.findMany({ where: { meetingId: m.id }, select: { id: true } })).map((x) => x.id);
    const { uid, gid } = await this.identities(m.id, userId, guestId);
    const wasIn = groupIds.length
      ? await this.prisma.meetingGroupMember.count({ where: { groupId: { in: groupIds }, ...(uid ? { userId: uid } : { guestId: gid! }) } })
      : 0;
    await this.dropPerson(m.id, userId, guestId);
    this.logger.log(`移出小组「${m.title}」成员=${memberName} 原本在组=${wasIn > 0}`);
    return { ok: true, name: memberName, removed: wasIn > 0 };
  }

  /** 改组名 / 选组长 / 摆座位：组员、组长、建组人或管理层都可以操作 */
  async updateGroup(
    me: MeetingActor,
    id: string,
    groupId: string,
    input: { name?: string; leaderId?: string | null; seatRow?: number; seatCol?: number },
  ) {
    const m = await this.meeting.mustFind(id);
    await this.meeting.assertViewer(me, m);
    const g = await this.prisma.meetingGroup.findFirst({ where: { id: groupId, meetingId: id }, include: { members: { select: { userId: true } } } });
    if (!g) throw new NotFoundException('小组不存在');
    const isMember = g.members.some((x) => x.userId === me.id);
    if (!isMember && !this.isManager(m, me) && g.createdById !== me.id) throw new ForbiddenException('只有组内成员或活动管理者可以修改小组');
    const data: Record<string, unknown> = {};
    if (input.name !== undefined) {
      const name = (input.name ?? '').trim().slice(0, 20);
      if (!name) throw new BadRequestException('组名不能为空');
      if (name !== g.name) {
        const dup = await this.prisma.meetingGroup.findUnique({ where: { meetingId_name: { meetingId: id, name } } });
        if (dup) throw new BadRequestException('组名已被占用，换一个吧');
      }
      data.name = name;
    }
    if (input.leaderId !== undefined) {
      const leaderId = (input.leaderId ?? '').trim();
      if (leaderId && !g.members.some((x) => x.userId === leaderId)) throw new BadRequestException('组长必须是本组成员');
      data.leaderId = leaderId || null;
    }
    // 会场座位图：拖动小组时把落点坐标存下来（-1 表示撤回到未摆放）
    if (input.seatRow !== undefined) data.seatRow = this.normSeat(input.seatRow);
    if (input.seatCol !== undefined) data.seatCol = this.normSeat(input.seatCol);
    if (!Object.keys(data).length) return { ok: true };
    await this.prisma.meetingGroup.update({ where: { id: groupId }, data });
    return { ok: true };
  }

  /** 解散小组：建组人、组长或活动管理层 */
  async removeGroup(me: MeetingActor, id: string, groupId: string) {
    const m = await this.meeting.mustFind(id);
    await this.meeting.assertViewer(me, m);
    const g = await this.prisma.meetingGroup.findFirst({ where: { id: groupId, meetingId: id } });
    if (!g) throw new NotFoundException('小组不存在');
    const allowed = this.isManager(m, me) || g.createdById === me.id || g.leaderId === me.id;
    if (!allowed) throw new ForbiddenException('只有建组人、组长或活动管理者可以解散小组');
    await this.prisma.meetingGroup.delete({ where: { id: groupId } });
    return { ok: true };
  }

  // ============ 实时看板（内部 / 公开共用） ============

  /** 内部看板：登录成员看，含待审批明细与标准答案 */
  async board(me: MeetingActor, id: string) {
    const m = await this.meeting.mustFind(id);
    await this.meeting.assertViewer(me, m);
    return this.buildBoard(m, { internal: true, me });
  }

  /** 对外看板：陌生人凭 token 看活动、参与情况与各组得分（设了密码时验票） */
  async publicBoard(token: string, ticket?: string) {
    const m = await this.byToken(token, ticket);
    return this.buildBoard(m, { internal: false });
  }

  /**
   * 扫码签到：只填姓名 + 手机号，同一场同一手机号幂等。
   * 若姓名与手机号都与某个注册用户完全一致，则视作本人参加：写考勤、并入名册、发站内信，
   * 这场活动的参加记录与得分都归到该注册用户名下。
   *
   * 信息重合也算同一个人：手机号命中上一回来宾记录就复用那条；手机号没命中但同名，
   * 视为同一个人换了 / 改对了手机号，并到原来那条上，之前的得分跟着一起算。
   */
  async guestCheckin(token: string, input: { name?: string; phone?: string; gender?: string; pwdTicket?: string }) {
    const m = await this.byToken(token, input.pwdTicket);
    this.assertOpen(m);
    const name = (input.name ?? '').trim().slice(0, 30);
    const phone = this.normPhone(input.phone);
    const gender = this.normGender(input.gender);
    if (!name) throw new BadRequestException('请填写姓名');
    if (!PHONE_RE.test(phone)) throw new BadRequestException('请填写正确的手机号');
    // 姓名 + 手机号双匹配才算本人，避免只凭手机号认错人
    const matched = await this.matchRegistered(name, phone);
    const exists = await this.prisma.meetingGuest.findUnique({ where: { meetingId_phone: { meetingId: m.id, phone } } });
    let guest: { id: string };
    let merged = false;
    if (exists) {
      guest = await this.prisma.meetingGuest.update({
        where: { id: exists.id },
        // 没带性别时不要覆盖上次填的（旧客户端 / 重复签到）
        data: { name, gender: gender ?? exists.gender ?? null, userId: matched?.id ?? exists.userId ?? null },
      });
    } else {
      // 手机号没命中，但本场有同名记录：当作同一个人改对了手机号，并成一条
      const same = await this.sameNameGuests(m.id, name, matched?.id);
      if (same.length) {
        const keep = same[0];
        // 先把保留那条改成这次填的信息，再并其他同名记录（分数才能落在正确的归属上）
        guest = await this.prisma.meetingGuest.update({
          where: { id: keep.id },
          data: { name, phone, gender: gender ?? keep.gender ?? null, userId: matched?.id ?? null },
        });
        for (const dup of same.slice(1)) await this.mergeGuest(m.id, dup.id, { id: keep.id, userId: matched?.id ?? null });
        merged = true;
        this.logger.log(
          `扫码签到命中同名来宾，已并入原记录「${m.title}」keep=${keep.id} merged=${same.length - 1}`,
        );
      } else {
        guest = await this.prisma.meetingGuest.create({ data: { meetingId: m.id, name, phone, gender, userId: matched?.id ?? null } });
      }
    }
    if (matched) {
      // 之前以陌生人身份拿到的分数也归到本人名下，否则看板只算用户分数会漏掉
      await this.moveGuestScoresToUser(m.id, guest.id, matched.id);
      await this.linkRegistered(m, matched.id);
    }
    const score = await this.prisma.meetingScore.aggregate({
      where: matched
        ? { meetingId: m.id, userId: matched.id, status: 'APPROVED' }
        : { meetingId: m.id, guestId: guest.id, status: 'APPROVED' },
      _sum: { points: true },
    });
    this.logger.log(
      `扫码签到「${m.title}」name=${name} gender=${gender ?? '-'}${matched ? ` user=${matched.id}` : ` phone=${phone.slice(0, 3)}****${phone.slice(-2)}`}`,
    );
    return {
      ok: true,
      already: !!exists || merged,
      merged,
      guestId: guest.id,
      name,
      gender,
      points: score._sum.points ?? 0,
      linked: !!matched,
      userId: matched?.id ?? null,
      userName: matched?.name ?? null,
    };
  }

  /** 签到记录关联到注册用户后，把原来记在来宾身上的分数改记到用户名下 */
  private async moveGuestScoresToUser(meetingId: string, guestId: string, userId: string) {
    const r = await this.prisma.meetingScore.updateMany({
      where: { meetingId, guestId, userId: null },
      data: { guestId: null, userId },
    });
    if (r.count) this.logger.log(`签到关联注册用户，${r.count} 条加分已归到 user=${userId}`);
  }

  /**
   * 本场同名的来宾记录：手机号没命中时用来判断是不是同一个人。
   * 已经关联到别的注册用户的同名记录不参与（会场重名但确实两个人）。
   */
  private async sameNameGuests(meetingId: string, name: string, matchedUserId?: string) {
    const rows = await this.prisma.meetingGuest.findMany({
      where: { meetingId, name },
      orderBy: { createdAt: 'asc' },
      select: { id: true, userId: true, gender: true },
    });
    return rows.filter((r) => !r.userId || r.userId === matchedUserId);
  }

  /**
   * 扫码签到信息填错了：允许本人改姓名 / 手机号，改完重新做一次双匹配。
   * - 改对后命中注册用户：照旧视作本人参加（考勤 + 名册 + 站内信 + 分数归集）
   * - 改完不再命中：只解绑 userId，考勤不撤销（人确实到场了，只是登记名写错）
   * - 改成别人已用过的手机号：同名视为同一人重复签到，并成一条；不同名直接拦住
   */
  async guestUpdate(token: string, input: { guestId?: string; name?: string; phone?: string; gender?: string; pwdTicket?: string }) {
    const m = await this.byToken(token, input.pwdTicket);
    this.assertOpen(m);
    const guestId = (input.guestId ?? '').trim();
    if (!guestId) throw new BadRequestException('请先签到，再修改信息');
    const self = await this.prisma.meetingGuest.findFirst({ where: { id: guestId, meetingId: m.id } });
    if (!self) throw new NotFoundException('找不到你的签到记录，请重新签到');
    const name = (input.name ?? '').trim().slice(0, 30);
    const phone = this.normPhone(input.phone);
    // 没传性别就沿用原来那个，只有明确填了才改
    const gender = this.normGender(input.gender) ?? self.gender ?? null;
    if (!name) throw new BadRequestException('请填写姓名');
    if (!PHONE_RE.test(phone)) throw new BadRequestException('请填写正确的手机号');

    // 先算改完之后会不会命中注册用户，合并分数时才知道该归到哪里
    const matched = await this.matchRegistered(name, phone);
    let guestIdKeep = self.id;
    let merged = false;
    if (phone !== self.phone) {
      const other = await this.prisma.meetingGuest.findUnique({ where: { meetingId_phone: { meetingId: m.id, phone } } });
      if (other && other.id !== self.id) {
        if (other.name !== name) throw new BadRequestException('这个手机号已经有人签到过，请核对手机号是否填错');
        await this.prisma.meetingGuest.update({
          where: { id: other.id },
          data: { name, userId: matched?.id ?? null },
        });
        await this.mergeGuest(m.id, self.id, { id: other.id, userId: matched?.id ?? null });
        guestIdKeep = other.id;
        merged = true;
      }
    }

    const guest = await this.prisma.meetingGuest.update({
      where: { id: guestIdKeep },
      data: { name, phone, gender, userId: matched?.id ?? null },
    });
    if (matched) {
      // 之前以陌生人身份拿到的分数也归到本人名下
      await this.moveGuestScoresToUser(m.id, guest.id, matched.id);
      await this.linkRegistered(m, matched.id);
    } else if (self.userId) this.logger.log(`签到信息修改后不再匹配注册用户，已解绑 meeting=${m.id} guest=${guest.id} old=${self.userId}`);

    const score = await this.prisma.meetingScore.aggregate({
      where: matched
        ? { meetingId: m.id, userId: matched.id, status: 'APPROVED' }
        : { meetingId: m.id, guestId: guest.id, status: 'APPROVED' },
      _sum: { points: true },
    });
    this.logger.log(`签到信息已修改「${m.title}」guest=${guest.id} name=${name} gender=${gender ?? '-'}${matched ? ` user=${matched.id}` : ''}${merged ? ' (merged)' : ''}`);
    return {
      ok: true,
      guestId: guest.id,
      name,
      phone,
      gender,
      merged,
      points: score._sum.points ?? 0,
      linked: !!matched,
      userId: matched?.id ?? null,
      userName: matched?.name ?? null,
    };
  }

  /** 同一个人用两个手机号签到了两次：分数、小组成员、组长身份都迁到保留的那条上 */
  private async mergeGuest(meetingId: string, dropId: string, keep: { id: string; userId: string | null }) {
    await this.prisma.meetingScore.updateMany({
      where: { meetingId, guestId: dropId },
      data: keep.userId ? { guestId: null, userId: keep.userId } : { guestId: keep.id },
    });
    // 小组关系：一个人只能在一个组里，保留那条已经有组就丢掉重复的组关系，没组才把它挪过去
    const memberships = await this.prisma.meetingGroupMember.findMany({ where: { guestId: dropId }, select: { id: true, groupId: true } });
    const keepHasGroup = memberships.length
      ? !!(await this.prisma.meetingGroupMember.findFirst({ where: { guestId: keep.id }, select: { id: true } }))
      : false;
    for (const mb of memberships) {
      if (keepHasGroup) {
        await this.prisma.meetingGroupMember.delete({ where: { id: mb.id } });
        continue;
      }
      const dup = await this.prisma.meetingGroupMember.findFirst({ where: { groupId: mb.groupId, guestId: keep.id }, select: { id: true } });
      if (dup) await this.prisma.meetingGroupMember.delete({ where: { id: mb.id } });
      else await this.prisma.meetingGroupMember.update({ where: { id: mb.id }, data: { guestId: keep.id } });
    }
    await this.prisma.meetingGroup.updateMany({ where: { meetingId, leaderGuestId: dropId }, data: { leaderGuestId: keep.id } });
    await this.prisma.meetingGuest.delete({ where: { id: dropId } });
    this.logger.log(`签到记录已合并 meeting=${meetingId} drop=${dropId} keep=${keep.id}`);
  }

  /** 签到关联注册用户：考勤 + 参会名册 + 站内信（全部幂等，重复扫码只提醒一次） */
  private async linkRegistered(m: { id: string; title: string; participantIds: string[] }, userId: string) {
    const attended = await this.prisma.meetingAttendance.findUnique({
      where: { meetingId_userId: { meetingId: m.id, userId } },
      select: { id: true },
    });
    await this.prisma.meetingAttendance.upsert({
      where: { meetingId_userId: { meetingId: m.id, userId } },
      create: { meetingId: m.id, userId, method: 'SELF' },
      update: {},
    });
    if (!(m.participantIds ?? []).includes(userId)) {
      await this.prisma.meeting.update({
        where: { id: m.id },
        data: { participantIds: Array.from(new Set([...(m.participantIds ?? []), userId])) },
      });
    }
    if (attended) return; // 这场已经记过参加记录了，不重复推送提醒
    try {
      await this.notifications.createMany([userId], {
        type: NotificationType.MEETING,
        title: `活动签到成功：《${m.title}》`,
        content: '已识别为注册用户，本次参加已计入你的会议活动记录',
        link: `/meetings/${m.id}`,
      });
    } catch (e) {
      this.logger.warn(`签到关联站内信发送失败 user=${userId}: ${(e as Error).message}`);
    }
  }

  /** 陌生人答题正确 → 提交加分申请（待组织者/助教审批） */
  async guestQuiz(token: string, input: { phone?: string; answer?: string; reason?: string; pwdTicket?: string }) {
    const m = await this.byToken(token, input.pwdTicket);
    this.assertOpen(m);
    const question = (m.quizQuestion ?? '').trim();
    if (!question || !(m.quizAnswer ?? '').trim()) throw new BadRequestException('本场活动没有开放答题加分');
    const phone = this.normPhone(input.phone);
    if (!PHONE_RE.test(phone)) throw new BadRequestException('请先填写手机号再答题');
    const guest = await this.prisma.meetingGuest.findUnique({ where: { meetingId_phone: { meetingId: m.id, phone } } });
    if (!guest) throw new BadRequestException('请先签到，再答题加分');
    const answer = (input.answer ?? '').trim();
    if (!answer) throw new BadRequestException('请填写答案');
    if (this.squash(answer) !== this.squash(m.quizAnswer ?? '')) {
      this.logger.log(`答题不正确 meeting=${m.id} guest=${guest.id}`);
      throw new BadRequestException('答案不正确，再想想？');
    }
    // 已关联注册用户的来宾，加分记到用户名下
    const targetUserId = guest.userId ?? null;
    const target = targetUserId ? { userId: targetUserId } : { guestId: guest.id };
    const pending = await this.prisma.meetingScore.count({ where: { meetingId: m.id, ...target, source: 'QUIZ', status: 'PENDING' } });
    if (pending) throw new BadRequestException('你的答题加分已提交，正在等待活动组织者审批');
    const reason = (input.reason ?? '').trim().slice(0, 200) || '答题正确';
    const row = await this.prisma.meetingScore.create({
      data: { meetingId: m.id, ...target, points: m.quizPoints, reason, source: 'QUIZ', status: 'PENDING' },
    });
    return { ok: true, id: row.id, name: guest.name, points: row.points, status: row.status };
  }

  // ============ 来宾自助组队（免登录：token + guestId 认人） ============

  /**
   * 扫码签到的来宾自己拉小组：谁先起了组名谁当组长，旁边的人点「加入」就进组，
   * 一人只能在一个组里。不需要账号，带上签到时返回的 guestId 就是本人。
   */
  async guestGroupCreate(token: string, input: { guestId?: string; name?: string; pwdTicket?: string }) {
    const { m, guest } = await this.guestOf(token, input.guestId, input.pwdTicket);
    const name = (input.name ?? '').trim().slice(0, 20);
    if (!name) throw new BadRequestException('请给小组起个名字');
    const dup = await this.prisma.meetingGroup.findUnique({ where: { meetingId_name: { meetingId: m.id, name } } });
    if (dup) throw new BadRequestException('组名已被占用，换一个吧');
    await this.dropGuestFromGroups(m.id, guest.id);
    const g = await this.prisma.meetingGroup.create({
      data: { meetingId: m.id, name, leaderGuestId: guest.id, members: { create: [{ guestId: guest.id }] } },
    });
    this.logger.log(`来宾自助建组「${m.title}」group=${g.id} name=${name} guest=${guest.id}`);
    return { ok: true, groupId: g.id, name: g.name };
  }

  /** 加入某个小组：自动从原来的组退出 */
  async guestGroupJoin(token: string, input: { guestId?: string; groupId?: string; pwdTicket?: string }) {
    const { m, guest } = await this.guestOf(token, input.guestId, input.pwdTicket);
    const g = await this.groupOf(m.id, input.groupId);
    const already = await this.prisma.meetingGroupMember.findFirst({ where: { groupId: g.id, guestId: guest.id }, select: { id: true } });
    if (already) return { ok: true, groupId: g.id, name: g.name };
    await this.dropGuestFromGroups(m.id, guest.id);
    await this.prisma.meetingGroupMember.create({ data: { groupId: g.id, guestId: guest.id } });
    this.logger.log(`来宾加入小组「${m.title}」group=${g.id} guest=${guest.id}`);
    return { ok: true, groupId: g.id, name: g.name };
  }

  /**
   * 来宾拖自己的头像入组：只认签到时拿到的 guestId，只能拖动自己
   * - 拖到某个小组上 = 加入这个组（自动从原来的组退出，原组空了就收掉）
   * - 拖到「新建小组」上 = 自己当组长建一个组，没起名字就按「第 N 组」顺延
   */
  async guestGroupAssign(
    token: string,
    input: { guestId?: string; groupId?: string; name?: string; pwdTicket?: string },
  ) {
    const { m, guest } = await this.guestOf(token, input.guestId, input.pwdTicket);
    const groupId = (input.groupId ?? '').trim();

    // 拖到新建区：以自己新建一个组，自己当组长
    if (!groupId) {
      const name = await this.freeGroupName(m.id, input.name);
      await this.dropPerson(m.id, guest.userId ?? null, guest.id);
      const g = await this.prisma.meetingGroup.create({
        data: { meetingId: m.id, name, leaderGuestId: guest.id, members: { create: [{ guestId: guest.id }] } },
      });
      this.logger.log(`来宾拖头像新建小组「${m.title}」group=${g.id} name=${name} guest=${guest.id}`);
      return { ok: true, groupId: g.id, name: g.name, memberName: guest.name };
    }

    const g = await this.groupOf(m.id, groupId);
    const already = await this.prisma.meetingGroupMember.findFirst({
      where: { groupId: g.id, guestId: guest.id },
      select: { id: true },
    });
    if (already) return { ok: true, groupId: g.id, name: g.name, memberName: guest.name }; // 重复拖进来不报错
    await this.dropPerson(m.id, guest.userId ?? null, guest.id);
    await this.prisma.meetingGroupMember.create({ data: { groupId: g.id, guestId: guest.id } });
    // 组里原本没组长时，进来的人顺手当组长，避免留下无主组
    if (!g.leaderId && !g.leaderGuestId) {
      await this.prisma.meetingGroup.update({ where: { id: g.id }, data: { leaderGuestId: guest.id } });
    }
    this.logger.log(`来宾拖头像入组「${m.title}」group=${g.id} name=${g.name} guest=${guest.id}`);
    return { ok: true, groupId: g.id, name: g.name, memberName: guest.name };
  }

  /** 退出小组：自己走了，组长位清空让组里重新选 */
  async guestGroupLeave(token: string, input: { guestId?: string; groupId?: string; pwdTicket?: string }) {
    const { m, guest } = await this.guestOf(token, input.guestId, input.pwdTicket);
    const g = await this.groupOf(m.id, input.groupId);
    // 注册账号 + 签到记录两个身份一起摘（否则组织者先前把 TA 分进过别的组，会留在原组里）
    await this.dropPerson(m.id, guest.userId ?? null, guest.id);
    // 最后一个人退了，空组直接收掉，不在座位图上留空壳
    await this.dropEmptyGroup(g.id);
    this.logger.log(`来宾退出小组「${m.title}」group=${g.id} guest=${guest.id}`);
    return { ok: true, name: guest.name };
  }

  /** 改组名 / 选组长 / 摆座位：组内的人都能改自己的组 */
  async guestGroupUpdate(
    token: string,
    input: { guestId?: string; groupId?: string; name?: string; leaderGuestId?: string | null; seatRow?: number; seatCol?: number; pwdTicket?: string },
  ) {
    const { m, guest } = await this.guestOf(token, input.guestId, input.pwdTicket);
    const g = await this.groupOf(m.id, input.groupId);
    const members = await this.prisma.meetingGroupMember.findMany({ where: { groupId: g.id }, select: { guestId: true } });
    if (!members.some((x) => x.guestId === guest.id)) throw new ForbiddenException('只有组内成员可以修改这个小组');
    const data: Record<string, unknown> = {};
    if (input.name !== undefined) {
      const name = (input.name ?? '').trim().slice(0, 20);
      if (!name) throw new BadRequestException('组名不能为空');
      if (name !== g.name) {
        const dup = await this.prisma.meetingGroup.findUnique({ where: { meetingId_name: { meetingId: m.id, name } } });
        if (dup) throw new BadRequestException('组名已被占用，换一个吧');
      }
      data.name = name;
    }
    if (input.leaderGuestId !== undefined) {
      const id = (input.leaderGuestId ?? '').trim();
      if (id && !members.some((x) => x.guestId === id)) throw new BadRequestException('组长必须是本组成员');
      data.leaderGuestId = id || null;
    }
    // 会场座位图：把自己所在的小组拖到大致真实的位置
    if (input.seatRow !== undefined) data.seatRow = this.normSeat(input.seatRow);
    if (input.seatCol !== undefined) data.seatCol = this.normSeat(input.seatCol);
    if (!Object.keys(data).length) return { ok: true };
    await this.prisma.meetingGroup.update({ where: { id: g.id }, data });
    return { ok: true };
  }

  /** 解散小组：只有组长自己能解散（组织者在管理面板里另有一处） */
  async guestGroupRemove(token: string, input: { guestId?: string; groupId?: string; pwdTicket?: string }) {
    const { m, guest } = await this.guestOf(token, input.guestId, input.pwdTicket);
    const g = await this.groupOf(m.id, input.groupId);
    if (g.leaderGuestId !== guest.id) throw new ForbiddenException('只有组长可以解散这个小组');
    await this.prisma.meetingGroup.delete({ where: { id: g.id } });
    this.logger.log(`来宾解散小组「${m.title}」group=${g.id}`);
    return { ok: true };
  }

  /** token + guestId 认人：扫过码的来宾就能组队，不需要账号（设了密码时还要带有效票据） */
  private async guestOf(token: string, guestId?: string, ticket?: string) {
    const m = await this.byToken(token, ticket);
    this.assertOpen(m);
    const id = (guestId ?? '').trim();
    if (!id) throw new BadRequestException('请先签到，再组队');
    const guest = await this.prisma.meetingGuest.findFirst({ where: { id, meetingId: m.id } });
    if (!guest) throw new NotFoundException('找不到你的签到记录，请重新签到');
    return { m, guest };
  }

  private async groupOf(meetingId: string, groupId?: string) {
    const id = (groupId ?? '').trim();
    if (!id) throw new BadRequestException('请选择一个小组');
    const g = await this.prisma.meetingGroup.findFirst({ where: { id, meetingId } });
    if (!g) throw new NotFoundException('小组不存在');
    return g;
  }

  /** 一人一组：建组 / 入组前先把自己从本场其它组里摘掉，顺带清空原来当的组长位 */
  private async dropGuestFromGroups(meetingId: string, guestId: string) {
    const groupIds = (await this.prisma.meetingGroup.findMany({ where: { meetingId }, select: { id: true } })).map((x) => x.id);
    if (!groupIds.length) return;
    const mine = await this.prisma.meetingGroupMember.findMany({
      where: { guestId, groupId: { in: groupIds } },
      select: { groupId: true },
    });
    if (!mine.length) return;
    await this.prisma.meetingGroupMember.deleteMany({ where: { guestId, groupId: { in: groupIds } } });
    await this.prisma.meetingGroup.updateMany({ where: { meetingId, leaderGuestId: guestId }, data: { leaderGuestId: null } });
    // 离开后如果原来那个组空了，直接收掉
    for (const gid of new Set(mine.map((x) => x.groupId))) await this.dropEmptyGroup(gid);
  }

  /** 组里一个人都不剩了就删掉这个组，避免座位图上留一个没人也解散不了的壳 */
  private async dropEmptyGroup(groupId: string) {
    const left = await this.prisma.meetingGroupMember.count({ where: { groupId } });
    if (left) return false;
    await this.prisma.meetingGroup.delete({ where: { id: groupId } }).catch(() => undefined);
    return true;
  }

  // ============ 内部实现 ============

  /** 管理层：发起人 / 管理员 / 本场助教 */
  private isManager(m: { ownerId: string; assistantIds: string[] }, me: MeetingActor) {
    return m.ownerId === me.id || hasAtLeast(me.role, Role.ADMIN) || (m.assistantIds ?? []).includes(me.id);
  }

  private assertManager(m: { ownerId: string; assistantIds: string[] }, me: MeetingActor) {
    if (!this.isManager(m, me)) throw new ForbiddenException('仅活动发起人、管理员或本场助教可操作');
  }

  /** 参会人（含发起人）才能分组 */
  private assertParticipant(m: { ownerId: string; participantIds: string[] }, me: MeetingActor) {
    if (m.ownerId === me.id || (m.participantIds ?? []).includes(me.id)) return;
    throw new ForbiddenException('只有本场活动的参会人员可以分组');
  }

  /** 已取消/草稿的活动不对外收签到与答题 */
  private assertOpen(m: { status: string }) {
    if (m.status === 'CANCELLED') throw new BadRequestException('活动已取消');
    if (m.status === 'DRAFT') throw new BadRequestException('活动尚未发布');
  }

  private normPoints(v: unknown) {
    const n = Number(v);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > MAX_SCORE) {
      throw new BadRequestException(`加分数请填 1~${MAX_SCORE} 之间的整数`);
    }
    return n;
  }

  /** 座位图坐标：-1 为未摆放，其余限定在一张合理大小的会场里 */
  private normSeat(v: unknown) {
    const n = Number(v);
    if (!Number.isInteger(n) || n < -1 || n > 49) throw new BadRequestException('座位坐标不合法');
    return n;
  }

  private normPhone(v: unknown) {
    return String(v ?? '').replace(/[\s-]/g, '');
  }

  /** 性别只认二选一（男 / 女），其它写法一律当没填 */
  private normGender(v: unknown): 'MALE' | 'FEMALE' | null {
    const g = String(v ?? '').trim().toUpperCase();
    if (g === 'MALE' || g === 'M' || g === '男') return 'MALE';
    if (g === 'FEMALE' || g === 'F' || g === '女') return 'FEMALE';
    return null;
  }

  /**
   * 同一个人的两种身份：注册账号 userId 与本场扫码签到记录 guestId。
   * 摘组成员时必须两个身份一起摘，否则组织者拖“同事头像”入组时，
   * TA 自己扫码建的那组还留着，一个人在座位图上出现两次。
   */
  private async identities(meetingId: string, userId: string | null, guestId: string | null) {
    let uid = userId;
    let gid = guestId;
    if (uid && !gid) gid = (await this.prisma.meetingGuest.findFirst({ where: { meetingId, userId: uid }, select: { id: true } }))?.id ?? null;
    if (gid && !uid) uid = (await this.prisma.meetingGuest.findFirst({ where: { id: gid }, select: { userId: true } }))?.userId ?? null;
    return { uid, gid };
  }

  /** 把这个人从本场所有小组里摘干净（两种身份都摘，原组空了就收掉） */
  private async dropPerson(meetingId: string, userId: string | null, guestId: string | null) {
    const { uid, gid } = await this.identities(meetingId, userId, guestId);
    if (gid) await this.dropGuestFromGroups(meetingId, gid);
    if (uid) await this.dropUserFromGroups(meetingId, uid);
    return { uid, gid };
  }

  /** 答案比对宽松口径：忽略空格、全半角与大小写 */
  private squash(v: string) {
    return String(v ?? '')
      .replace(/\s+/g, '')
      .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
      .toLowerCase();
  }

  /** 姓名 + 手机号双匹配注册用户：两项都对才算同一个人 */
  private matchRegistered(name: string, phone: string) {
    return this.prisma.user.findFirst({ where: { phone, name, active: true }, select: { id: true, name: true } });
  }

  /** 手机号脱敏：对陌生人展示他人手机号只留头 3 尾 2 */
  private maskPhone(phone: string) {
    const p = String(phone ?? '');
    return p.length >= 7 ? `${p.slice(0, 3)}****${p.slice(-2)}` : '****';
  }

  private async buildBoard(
    m: Awaited<ReturnType<MeetingService['mustFind']>>,
    opts: { internal: boolean; me?: MeetingActor },
  ) {
    const [guests, scores, groups, attendances, users, owner] = await Promise.all([
      this.prisma.meetingGuest.findMany({
        where: { meetingId: m.id },
        orderBy: { createdAt: 'asc' },
        include: { user: { select: { id: true, name: true } } },
      }),
      this.prisma.meetingScore.findMany({
        where: { meetingId: m.id },
        orderBy: { createdAt: 'desc' },
        include: {
          user: { select: { id: true, name: true } },
          guest: { select: { id: true, name: true } },
          createdBy: { select: { name: true } },
          approvedBy: { select: { name: true } },
        },
      }),
      this.prisma.meetingGroup.findMany({
        where: { meetingId: m.id },
        orderBy: { createdAt: 'asc' },
        include: {
          members: {
            orderBy: { joinedAt: 'asc' },
            include: { user: { select: { id: true, name: true, department: { select: { name: true } } } }, guest: { select: { id: true, name: true, userId: true, gender: true } } },
          },
        },
      }),
      this.prisma.meetingAttendance.findMany({ where: { meetingId: m.id }, select: { userId: true } }),
      this.prisma.user.findMany({
        where: { id: { in: Array.from(new Set([m.ownerId, ...(m.participantIds ?? [])])) } },
        select: { id: true, name: true, department: { select: { name: true } } },
      }),
      this.prisma.user.findUnique({ where: { id: m.ownerId }, select: { id: true, name: true } }),
    ]);

    const checkedSet = new Set(attendances.map((a) => a.userId));
    // 扫码签到记录按注册用户归集：参会人头像也能拿到性别（浅蓝 / 浅粉）
    const guestByUser = new Map<string, { id: string; gender: string | null }>();
    for (const g of guests) if (g.userId) guestByUser.set(g.userId, { id: g.id, gender: g.gender ?? null });
    const userPoints = new Map<string, number>();
    const guestPoints = new Map<string, number>();
    for (const s of scores) {
      if (s.status !== 'APPROVED') continue;
      if (s.userId) userPoints.set(s.userId, (userPoints.get(s.userId) ?? 0) + s.points);
      if (s.guestId) guestPoints.set(s.guestId, (guestPoints.get(s.guestId) ?? 0) + s.points);
    }

    const participantRows = users.map((u) => ({
      key: `u:${u.id}`,
      name: u.name,
      userId: u.id,
      // 这个人本场也扫过码：带上签到记录的 guestId，前端才能认出“这就是我”
      guestId: guestByUser.get(u.id)?.id ?? null,
      departmentName: u.department?.name ?? null,
      kind: 'USER' as const,
      gender: guestByUser.get(u.id)?.gender ?? null,
      isOwner: u.id === m.ownerId,
      isAssistant: (m.assistantIds ?? []).includes(u.id),
      checked: checkedSet.has(u.id),
      points: userPoints.get(u.id) ?? 0,
    }));
    // 发起人排最前，其余按得分高低
    participantRows.sort((a, b) => Number(b.isOwner) - Number(a.isOwner) || b.points - a.points || a.name.localeCompare(b.name));

    const guestRows = guests.map((g) => ({
      key: `g:${g.id}`,
      name: g.name,
      userId: null as string | null,
      guestId: g.id,
      departmentName: null as string | null,
      kind: 'GUEST' as const,
      gender: g.gender ?? null,
      isOwner: false,
      isAssistant: false,
      checked: true,
      phone: opts.internal ? g.phone : this.maskPhone(g.phone),
      // 已关联注册用户：姓名标签改用实名，分数归到用户
      linkedUserId: g.userId ?? null,
      linkedName: g.user?.name ?? null,
      points: (g.userId ? userPoints.get(g.userId) ?? 0 : 0) + (guestPoints.get(g.id) ?? 0),
    }));
    guestRows.sort((a, b) => b.points - a.points || a.name.localeCompare(b.name));

    const groupRows = groups.map((g) => {
      const members = g.members
        .map((x) => {
          const name = x.user?.name ?? x.guest?.name ?? '已注销';
          // 成员是来宾但已经关联了注册用户：分数记在用户名下，两边都算上不会重复
          const ownerUserId = x.userId ?? x.guest?.userId ?? null;
          const points =
            (ownerUserId ? userPoints.get(ownerUserId) ?? 0 : 0) + (x.guestId ? guestPoints.get(x.guestId) ?? 0 : 0);
          const leader = x.userId ? g.leaderId === x.userId : g.leaderGuestId === x.guestId;
          return {
            userId: x.userId,
            guestId: x.guestId,
            name,
            departmentName: x.user?.department?.name ?? null,
            // 性别：签到记录上填的；组员是注册账号但本场也扫过码时从那条记录里取
            gender: x.guest?.gender ?? (x.userId ? guestByUser.get(x.userId)?.gender ?? null : null),
            points,
            isLeader: leader,
          };
        })
        .sort((a, b) => Number(b.isLeader) - Number(a.isLeader) || b.points - a.points);
      return {
        id: g.id,
        name: g.name,
        seatRow: g.seatRow,
        seatCol: g.seatCol,
        createdById: g.createdById,
        leaderId: g.leaderId,
        leaderName: members.find((x) => x.isLeader)?.name ?? null,
        memberCount: members.length,
        score: members.reduce((sum, x) => sum + x.points, 0),
        members,
      };
    });
    groupRows.sort((a, b) => b.score - a.score || b.memberCount - a.memberCount || a.name.localeCompare(b.name));

    const pendingRows = scores
      .filter((s) => s.status === 'PENDING')
      .map((s) => ({
        id: s.id,
        name: s.user?.name ?? s.guest?.name ?? '未知',
        guestId: s.guestId,
        userId: s.userId,
        points: s.points,
        reason: s.reason,
        source: s.source,
        createdAt: s.createdAt,
        approvedBy: null as string | null,
      }));

    const recentRows = scores
      .filter((s) => s.status === 'APPROVED')
      .slice(0, 20)
      .map((s) => ({
        id: s.id,
        name: s.user?.name ?? s.guest?.name ?? '未知',
        points: s.points,
        reason: s.reason,
        source: s.source,
        approvedByName: s.approvedBy?.name ?? s.createdBy?.name ?? null,
        createdAt: s.approvedAt ?? s.createdAt,
      }));

    const scoreTotal = Array.from(userPoints.values()).reduce((a, b) => a + b, 0) + Array.from(guestPoints.values()).reduce((a, b) => a + b, 0);
    // 已关联注册用户的来宾不再计入「外部来宾」，避免同一个人算两次
    const externalGuests = guestRows.filter((g) => !g.linkedUserId);
    const me = opts.me;
    const quizQuestion = (m.quizQuestion ?? '').trim();

    return {
      meeting: {
        id: m.id,
        title: m.title,
        type: m.type,
        important: m.importance,
        status: m.status,
        startAt: m.startAt,
        endAt: m.endAt,
        location: m.location,
        ownerName: owner?.name ?? '',
        ownerId: m.ownerId,
        cancelledReason: m.cancelledReason,
      },
      token: m.publicToken,
      /** 发起人是否设了访问密码（仅布尔标志，不回传 hash）：管理面板展示开关状态 */
      passwordProtected: !!m.publicPassword,
      quiz: {
        enabled: !!quizQuestion && !!(m.quizAnswer ?? '').trim(),
        question: quizQuestion || null,
        points: m.quizPoints,
        answer: opts.internal ? m.quizAnswer : undefined,
      },
      assistants: participantRows.filter((p) => p.isAssistant).map((p) => ({ userId: p.userId, name: p.name })),
      participants: participantRows,
      guests: guestRows,
      groups: groupRows,
      pending: opts.internal ? pendingRows : [],
      recent: recentRows,
      stats: {
        participantCount: participantRows.length,
        guestCount: externalGuests.length,
        checkedCount: checkedSet.size + externalGuests.length,
        groupCount: groupRows.length,
        scoreTotal,
      },
      permissions: opts.internal && me
        ? {
            canManage: this.isManager(m, me),
            isOwner: m.ownerId === me.id,
            isAssistant: (m.assistantIds ?? []).includes(me.id),
            canGroup: m.ownerId === me.id || (m.participantIds ?? []).includes(me.id),
          }
        : null,
    };
  }
}
