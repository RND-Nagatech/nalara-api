import { Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import type { LearningPlan, LessonReport, PortalAccount, Student } from '../../database/entities';
import { Database } from '../../database/database.module';
import { ListQuery } from '../../common/query.dto';
import { aggregateProgress } from '../learning-plans/progress.rules';
import { dashboardDayWindow, dashboardPreviewLimit } from '../dashboard/dashboard.rules';

type StudentAccount = Pick<PortalAccount, '_id' | 'workspaceId' | 'role' | 'studentId'>;
type NamedRow = { studentId: string; subjectId?: string };

@Injectable()
export class StudentPortalService {
  constructor(private readonly db: Database) {}

  private async student(account: StudentAccount): Promise<Student> {
    if (account.role !== 'student' || !account.studentId) throw new UnauthorizedException('Akses siswa tidak valid');
    const student = await this.db.collection('students').findOne({ _id: account.studentId, workspaceId: account.workspaceId, status: 'active' }).lean();
    if (!student) throw new UnauthorizedException('Data siswa tidak tersedia. Hubungi Guru.');
    return student;
  }

  private async timezone(workspaceId: string) {
    const owner = await this.db.collection('users').findOne({ workspaceId }).select('timezone').lean();
    return owner?.timezone ?? 'Asia/Jakarta';
  }

  private publicStudent(student: Student) {
    // Never serialize internal teacher notes, family IDs or referral metadata.
    return { _id: student._id, name: student.name, grade: student.grade, status: student.status };
  }

  private async names<T extends NamedRow>(workspaceId: string, rows: readonly T[]) {
    const [subjects, teacher, students] = await Promise.all([
      this.db.collection('subjects').find({ workspaceId, _id: { $in: rows.map((row) => row.subjectId).filter((id): id is string => Boolean(id)) } }).select('_id name').lean(),
      this.db.collection('users').findOne({ workspaceId }).select('name').lean(),
      this.db.collection('students').find({ workspaceId, _id: { $in: rows.map((row) => row.studentId) } }).select('_id name grade').lean(),
    ]);
    const subjectMap = new Map(subjects.map((subject) => [subject._id, subject.name]));
    const studentMap = new Map(students.map((student) => [student._id, student]));
    return rows.map((row) => ({ ...row, studentName: studentMap.get(row.studentId)?.name ?? '', studentGrade: studentMap.get(row.studentId)?.grade ?? '', subjectName: subjectMap.get(row.subjectId ?? '') ?? '', teacherName: teacher?.name ?? '' }));
  }

  private async namedReports(workspaceId: string, reports: readonly LessonReport[]) {
    const sessions = await this.db.collection('sessions').find({ workspaceId, _id: { $in: reports.map((report) => report.sessionId) }, studentId: { $in: reports.map((report) => report.studentId) } }).select('_id studentId subjectId').lean();
    const sessionsById = new Map(sessions.map((session) => [session._id, session]));
    return this.names(workspaceId, reports.map((report) => {
      const session = sessionsById.get(report.sessionId);
      return { ...report, subjectId: session?.studentId === report.studentId ? session.subjectId : undefined };
    }));
  }

  private async planWithTargets(account: StudentAccount, plan: LearningPlan) {
    const targets = await this.db.collection('targets').find({ workspaceId: account.workspaceId, planId: plan._id, studentId: account.studentId, subjectId: plan.subjectId }).sort({ createdAt: 1, _id: 1 }).lean();
    const [named] = await this.names(account.workspaceId, [plan]);
    return { ...named, targets, ...aggregateProgress(targets) };
  }

  async profile(account: StudentAccount) {
    const student = await this.student(account);
    return { role: 'student', name: student.name, student: this.publicStudent(student), students: [this.publicStudent(student)] };
  }

  async dashboard(account: StudentAccount) {
    const student = await this.student(account);
    const timezone = await this.timezone(account.workspaceId);
    const now = new Date();
    const { from, to, localDate } = dashboardDayWindow(now, timezone);
    const today = { workspaceId: account.workspaceId, studentId: student._id, startAt: { $gte: from, $lt: to }, status: { $ne: 'cancelled' as const } };
    const [sessions, sessionsToday] = await Promise.all([
      this.db.collection('sessions').find(today).sort({ startAt: 1, _id: 1 }).limit(dashboardPreviewLimit).lean(),
      this.db.collection('sessions').countDocuments(today),
    ]);
    const plans = await this.db.collection('plans').find({ workspaceId: account.workspaceId, studentId: student._id }).sort({ startAt: -1 }).limit(3).lean();
    const targets = await this.db.collection('targets').find({ workspaceId: account.workspaceId, studentId: student._id, status: { $in: ['active', 'completed'] } }).lean();
    const reports = await this.db.collection('reports').find({ workspaceId: account.workspaceId, studentId: student._id, visibility: { $in: ['student', 'shared'] }, status: 'published' }).sort({ publishedAt: -1, createdAt: -1 }).limit(3).lean();
    const newReports = await this.db.collection('reports').countDocuments({ workspaceId: account.workspaceId, studentId: student._id, visibility: { $in: ['student', 'shared'] }, status: 'published', publishedAt: { $gte: new Date(Date.now() - 7 * 86_400_000) } });
    const submittedIds = await this.db.collection('submissions').find({workspaceId:account.workspaceId,studentId:student._id}).distinct('assignmentId');
    const pendingHomework = await this.db.collection('assignments').countDocuments({workspaceId:account.workspaceId,studentId:student._id,kind:'task',status:'published',visibility:{$in:['student','shared']},_id:{$nin:submittedIds}});
    const unreadNotifications = await this.db.collection('notifications').countDocuments({ ...await this.notificationScope(account), readAt: { $exists: false } });
    const { progress } = aggregateProgress(targets);
    return { generatedAt: now, timezone, localDate, student: this.publicStudent(student), sessionsToday, progress, newReports, pendingHomework, unreadNotifications, todaySessions: await this.names(account.workspaceId, sessions), recentReports: await this.namedReports(account.workspaceId, reports), plans: await Promise.all(plans.map((plan) => this.planWithTargets(account, plan))) };
  }

  async sessions(account: StudentAccount, query: ListQuery) {
    const student = await this.student(account);
    const filter: Record<string, unknown> = { workspaceId: account.workspaceId, studentId: student._id };
    if (query.from || query.to) filter.startAt = { ...(query.from ? { $gte: new Date(query.from) } : {}), ...(query.to ? { $lte: new Date(query.to) } : {}) };
    if (query.status) filter.status = query.status;
    const [items, total] = await Promise.all([
      this.db.collection('sessions').find(filter).sort({ startAt: 1 }).skip((query.page - 1) * query.limit).limit(query.limit).lean(),
      this.db.collection('sessions').countDocuments(filter),
    ]);
    return { items: await this.names(account.workspaceId, items), total, page: query.page, limit: query.limit };
  }

  async session(account: StudentAccount, id: string) {
    const student = await this.student(account);
    const lesson = await this.db.collection('sessions').findOne({ _id: id, workspaceId: account.workspaceId, studentId: student._id }).lean();
    if (!lesson) throw new NotFoundException('Sesi tidak ditemukan');
    const [named] = await this.names(account.workspaceId, [lesson]);
    return named;
  }

  async sessionOverview(account: StudentAccount, id: string) {
    // Authorize this one student's occurrence before resolving the real series.
    const lesson = await this.session(account, id);
    const schedule = await this.db.collection('schedules').findOne({ _id: lesson.scheduleId, workspaceId: account.workspaceId, studentId: lesson.studentId, subjectId: lesson.subjectId }).lean();
    if (!schedule) throw new NotFoundException('Jadwal tidak ditemukan');
    const reports = await this.db.collection('reports').find({ workspaceId: account.workspaceId, studentId: lesson.studentId, sessionId: id, status: 'published', visibility: { $in: ['student', 'shared'] } }).sort({ publishedAt: -1, createdAt: -1 }).lean();
    return { lesson, schedule, reports: await this.namedReports(account.workspaceId, reports) };
  }

  async plans(account: StudentAccount, query: ListQuery) {
    const student = await this.student(account);
    const filter: Record<string, unknown> = { workspaceId: account.workspaceId, studentId: student._id };
    if (query.search) filter.title = { $regex: query.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
    const [rows, total] = await Promise.all([
      this.db.collection('plans').find(filter).sort({ startAt: -1 }).skip((query.page - 1) * query.limit).limit(query.limit).lean(),
      this.db.collection('plans').countDocuments(filter),
    ]);
    return { items: await Promise.all(rows.map((plan) => this.planWithTargets(account, plan))), total, page: query.page, limit: query.limit };
  }

  async plan(account: StudentAccount, id: string) {
    const student = await this.student(account);
    const plan = await this.db.collection('plans').findOne({ _id: id, workspaceId: account.workspaceId, studentId: student._id }).lean();
    if (!plan) throw new NotFoundException('Rencana belajar tidak ditemukan');
    return this.planWithTargets(account, plan);
  }

  async target(account: StudentAccount, id: string) {
    const student = await this.student(account);
    const target = await this.db.collection('targets').findOne({ _id: id, workspaceId: account.workspaceId, studentId: student._id }).lean();
    if (!target) throw new NotFoundException('Target belajar tidak ditemukan');
    const plan = await this.db.collection('plans').findOne({ _id: target.planId, workspaceId: account.workspaceId, studentId: student._id }).lean();
    const history = await this.db.collection('histories').find({ workspaceId: account.workspaceId, studentId: student._id, planId: target.planId, targetId: id, visibility: { $in: ['student', 'shared'] } }).sort({ createdAt: -1, _id: -1 }).limit(50).lean();
    if (!plan || plan.subjectId !== target.subjectId) throw new NotFoundException('Rencana belajar tidak ditemukan');
    const [named] = await this.names(account.workspaceId, [target]);
    const overview = await this.planWithTargets(account, plan);
    return { ...named, plan: { _id: plan._id, title: plan.title, startAt: plan.startAt, endAt: plan.endAt, progress: overview.progress, targetCount: overview.targetCount }, history: history.map((entry) => ({ _id: entry._id, targetId: entry.targetId, before: entry.before, after: entry.after, note: entry.note, visibility: entry.visibility, sessionId: entry.sessionId, createdAt: entry.createdAt })) };
  }

  async reports(account: StudentAccount, query: ListQuery) {
    const student = await this.student(account);
    const filter: Record<string, unknown> = { workspaceId: account.workspaceId, studentId: student._id, visibility: { $in: ['student', 'shared'] }, status: 'published' };
    if (query.sessionId) filter.sessionId = query.sessionId;
    const [rows, total] = await Promise.all([
      this.db.collection('reports').find(filter).sort({ publishedAt: -1, createdAt: -1 }).skip((query.page - 1) * query.limit).limit(query.limit).lean(),
      this.db.collection('reports').countDocuments(filter),
    ]);
    return { items: await this.namedReports(account.workspaceId, rows), total, page: query.page, limit: query.limit };
  }

  async report(account: StudentAccount, id: string) {
    const student = await this.student(account);
    const report = await this.db.collection('reports').findOne({ _id: id, workspaceId: account.workspaceId, studentId: student._id, visibility: { $in: ['student', 'shared'] }, status: 'published' }).lean();
    if (!report) throw new NotFoundException('Laporan tidak ditemukan');
    const [named] = await this.namedReports(account.workspaceId, [report]);
    return named;
  }

  private async notificationScope(account: StudentAccount) {
    const student = await this.student(account);
    const scope = { workspaceId: account.workspaceId, studentId: student._id };
    const [sessions, plans, reports, assignments, targets, histories] = await Promise.all([
      this.db.collection('sessions').find(scope).select('_id').lean(),
      this.db.collection('plans').find(scope).select('_id').lean(),
      this.db.collection('reports').find({ ...scope, status: 'published', visibility: { $in: ['student', 'shared'] } }).select('_id').lean(),
      this.db.collection('assignments').find({ ...scope, status: 'published', visibility: { $in: ['student', 'shared'] } }).select('_id').lean(),
      this.db.collection('targets').find(scope).select('_id').lean(),
      this.db.collection('histories').find({ ...scope, visibility: { $in: ['student', 'shared'] } }).select('_id').lean(),
    ]);
    // Recipient ID is necessary but not sufficient: a report may have become
    // private since its event was delivered. Resolve current readable resources.
    const routes = [
      ...sessions.map((row) => `/student/sessions/${row._id}`),
      ...plans.map((row) => `/student/plans/${row._id}`),
      ...reports.map((row) => `/student/reports/${row._id}`),
      ...assignments.map((row) => `/student/assignments/${row._id}`),
    ];
    const eventKeys = [
      ...targets.map((row) => `target-created:${row._id}:student:${account._id}`),
      ...histories.map((row) => `progress:${row._id}:student:${account._id}`),
    ];
    return { workspaceId: account.workspaceId, recipientAccountId: account._id, $or: [{ route: { $in: routes } }, { eventKey: { $in: eventKeys } }, {eventKey: {$regex: '^target-due:'}, route: {$in: targets.map(row => `/student/targets/${row._id}`)}}] };
  }

  async notifications(account: StudentAccount, query: ListQuery) {
    const filter = await this.notificationScope(account);
    const [items, total] = await Promise.all([
      this.db.collection('notifications').find(filter).select('_id title body route readAt createdAt').sort({ createdAt: -1, _id: -1 }).skip((query.page - 1) * query.limit).limit(query.limit).lean(),
      this.db.collection('notifications').countDocuments(filter),
    ]);
    return { items, total, page: query.page, limit: query.limit };
  }

  async readNotification(account: StudentAccount, id: string) {
    const updated = await this.db.collection('notifications').findOneAndUpdate({ ...await this.notificationScope(account), _id: id }, { $set: { readAt: new Date() } }, { returnDocument: 'after' }).select('_id title body route readAt createdAt').lean();
    if (!updated) throw new NotFoundException('Notifikasi tidak ditemukan');
    return updated;
  }

  async readAllNotifications(account: StudentAccount) {
    const result = await this.db.collection('notifications').updateMany({ ...await this.notificationScope(account), readAt: { $exists: false } }, { $set: { readAt: new Date() } });
    return { updated: result.modifiedCount };
  }
}
