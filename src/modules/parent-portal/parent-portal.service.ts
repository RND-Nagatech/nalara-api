import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { ClientSession } from 'mongoose';
import type { Principal } from '../../common/api';
import type { LearningPlan, LessonReport, LessonSession, PortalAccount, RescheduleRequest, Target } from '../../database/entities';
import { Database } from '../../database/database.module';
import { ListQuery } from '../../common/query.dto';
import { ParentAvailabilityDto, ParentDashboardQuery, ParentRescheduleDto, RescheduleAvailabilityQuery, RespondRescheduleDto, ReviewRescheduleDto } from './parent-portal.dto';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { StudentSummaryService } from '../students/student-summary.service';
import { StudentListProgressService } from '../students/student-list-progress.service';
import { studentSummaryWindow } from '../students/student-summary.rules';
import { aggregateProgress, progressFromTotals } from '../learning-plans/progress.rules';
import { dashboardDayWindow, dashboardPreviewLimit } from '../dashboard/dashboard.rules';
import { parentFamily, parentStudent } from './parent-portal.views';
import { NotificationEventsService } from '../notifications/notification-events.service';
import { lockCalendar } from '../../common/calendar-lock';

type FamilyAccount = Pick<PortalAccount, '_id' | 'workspaceId' | 'familyId' | 'role'>;
// Read parent-only records as well as the current teaching schema's shared
// records without widening any teacher write DTO or shared collection type.
const parentVisibility: Record<string, unknown> = { visibility: { $in: ['shared', 'parent'] } };

@Injectable()
export class ParentPortalService {
  constructor(
    private readonly db: Database,
    private readonly subscriptions: SubscriptionsService,
    private readonly summary: StudentSummaryService,
    private readonly listProgress: StudentListProgressService,
    private readonly notificationsEvents: NotificationEventsService,
  ) {}

  private async family(account: FamilyAccount) {
    if (account.role !== 'parent' || !account.familyId) throw new NotFoundException('Data keluarga tidak tersedia');
    const family = await this.db.collection('families').findOne({ _id: account.familyId, workspaceId: account.workspaceId }).lean();
    if (!family) throw new NotFoundException('Data keluarga tidak tersedia');
    return family;
  }

  private async children(account: FamilyAccount, status?: 'active' | 'archived') {
    const family = await this.family(account);
    return this.db.collection('students').find({ workspaceId: account.workspaceId, familyId: family._id, ...(status ? { status } : {}) }).sort({ name: 1 }).lean();
  }

  private async child(account: FamilyAccount, id: string) {
    const family = await this.family(account);
    const student = await this.db.collection('students').findOne({ _id: id, workspaceId: account.workspaceId, familyId: family._id }).lean();
    if (!student) throw new NotFoundException('Siswa tidak terhubung ke keluarga ini');
    return student;
  }

  private async timezone(workspaceId: string) {
    const owner = await this.db.collection('users').findOne({ workspaceId }).select('timezone').lean();
    return owner?.timezone ?? 'Asia/Jakarta';
  }

  private async names<T extends { studentId: string; subjectId?: string }>(workspaceId: string, rows: readonly T[]) {
    const [students, subjects] = await Promise.all([
      this.db.collection('students').find({ workspaceId, _id: { $in: rows.map((row) => row.studentId) } }).select('_id name grade status').lean(),
      this.db.collection('subjects').find({ workspaceId, _id: { $in: rows.map((row) => row.subjectId).filter((id): id is string => Boolean(id)) } }).select('_id name').lean(),
    ]);
    const studentMap = new Map(students.map((student) => [student._id, student]));
    const subjectMap = new Map(subjects.map((subject) => [subject._id, subject.name]));
    return rows.map((row) => ({ ...row, studentName: studentMap.get(row.studentId)?.name ?? '', studentGrade: studentMap.get(row.studentId)?.grade ?? '', studentStatus: studentMap.get(row.studentId)?.status, subjectName: subjectMap.get(row.subjectId ?? '') ?? '' }));
  }

  private async namedReports(workspaceId: string, reports: readonly LessonReport[]) {
    // Reports store a sessionId rather than a subjectId. Resolve only matching
    // workspace/student sessions before enriching the public report fields.
    const sessions = await this.db.collection('sessions').find({ workspaceId, _id: { $in: reports.map((report) => report.sessionId) }, studentId: { $in: reports.map((report) => report.studentId) } }).select('_id studentId subjectId').lean();
    const sessionMap = new Map(sessions.map((session) => [session._id, session]));
    return this.names(workspaceId, reports.map((report) => {
      const session = sessionMap.get(report.sessionId);
      return { ...report, subjectId: session?.studentId === report.studentId ? session.subjectId : undefined };
    }));
  }

  private async planWithTargets(account: FamilyAccount, plan: LearningPlan) {
    const targets = await this.db.collection('targets').find({ workspaceId: account.workspaceId, planId: plan._id, studentId: plan.studentId, subjectId: plan.subjectId }).sort({ createdAt: 1, _id: 1 }).lean();
    const [named] = await this.names(account.workspaceId, [{ studentId: plan.studentId, subjectId: plan.subjectId }]);
    return { ...plan, targets, ...aggregateProgress(targets), studentName: named.studentName, studentGrade: named.studentGrade, studentStatus: named.studentStatus, subjectName: named.subjectName };
  }

  private async targetItems(account: FamilyAccount, targets: readonly Target[]) {
    const plans = await this.db.collection('plans').find({ workspaceId: account.workspaceId, _id: { $in: targets.map((target) => target.planId) }, studentId: { $in: targets.map((target) => target.studentId) } }).lean();
    const planMap = new Map(plans.map((plan) => [plan._id, plan]));
    return (await this.names(account.workspaceId, targets)).flatMap((target) => {
      const plan = planMap.get(target.planId);
      if (!plan || plan.studentId !== target.studentId || plan.subjectId !== target.subjectId) return [];
      return [{ ...target, planTitle: plan.title, startAt: plan.startAt, endAt: plan.endAt }];
    });
  }

  private async weeklyProgress(workspaceId: string, studentIds: string[], from: Date, to: Date) {
    const [totals] = await this.db.collection('targets').aggregate<{ sum: number; count: number }>([
      { $match: { workspaceId, studentId: { $in: studentIds }, status: { $nin: ['archived', 'cancelled'] } } },
      { $lookup: { from: this.db.collection('plans').collection.name, let: { planId: '$planId', studentId: '$studentId', subjectId: '$subjectId' }, pipeline: [
        { $match: { workspaceId, startAt: { $lt: to }, endAt: { $gte: from }, $expr: { $and: [{ $eq: ['$_id', '$$planId'] }, { $eq: ['$studentId', '$$studentId'] }, { $eq: ['$subjectId', '$$subjectId'] }] } } },
        { $project: { _id: 1 } },
      ], as: 'plan' } },
      { $match: { 'plan.0': { $exists: true } } },
      { $group: { _id: null, count: { $sum: 1 }, sum: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 100, '$progress'] } } } },
    ]).readConcern('snapshot').option({ maxTimeMS: 10000 });
    return progressFromTotals(totals?.sum ?? 0, totals?.count ?? 0);
  }

  async profile(account: FamilyAccount) {
    const family = await this.family(account);
    const students = await this.children(account);
    return { role: 'parent', name: family.parentName, phone: family.parentPhone, familyName: family.name, familyId: family._id, students: students.map(parentStudent) };
  }

  async dashboard(account: FamilyAccount, query: ParentDashboardQuery = {}) {
    const family = await this.family(account);
    const students = await this.children(account);
    const selected = query.studentId ? [await this.child(account, query.studentId)] : students;
    const timezone = await this.timezone(account.workspaceId);
    const now = new Date();
    const { from, to, localDate } = dashboardDayWindow(now, timezone);
    const { weekStart, weekEnd } = studentSummaryWindow(now, timezone);
    const studentIds = selected.map((student) => student._id);
    const scope = { workspaceId: account.workspaceId, studentId: { $in: studentIds } };
    const today = { ...scope, startAt: { $gte: from, $lt: to }, status: { $ne: 'cancelled' as const } };
    const sharedReports = { ...scope, ...parentVisibility, status: 'published' as const };
    const attention = { ...scope, status: 'active' as const, progress: { $lt: 50 } };
    const [sessionsToday, sessions, reports, latestReports, attentionTargets, targets, unreadNotifications, weeklyProgress] = await Promise.all([
      this.db.collection('sessions').countDocuments(today),
      this.db.collection('sessions').find(today).sort({ startAt: 1, _id: 1 }).limit(dashboardPreviewLimit).lean(),
      this.db.collection('reports').countDocuments(sharedReports),
      this.db.collection('reports').find(sharedReports).sort({ publishedAt: -1, createdAt: -1, _id: -1 }).limit(3).lean(),
      this.db.collection('targets').countDocuments(attention),
      this.db.collection('targets').find(attention).sort({ progress: 1, updatedAt: -1, _id: 1 }).limit(3).lean(),
      this.notificationScope(account).then((filter) => this.db.collection('notifications').countDocuments({ ...filter, readAt: { $exists: false } })),
      this.weeklyProgress(account.workspaceId, studentIds, weekStart, weekEnd),
    ]);
    return {
      generatedAt: now, timezone, localDate, dayStart: from, dayEnd: to, studentId: query.studentId ?? null,
      parent: { name: family.parentName, phone: family.parentPhone, familyName: family.name },
      children: students.map(parentStudent), childrenCount: students.length,
      sessionsToday, newReports: reports, attentionTargets, unreadNotifications, weeklyProgress,
      todaySessions: await this.names(account.workspaceId, sessions),
      latestReports: await this.namedReports(account.workspaceId, latestReports),
      attentionTargetItems: await this.targetItems(account, targets),
    };
  }

  async students(account: FamilyAccount, query: ListQuery) {
    const family = await this.family(account);
    const filter: Record<string, unknown> = { workspaceId: account.workspaceId, familyId: family._id };
    if (query.status) filter.status = query.status;
    if (query.search) filter.name = { $regex: query.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
    const [items, total] = await Promise.all([
      this.db.collection('students').find(filter).sort({ name: 1 }).skip((query.page - 1) * query.limit).limit(query.limit).lean(),
      this.db.collection('students').countDocuments(filter),
    ]);
    const timezone = await this.timezone(account.workspaceId);
    return { items: await this.listProgress.enrich({ workspaceId: account.workspaceId, timezone }, items.map(parentStudent)), total, page: query.page, limit: query.limit };
  }

  async student(account: FamilyAccount, id: string) {
    const student = await this.child(account, id);
    const family = await this.family(account);
    const timezone = await this.timezone(account.workspaceId);
    const summary = await this.summary.get({ workspaceId: account.workspaceId, timezone }, id);
    const plans = await this.db.collection('plans').find({ workspaceId: account.workspaceId, studentId: id }).sort({ startAt: -1 }).limit(10).lean();
    const sessions = await this.db.collection('sessions').find({ workspaceId: account.workspaceId, studentId: id }).sort({ startAt: -1 }).limit(20).lean();
    const reports = await this.db.collection('reports').find({ workspaceId: account.workspaceId, studentId: id, ...parentVisibility, status: 'published' }).sort({ publishedAt: -1, createdAt: -1, _id: -1 }).limit(20).lean();
    return { student: parentStudent(student), family: parentFamily(family), summary, plans: await Promise.all(plans.map((plan) => this.planWithTargets(account, plan))), sessions: await this.names(account.workspaceId, sessions), reports: await this.namedReports(account.workspaceId, reports) };
  }

  async sessions(account: FamilyAccount, query: ListQuery) {
    const children = await this.children(account);
    const ids = query.studentId ? [((await this.child(account, query.studentId))._id)] : children.map((student) => student._id);
    const filter: Record<string, unknown> = { workspaceId: account.workspaceId, studentId: { $in: ids } };
    if (query.from || query.to) filter.startAt = { ...(query.from ? { $gte: new Date(query.from) } : {}), ...(query.to ? { $lte: new Date(query.to) } : {}) };
    if (query.status) filter.status = query.status;
    const [items, total] = await Promise.all([
      this.db.collection('sessions').find(filter).sort({ startAt: 1 }).skip((query.page - 1) * query.limit).limit(query.limit).lean(),
      this.db.collection('sessions').countDocuments(filter),
    ]);
    return { items: await this.names(account.workspaceId, items), total, page: query.page, limit: query.limit };
  }

  async session(account: FamilyAccount, id: string) {
    const children = await this.children(account);
    const lesson = await this.db.collection('sessions').findOne({ _id: id, workspaceId: account.workspaceId, studentId: { $in: children.map((child) => child._id) } }).lean();
    if (!lesson) throw new NotFoundException('Sesi tidak ditemukan');
    const [named] = await this.names(account.workspaceId, [lesson]);
    return named;
  }

  async sessionOverview(account: FamilyAccount, id: string) {
    // Authorize the occurrence before reading its series or report contents.
    const lesson = await this.parentSession(account, id);
    const schedule = await this.db.collection('schedules').findOne({ _id: lesson.scheduleId, workspaceId: account.workspaceId, studentId: lesson.studentId, subjectId: lesson.subjectId }).lean();
    if (!schedule) throw new NotFoundException('Jadwal tidak ditemukan');
    const reports = await this.db.collection('reports').find({ workspaceId: account.workspaceId, studentId: lesson.studentId, sessionId: lesson._id, ...parentVisibility, status: 'published' }).sort({ publishedAt: -1, createdAt: -1, _id: -1 }).lean();
    const [namedLesson] = await this.names(account.workspaceId, [lesson]);
    const [namedSchedule] = await this.names(account.workspaceId, [schedule]);
    return { lesson: namedLesson, schedule: namedSchedule, reports: await this.namedReports(account.workspaceId, reports) };
  }

  async plans(account: FamilyAccount, query: ListQuery) {
    const children = await this.children(account);
    const ids = query.studentId ? [((await this.child(account, query.studentId))._id)] : children.map((student) => student._id);
    const filter: Record<string, unknown> = { workspaceId: account.workspaceId, studentId: { $in: ids } };
    if (query.search) filter.title = { $regex: query.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
    const [rows, total] = await Promise.all([
      this.db.collection('plans').find(filter).sort({ startAt: -1 }).skip((query.page - 1) * query.limit).limit(query.limit).lean(),
      this.db.collection('plans').countDocuments(filter),
    ]);
    return { items: await Promise.all(rows.map((plan) => this.planWithTargets(account, plan))), total, page: query.page, limit: query.limit };
  }

  async plan(account: FamilyAccount, id: string) {
    const plan = await this.db.collection('plans').findOne({ _id: id, workspaceId: account.workspaceId }).lean();
    if (!plan) throw new NotFoundException('Rencana belajar tidak ditemukan');
    await this.child(account, plan.studentId);
    return this.planWithTargets(account, plan);
  }

  async target(account: FamilyAccount, id: string) {
    const children = await this.children(account);
    const target = await this.db.collection('targets').findOne({ _id: id, workspaceId: account.workspaceId, studentId: { $in: children.map((child) => child._id) } }).lean();
    if (!target) throw new NotFoundException('Target belajar tidak ditemukan');
    const [item] = await this.targetItems(account, [target]);
    if (!item) throw new NotFoundException('Rencana belajar tidak ditemukan');
    const history = await this.db.collection('histories').find({ workspaceId: account.workspaceId, studentId: target.studentId, planId: target.planId, targetId: id, ...parentVisibility }).sort({ createdAt: -1, _id: -1 }).limit(50).lean();
    return {
      target,
      planTitle: item.planTitle,
      studentName: item.studentName,
      subjectName: item.subjectName,
      startAt: item.startAt,
      endAt: item.endAt,
      history: history.map((entry) => ({
        _id: entry._id, targetId: entry.targetId, planId: entry.planId, studentId: entry.studentId,
        before: entry.before, after: entry.after, note: entry.note, visibility: entry.visibility,
        sessionId: entry.sessionId, createdAt: entry.createdAt, updatedAt: entry.updatedAt,
      })),
    };
  }

  async reports(account: FamilyAccount, query: ListQuery) {
    const children = await this.children(account);
    const ids = query.studentId ? [((await this.child(account, query.studentId))._id)] : children.map((student) => student._id);
    const filter: Record<string, unknown> = { workspaceId: account.workspaceId, studentId: { $in: ids }, ...parentVisibility, status: 'published' };
    if (query.sessionId) {
      await this.parentSession(account, query.sessionId);
      filter.sessionId = query.sessionId;
    }
    const [rows, total] = await Promise.all([
      this.db.collection('reports').find(filter).sort({ publishedAt: -1, createdAt: -1 }).skip((query.page - 1) * query.limit).limit(query.limit).lean(),
      this.db.collection('reports').countDocuments(filter),
    ]);
    return { items: await this.namedReports(account.workspaceId, rows), total, page: query.page, limit: query.limit };
  }

  async report(account: FamilyAccount, id: string) {
    const report = await this.db.collection('reports').findOne({ _id: id, workspaceId: account.workspaceId, ...parentVisibility, status: 'published' }).lean();
    if (!report) throw new NotFoundException('Laporan tidak ditemukan');
    await this.child(account, report.studentId);
    const [named] = await this.namedReports(account.workspaceId, [report]);
    return named;
  }

  private async notificationScope(account: FamilyAccount) {
    // Recheck current family membership, including old inbox entries created
    // before a child was moved to another family. Recipient ID alone is stale.
    const children = await this.children(account);
    const childScope = { workspaceId: account.workspaceId, studentId: { $in: children.map((child) => child._id) } };
    const [sessions, plans, reports, assignments, histories, requests] = await Promise.all([
      this.db.collection('sessions').find(childScope).select('_id').lean(),
      this.db.collection('plans').find(childScope).select('_id').lean(),
      this.db.collection('reports').find({ ...childScope, ...parentVisibility, status: 'published' }).select('_id').lean(),
      this.db.collection('assignments').find({ ...childScope, visibility: 'shared', status: 'published' }).select('_id').lean(),
      this.db.collection('histories').find({ ...childScope, ...parentVisibility }).select('_id').lean(),
      this.db.collection('rescheduleRequests').find({ ...childScope, familyId: account.familyId, parentAccountId: account._id }).select('_id').lean(),
    ]);
    const routes = [
      ...sessions.map((row) => `/parent/sessions/${row._id}`),
      ...plans.map((row) => `/parent/plans/${row._id}`),
      ...reports.map((row) => `/parent/reports/${row._id}`),
      ...assignments.map((row) => `/parent/assignments/${row._id}`),
    ];
    const eventKeys = [
      ...histories.map((row) => `progress:${row._id}:parent:${account._id}`),
      ...requests.flatMap((row) => [`reschedule-proposal:${row._id}`, `reschedule-review:${row._id}`, `reschedule-parent-response:${row._id}`]),
    ];
    return { workspaceId: account.workspaceId, recipientAccountId: account._id, $or: [{ route: { $in: routes } }, { eventKey: { $in: eventKeys } }] };
  }

  async notifications(account: FamilyAccount, query: ListQuery) {
    const filter = await this.notificationScope(account);
    const [items, total] = await Promise.all([
      this.db.collection('notifications').find(filter).sort({ createdAt: -1 }).skip((query.page - 1) * query.limit).limit(query.limit).lean(),
      this.db.collection('notifications').countDocuments(filter),
    ]);
    return { items, total, page: query.page, limit: query.limit };
  }

  async readNotification(account: FamilyAccount, id: string) {
    const updated = await this.db.collection('notifications').findOneAndUpdate({ ...await this.notificationScope(account), _id: id }, { $set: { readAt: new Date() } }, { returnDocument: 'after' }).lean();
    if (!updated) throw new NotFoundException('Notifikasi tidak ditemukan');
    return updated;
  }

  async readAllNotifications(account: FamilyAccount) {
    const result = await this.db.collection('notifications').updateMany({ ...await this.notificationScope(account), readAt: { $exists: false } }, { $set: { readAt: new Date() } });
    return { updated: result.modifiedCount };
  }

  private async parentSession(account: FamilyAccount, sessionId: string) {
    const children = await this.children(account);
    const session = await this.db.collection('sessions').findOne({ _id: sessionId, workspaceId: account.workspaceId, studentId: { $in: children.map((child) => child._id) } }).lean();
    if (!session) throw new NotFoundException('Sesi tidak ditemukan');
    return session;
  }

  private async conflict(workspaceId: string, startAt: Date, endAt: Date, exceptId?: string, session?: ClientSession) {
    return this.db.collection('sessions').exists({ workspaceId, status: { $ne: 'cancelled' }, ...(exceptId ? { _id: { $ne: exceptId } } : {}), startAt: { $lt: endAt }, endAt: { $gt: startAt } }).session(session ?? null);
  }

  private async expireRequests(workspaceId: string, filter: Record<string, unknown>) {
    const now = new Date();
    const stale = await this.db.collection('rescheduleRequests').aggregate<{ _id: string }>([
      { $match: { ...filter, workspaceId, status: 'pending' } },
      { $lookup: { from: this.db.collection('sessions').collection.name, let: { sessionId: '$sessionId', studentId: '$studentId', startAt: '$oldStartAt', endAt: '$oldEndAt' }, pipeline: [
        { $match: { workspaceId, status: 'scheduled', startAt: { $gt: now }, $expr: { $and: [{ $eq: ['$_id', '$$sessionId'] }, { $eq: ['$studentId', '$$studentId'] }, { $eq: ['$startAt', '$$startAt'] }, { $eq: ['$endAt', '$$endAt'] }] } } },
        { $project: { _id: 1 } },
      ], as: 'currentSession' } },
      { $lookup: { from: this.db.collection('students').collection.name, let: { studentId: '$studentId', familyId: '$familyId' }, pipeline: [
        { $match: { workspaceId, $expr: { $and: [{ $eq: ['$_id', '$$studentId'] }, { $eq: ['$familyId', '$$familyId'] }] } } },
        { $project: { _id: 1 } },
      ], as: 'currentChild' } },
      { $match: { $or: [{ $expr: { $lte: [{ $ifNull: ['$proposedStartAt', '$requestedStartAt'] }, now] } }, { 'currentSession.0': { $exists: false } }, { 'currentChild.0': { $exists: false } }] } },
      { $project: { _id: 1 } },
    ]).option({ maxTimeMS: 10000 });
    if (stale.length) await this.db.collection('rescheduleRequests').updateMany({ workspaceId, status: 'pending', _id: { $in: stale.map((request) => request._id) } }, { $set: { status: 'expired' } });
  }

  async availability(account: FamilyAccount, dto: ParentAvailabilityDto) {
    const session = await this.parentSession(account, dto.sessionId);
    await this.subscriptions.requireFeature(account.workspaceId,'reschedule');
    return this.availableSlots(session, dto);
  }

  private async availableSlots(session: LessonSession, dto: RescheduleAvailabilityQuery) {
    if (session.status !== 'scheduled' || session.startAt <= new Date()) throw new BadRequestException('Sesi ini tidak dapat dijadwalkan ulang');
    const requestedFrom = new Date(dto.from), to = new Date(dto.to);
    const step = 30 * 60_000;
    const stepsToFuture = Math.max(0, Math.floor((Date.now() - requestedFrom.getTime()) / step) + 1);
    const from = new Date(requestedFrom.getTime() + stepsToFuture * step);
    const duration = session.endAt.getTime() - session.startAt.getTime();
    if (!(to > from) || to.getTime() - from.getTime() > 31 * 86_400_000) throw new BadRequestException('Rentang ketersediaan maksimal 31 hari');
    const blocked = await this.db.collection('sessions').find({ workspaceId: session.workspaceId, status: { $ne: 'cancelled' }, _id: { $ne: session._id }, startAt: { $lt: to }, endAt: { $gt: from } }).select('startAt endAt').lean();
    const slots: Array<{ startAt: Date; endAt: Date }> = [];
    for (let cursor = new Date(from); cursor.getTime() + duration <= to.getTime() && slots.length < 100; cursor = new Date(cursor.getTime() + step)) {
      const endAt = new Date(cursor.getTime() + duration);
      const busy = blocked.some((item) => item.startAt < endAt && item.endAt > cursor);
      if (!busy) slots.push({ startAt: cursor, endAt });
    }
    return { sessionId: session._id, durationMinutes: Math.round(duration / 60_000), slots };
  }

  async requestReschedule(account: FamilyAccount, dto: ParentRescheduleDto) {
    const session = await this.parentSession(account, dto.sessionId);
    await this.subscriptions.requireFeature(account.workspaceId,'reschedule');
    if (session.status !== 'scheduled' || session.startAt <= new Date()) throw new BadRequestException('Sesi ini tidak dapat dijadwalkan ulang');
    const startAt = new Date(dto.startAt), endAt = new Date(dto.endAt);
    if (!(endAt > startAt)) throw new BadRequestException('Waktu selesai harus setelah waktu mulai');
    if (startAt <= new Date()) throw new BadRequestException('Tanggal perubahan jadwal harus berada di masa depan');
    if (endAt.getTime() - startAt.getTime() !== session.endAt.getTime() - session.startAt.getTime()) throw new BadRequestException('Durasi perubahan jadwal harus sama dengan sesi awal');
    if (!dto.reason.trim()) throw new BadRequestException('Alasan perubahan jadwal wajib diisi');
    await this.expireRequests(account.workspaceId, { sessionId: session._id });
    try {
      const result = await this.db.connection.transaction(async (transaction) => {
        await lockCalendar(this.db, account.workspaceId, transaction);
        const current = await this.db.collection('sessions').findOne({ _id: session._id, workspaceId: account.workspaceId, studentId: session.studentId, status: 'scheduled', startAt: session.startAt, endAt: session.endAt }).session(transaction).lean();
        if (!current || current.startAt <= new Date()) throw new ConflictException('Sesi sudah berubah. Muat ulang jadwal.');
        const child = await this.db.collection('students').exists({ _id: session.studentId, workspaceId: account.workspaceId, familyId: account.familyId }).session(transaction);
        if (!child) throw new NotFoundException('Sesi tidak ditemukan');
        if (await this.conflict(account.workspaceId, startAt, endAt, session._id, transaction)) throw new ConflictException('Waktu yang dipilih sudah digunakan. Pilih slot lain.');
        const existing = await this.db.collection('rescheduleRequests').exists({ workspaceId: account.workspaceId, sessionId: session._id, status: 'pending' }).session(transaction);
        if (existing) throw new ConflictException('Permintaan perubahan tanggal untuk sesi ini masih menunggu persetujuan Guru.');
        const [request] = await this.db.collection('rescheduleRequests').create([{ workspaceId: account.workspaceId, sessionId: session._id, familyId: account.familyId!, parentAccountId: account._id, studentId: session.studentId, oldStartAt: session.startAt, oldEndAt: session.endAt, requestedStartAt: startAt, requestedEndAt: endAt, reason: dto.reason.trim() }], { session: transaction });
        const notificationIds = await this.notificationsEvents.create([{ workspaceId: account.workspaceId, title: 'Permintaan perubahan jadwal', body: 'Orang tua meminta perubahan jadwal untuk satu sesi.', route: '/teacher/reschedule-requests', eventKey: `reschedule-request:${request._id}` }], transaction);
        return { request: request.toObject(), notificationIds };
      });
      await this.notificationsEvents.deliverAfterCommit(result.notificationIds);
      return result.request;
    } catch (error) {
      if ((error as { code?: number }).code === 11000) throw new ConflictException('Permintaan perubahan tanggal untuk sesi ini masih menunggu persetujuan Guru.');
      throw error;
    }
  }

  private rescheduleStatus(value?: string): RescheduleRequest['status'] | undefined {
    if (!value) return undefined;
    if (!['pending', 'approved', 'rejected', 'cancelled', 'expired'].includes(value)) {
      throw new BadRequestException('Status permintaan jadwal tidak valid');
    }
    return value as RescheduleRequest['status'];
  }

  async parentRequests(account: FamilyAccount, query: ListQuery) {
    const status = this.rescheduleStatus(query.status);
    const children = await this.children(account);
    const filter: Record<string, unknown> = { workspaceId: account.workspaceId, familyId: account.familyId, parentAccountId: account._id, studentId: { $in: children.map((child) => child._id) } };
    await this.expireRequests(account.workspaceId, filter);
    if (status) filter.status = status;
    const items = (await this.db.collection('rescheduleRequests').find(filter).sort({ createdAt: -1 }).skip((query.page - 1) * query.limit).limit(query.limit).lean().exec()) as unknown as RescheduleRequest[];
    const total = await this.db.collection('rescheduleRequests').countDocuments(filter);
    return { items: await this.names(account.workspaceId, items), total, page: query.page, limit: query.limit };
  }

  async teacherRequests(actor: Principal, query: ListQuery) {
    const status = this.rescheduleStatus(query.status);
    await this.expireRequests(actor.workspaceId, {});
    const filter: { workspaceId: string; status?: RescheduleRequest['status'] } = { workspaceId: actor.workspaceId };
    if (status) filter.status = status;
    const items = (await this.db.collection('rescheduleRequests').find(filter).sort({ createdAt: -1 }).skip((query.page - 1) * query.limit).limit(query.limit).lean().exec()) as unknown as RescheduleRequest[];
    const total = await this.db.collection('rescheduleRequests').countDocuments(filter);
    const students = await this.db.collection('students').find({ workspaceId: actor.workspaceId, _id: { $in: items.map((item) => item.studentId) } }).select('_id name grade').lean();
    const map = new Map(students.map((student) => [student._id, student]));
    return { items: items.map((item) => ({ ...item, studentName: map.get(item.studentId)?.name ?? '', studentGrade: map.get(item.studentId)?.grade ?? '' })), total, page: query.page, limit: query.limit };
  }

  private async parentRequestScope(account: FamilyAccount, id: string) {
    const children = await this.children(account);
    return { _id: id, workspaceId: account.workspaceId, familyId: account.familyId, parentAccountId: account._id, studentId: { $in: children.map((child) => child._id) } };
  }

  private async pendingOccurrence(request: RescheduleRequest, session?: ClientSession) {
    if (request.status !== 'pending') throw new ConflictException('Permintaan ini sudah diproses atau kedaluwarsa.');
    const child = await this.db.collection('students').exists({ _id: request.studentId, workspaceId: request.workspaceId, familyId: request.familyId }).session(session ?? null);
    const now = new Date();
    if (!child || request.oldStartAt <= now || (request.proposedStartAt ?? request.requestedStartAt) <= now) throw new ConflictException('Permintaan perubahan jadwal sudah kedaluwarsa.');
    const occurrence = await this.db.collection('sessions').findOne({ _id: request.sessionId, workspaceId: request.workspaceId, studentId: request.studentId, status: 'scheduled', startAt: request.oldStartAt, endAt: request.oldEndAt }).session(session ?? null).lean();
    if (!occurrence) throw new ConflictException('Sesi sudah berubah atau dibatalkan. Muat ulang jadwal.');
    return occurrence;
  }

  private validateRequestedTimes(request: RescheduleRequest, startAt: Date, endAt: Date) {
    if (!Number.isFinite(startAt.getTime()) || !Number.isFinite(endAt.getTime()) || !(endAt > startAt)) throw new BadRequestException('Waktu selesai harus setelah waktu mulai');
    if (startAt <= new Date()) throw new ConflictException('Waktu perubahan jadwal sudah kedaluwarsa.');
    if (endAt.getTime() - startAt.getTime() !== request.oldEndAt.getTime() - request.oldStartAt.getTime()) throw new BadRequestException('Durasi perubahan jadwal harus sama dengan sesi awal');
  }

  private async moveOccurrence(request: RescheduleRequest, startAt: Date, endAt: Date, session: ClientSession) {
    this.validateRequestedTimes(request, startAt, endAt);
    if (await this.conflict(request.workspaceId, startAt, endAt, request.sessionId, session)) throw new ConflictException('Slot tersebut sudah diambil. Pilih waktu lain.');
    const occurrence = await this.db.collection('sessions').findOneAndUpdate({ _id: request.sessionId, workspaceId: request.workspaceId, studentId: request.studentId, status: 'scheduled', startAt: request.oldStartAt, endAt: request.oldEndAt }, { $set: { startAt, endAt } }, { session, returnDocument: 'after', runValidators: true }).lean();
    if (!occurrence) throw new ConflictException('Sesi sudah berubah atau dibatalkan. Muat ulang jadwal.');
  }

  async teacherAvailability(actor: Principal, id: string, query: RescheduleAvailabilityQuery) {
    await this.expireRequests(actor.workspaceId, { _id: id });
    const request = await this.db.collection('rescheduleRequests').findOne({ _id: id, workspaceId: actor.workspaceId }).lean();
    if (!request) throw new NotFoundException('Permintaan perubahan jadwal tidak ditemukan');
    await this.subscriptions.requireFeature(actor.workspaceId, 'reschedule');
    const occurrence = await this.pendingOccurrence(request);
    return { requestId: id, ...await this.availableSlots(occurrence, query) };
  }

  async cancelRequest(account: FamilyAccount, id: string) {
    const filter = await this.parentRequestScope(account, id);
    await this.expireRequests(account.workspaceId, filter);
    const result = await this.db.connection.transaction(async (session) => {
      const request = await this.db.collection('rescheduleRequests').findOne(filter).session(session).lean();
      if (!request) throw new NotFoundException('Permintaan perubahan jadwal tidak ditemukan');
      await this.pendingOccurrence(request, session);
      const updated = await this.db.collection('rescheduleRequests').findOneAndUpdate({ ...filter, status: 'pending' }, { $set: { status: 'cancelled' } }, { session, returnDocument: 'after', runValidators: true }).lean();
      if (!updated) throw new ConflictException('Permintaan sudah diproses oleh pengguna lain.');
      const notificationIds = await this.notificationsEvents.create([{ workspaceId: account.workspaceId, title: 'Permintaan perubahan jadwal dibatalkan', body: 'Orang tua membatalkan permintaan perubahan jadwal.', route: '/teacher/reschedule-requests', eventKey: `reschedule-cancel:${id}` }], session);
      await this.db.collection('audits').create([{ workspaceId: account.workspaceId, actorId: account._id, action: 'reschedule.cancelled', resourceId: id }], { session });
      return { request: updated, notificationIds };
    });
    await this.notificationsEvents.deliverAfterCommit(result.notificationIds);
    return result.request;
  }

  async respondRequest(account: FamilyAccount, id: string, dto: RespondRescheduleDto) {
    await this.subscriptions.requireFeature(account.workspaceId,'reschedule');
    const filter = await this.parentRequestScope(account, id);
    if (!await this.db.collection('rescheduleRequests').exists(filter)) throw new NotFoundException('Permintaan perubahan jadwal tidak ditemukan');
    if (dto.action === 'accept') await this.subscriptions.requireFeature(account.workspaceId, 'reschedule');
    await this.expireRequests(account.workspaceId, filter);
    const result = await this.db.connection.transaction(async (session) => {
      await lockCalendar(this.db, account.workspaceId, session);
      const request = await this.db.collection('rescheduleRequests').findOne(filter).session(session).lean();
      if (!request) throw new NotFoundException('Permintaan perubahan jadwal tidak ditemukan');
      await this.pendingOccurrence(request, session);
      if (!request.proposedStartAt || !request.proposedEndAt) throw new ConflictException('Belum ada tawaran waktu lain dari Guru.');
      this.validateRequestedTimes(request, request.proposedStartAt, request.proposedEndAt);
      const status = dto.action === 'accept' ? 'approved' : 'rejected';
      if (dto.action === 'accept') await this.moveOccurrence(request, request.proposedStartAt, request.proposedEndAt, session);
      const updated = await this.db.collection('rescheduleRequests').findOneAndUpdate({ ...filter, status: 'pending', proposedStartAt: request.proposedStartAt, proposedEndAt: request.proposedEndAt }, { $set: { status } }, { session, returnDocument: 'after', runValidators: true }).lean();
      if (!updated) throw new ConflictException('Permintaan sudah berubah. Muat ulang sebelum menyimpan.');
      const notificationIds = await this.notificationsEvents.create([
        { workspaceId: account.workspaceId, title: dto.action === 'accept' ? 'Tawaran jadwal diterima' : 'Tawaran jadwal ditolak', body: dto.action === 'accept' ? 'Orang tua menerima tawaran waktu dari Guru.' : 'Orang tua menolak tawaran waktu dari Guru.', route: '/teacher/reschedule-requests', eventKey: `reschedule-response:${id}` },
        { workspaceId: account.workspaceId, recipientAccountId: account._id, title: dto.action === 'accept' ? 'Perubahan jadwal disetujui' : 'Tawaran jadwal ditolak', body: dto.action === 'accept' ? 'Jadwal satu pertemuan sudah diperbarui sesuai tawaran Guru.' : 'Tawaran waktu dari Guru telah Anda tolak.', route: '/parent/reschedule-requests', eventKey: `reschedule-parent-response:${id}` },
      ], session);
      await this.db.collection('audits').create([{ workspaceId: account.workspaceId, actorId: account._id, action: `reschedule.proposal.${dto.action}`, resourceId: id }], { session });
      return { request: updated, notificationIds };
    });
    await this.notificationsEvents.deliverAfterCommit(result.notificationIds);
    return result.request;
  }

  async review(actor: Principal, id: string, dto: ReviewRescheduleDto) {
    await this.expireRequests(actor.workspaceId, { _id: id });
    if (!await this.db.collection('rescheduleRequests').exists({ _id: id, workspaceId: actor.workspaceId })) throw new NotFoundException('Permintaan perubahan jadwal tidak ditemukan');
    await this.subscriptions.requireFeature(actor.workspaceId,'reschedule');
    const result = await this.db.connection.transaction(async (session) => {
      await lockCalendar(this.db, actor.workspaceId, session);
      const request = await this.db.collection('rescheduleRequests').findOne({ _id: id, workspaceId: actor.workspaceId }).session(session).lean();
      if (!request) throw new NotFoundException('Permintaan perubahan jadwal tidak ditemukan');
      await this.pendingOccurrence(request, session);
      const proposal = dto.status === 'proposed';
      let proposedStartAt: Date | undefined, proposedEndAt: Date | undefined;
      if (proposal) {
        // One immutable offer per request prevents an accept from silently
        // switching to a replacement offer the parent has never reviewed.
        if (request.proposedStartAt || request.proposedEndAt) throw new ConflictException('Tawaran waktu masih menunggu jawaban Orang Tua.');
        if (!dto.proposedStartAt || !dto.proposedEndAt) throw new BadRequestException('Waktu tawaran Guru wajib diisi');
        proposedStartAt = new Date(dto.proposedStartAt); proposedEndAt = new Date(dto.proposedEndAt);
        this.validateRequestedTimes(request, proposedStartAt, proposedEndAt);
        if (await this.conflict(actor.workspaceId, proposedStartAt, proposedEndAt, request.sessionId, session)) throw new ConflictException('Slot tersebut sudah diambil. Pilih waktu lain.');
      } else if (dto.proposedStartAt !== undefined || dto.proposedEndAt !== undefined) {
        throw new BadRequestException('Waktu tawaran hanya dapat dikirim bersama status proposed');
      }
      if (dto.status === 'approved') {
        if (request.proposedStartAt || request.proposedEndAt) throw new ConflictException('Tawaran waktu menunggu persetujuan Orang Tua.');
        await this.moveOccurrence(request, request.requestedStartAt, request.requestedEndAt, session);
      }
      const status = proposal ? 'pending' : dto.status;
      const updated = await this.db.collection('rescheduleRequests').findOneAndUpdate({ _id: id, workspaceId: actor.workspaceId, status: 'pending' }, { $set: { status, reviewedBy: actor._id, reviewedAt: new Date(), reviewNote: dto.note?.trim() ?? '', ...(proposal ? { proposedStartAt, proposedEndAt } : {}) } }, { returnDocument: 'after', session, runValidators: true }).lean();
      if (!updated) throw new ConflictException('Permintaan sudah diproses oleh pengguna lain.');
      const notificationIds = await this.notificationsEvents.create([
        { workspaceId: actor.workspaceId, recipientAccountId: request.parentAccountId, title: proposal ? 'Guru menawarkan waktu lain' : dto.status === 'approved' ? 'Perubahan jadwal disetujui' : 'Perubahan jadwal ditolak', body: dto.note?.trim() || (proposal ? 'Guru menawarkan waktu lain. Buka permintaan untuk menerima atau menolak.' : 'Permintaan perubahan jadwal Anda sudah diproses Guru.'), route: '/parent/reschedule-requests', eventKey: proposal ? `reschedule-proposal:${id}` : `reschedule-review:${id}` },
        ...(!proposal ? [{ workspaceId: actor.workspaceId, title: dto.status === 'approved' ? 'Perubahan jadwal disetujui' : 'Perubahan jadwal ditolak', body: 'Permintaan perubahan jadwal dari Orang Tua sudah diproses.', route: '/teacher/reschedule-requests', eventKey: `reschedule-teacher-review:${id}` }] : []),
      ], session);
      await this.db.collection('audits').create([{ workspaceId: actor.workspaceId, actorId: actor._id, action: `reschedule.${dto.status}`, resourceId: id }], { session });
      return { request: updated, notificationIds };
    });
    await this.notificationsEvents.deliverAfterCommit(result.notificationIds);
    return result.request;
  }
}
