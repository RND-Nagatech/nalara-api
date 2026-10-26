import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Database } from '../../database/database.module';
import { NotificationEventsService, NotificationEventInput } from './notification-events.service';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { effectiveSubscription } from '../subscriptions/catalog';

type LocalParts = { year: number; month: number; day: number };

@Injectable()
export class NotificationScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NotificationScheduler.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly config: ConfigService,
    private readonly db: Database,
    private readonly events: NotificationEventsService,
    private readonly subscriptions: SubscriptionsService,
  ) {}

  onModuleInit() {
    const minutes = this.config.get<number>('NOTIFICATION_SCHEDULER_INTERVAL_MINUTES') ?? 15;
    this.timer = setInterval(() => void this.run(), minutes * 60_000);
    void this.run();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async run(now = new Date()) {
    if (this.running) return;
    this.running = true;
    try {
      const teachers = await this.db.collection('users').find({ role: 'teacher', deletionRequestedAt: {$exists: false} }).select('workspaceId timezone').lean();
      const workspaces = new Map(teachers.map((teacher) => [teacher.workspaceId, teacher.timezone]));
      for (const [workspaceId, timezone] of workspaces) {
        try {
          await this.remindSubscription(workspaceId, timezone, now);
          if(!await this.subscriptions.canUse(workspaceId,'automaticReminders')) continue;
          await this.remindTuition(workspaceId, timezone, now);
          await this.remindTargets(workspaceId, timezone, now);
          await this.remindSessions(workspaceId, timezone, now);
        } catch (error) {
          this.logger.warn({event:'notification.reminder.workspace_failed',workspaceId,errorType:error instanceof Error?error.name:'Unknown'});
        }
      }
    } catch (error) {
      this.logger.warn({event:'notification.reminder.scan_failed',errorType:error instanceof Error?error.name:'Unknown'});
    } finally {
      this.running = false;
    }
  }

  private async remindSubscription(workspaceId: string, timezone: string, now: Date) {
    // Background work must never create/extend a trial through ensure/state.
    const subscription = await this.db.collection('subscriptions').findOne({workspaceId}).lean();
    if (!subscription) return;
    const state = effectiveSubscription(subscription, now);
    if (!state.active || ![3, 1].includes(state.daysRemaining)) return;
    const deadline = new Intl.DateTimeFormat('id-ID', {timeZone:timezone,dateStyle:'long',timeStyle:'short'}).format(state.endsAt);
    const trial = state.plan === 'trial';
    const teachers = await this.events.teacherIds(workspaceId);
    const events = teachers.map(recipientAccountId => ({
      workspaceId, recipientAccountId,
      title: trial ? 'Masa uji coba segera berakhir' : 'Pengingat perpanjangan langganan',
      body: trial ? `Masa uji coba NALARA Anda berakhir pada ${deadline}. Silakan pilih paket langganan untuk melanjutkan pengelolaan pembelajaran.`
        : `Langganan Tutor ${state.plan === 'pro' ? 'Pro' : 'Basic'} Anda berakhir pada ${deadline}. Silakan perpanjang langganan untuk menjaga kelanjutan akses fitur.`,
      route: '/teacher/subscription', deliveryExpiresAt: new Date(state.endsAt.getTime() - (state.daysRemaining - 1) * 86400_000),
      eventKey: `subscription-expiring:${subscription._id}:${state.endsAt.getTime()}:${state.daysRemaining}:teacher:${recipientAccountId}`,
    }));
    await this.events.deliverAfterCommit(await this.events.create(events));
  }

  private parts(now: Date, timezone: string): LocalParts {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(now);
    const value = (type: string) => Number(parts.find((part) => part.type === type)?.value);
    return { year: value('year'), month: value('month'), day: value('day') };
  }

  private midnight(date: LocalParts, timezone: string) {
    const wall = Date.UTC(date.year, date.month - 1, date.day);
    let utc = wall;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const at = this.partsWithTime(new Date(utc), timezone);
      const offset = Date.UTC(at.year, at.month - 1, at.day, at.hour, at.minute, at.second) - utc;
      const next = wall - offset;
      if (next === utc) break;
      utc = next;
    }
    return new Date(utc);
  }

  private partsWithTime(now: Date, timezone: string) {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(now);
    const value = (type: string) => Number(parts.find((part) => part.type === type)?.value);
    return { year: value('year'), month: value('month'), day: value('day'), hour: value('hour'), minute: value('minute'), second: value('second') };
  }

  private tomorrowWindow(now: Date, timezone: string) {
    const local = this.parts(now, timezone);
    const next = new Date(Date.UTC(local.year, local.month - 1, local.day + 1));
    const date = { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() };
    const following = new Date(Date.UTC(date.year, date.month - 1, date.day + 1));
    return {
      date: `${date.year}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`,
      start: this.midnight(date, timezone),
      end: this.midnight({ year: following.getUTCFullYear(), month: following.getUTCMonth() + 1, day: following.getUTCDate() }, timezone),
    };
  }

  private async remindTargets(workspaceId: string, timezone: string, now: Date) {
    const window = this.tomorrowWindow(now, timezone);
    const plans = await this.db.collection('plans').find({ workspaceId, endAt: { $gte: window.start, $lt: window.end } }).select('_id studentId title endAt').lean();
    if (!plans.length) return;
    const planIds = plans.map((plan) => plan._id);
    const targets = await this.db.collection('targets').find({ workspaceId, planId: { $in: planIds }, status: 'active', progress: { $lt: 100 } }).select('_id planId studentId title progress').lean();
    const students = await this.db.collection('students').find({ workspaceId, _id: { $in: targets.map((target) => target.studentId) } }).select('_id name').lean();
    const studentNames = new Map(students.map((student) => [student._id, student.name]));
    const events: NotificationEventInput[] = [];
    for (const target of targets) {
      const plan = plans.find((item) => item._id === target.planId);
      if (!plan) continue;
      const recipients = await this.events.studentRecipients(workspaceId, target.studentId);
      const teachers = await this.events.teacherIds(workspaceId);
      const base = `Target "${target.title}" untuk siswa ${studentNames.get(target.studentId) ?? 'yang terdaftar'} jatuh tempo besok, ${this.displayDate(window.date)} dan belum terpenuhi.`;
      for (const teacherId of teachers) events.push({ workspaceId, recipientAccountId: teacherId, title: 'Pengingat target belajar', body: base, route: `/teacher/targets/${target._id}`, eventKey: `target-due:${target._id}:${window.date}:teacher:${teacherId}` });
      for (const parentId of recipients.parentIds) events.push({ workspaceId, recipientAccountId: parentId, title: 'Pengingat target belajar', body: base, route: `/parent/plans/${plan._id}`, eventKey: `target-due:${target._id}:${window.date}:parent:${parentId}` });
      for (const studentId of recipients.studentIds) events.push({ workspaceId, recipientAccountId: studentId, title: 'Pengingat target belajar', body: base, route: `/student/targets/${target._id}`, eventKey: `target-due:${target._id}:${window.date}:student:${studentId}` });
    }
    for (const event of events) event.deliveryExpiresAt = window.start;
    await this.events.deliverAfterCommit(await this.events.create(events));
  }

  private async remindSessions(workspaceId: string, timezone: string, now: Date) {
    // Bound candidate reads, then use each series' original local calendar.
    // Updating the teacher's display/default zone must not move H-1 reminders
    // for an existing series. 72h also covers legacy IANA/DST tomorrow windows.
    const candidates = await this.db.collection('sessions').find({ workspaceId, startAt: { $gte: now, $lt: new Date(now.getTime() + 72 * 3600_000) }, status: 'scheduled' }).select('_id scheduleId groupId studentId subjectId startAt endAt').sort({_id:1}).lean();
    const schedules = await this.db.collection('schedules').find({workspaceId, _id: {$in: [...new Set(candidates.map(row => row.scheduleId).filter(Boolean))]}}).select('_id timezone').lean();
    const zones = new Map(schedules.map(row => [row._id, row.timezone]));
    const windows = new Map<string, ReturnType<NotificationScheduler['tomorrowWindow']>>();
    const sessions = candidates.filter(row => {
      const zone = zones.get(row.scheduleId) ?? timezone;
      if (!windows.has(zone)) windows.set(zone, this.tomorrowWindow(now, zone));
      const window = windows.get(zone)!;
      return row.startAt >= window.start && row.startAt < window.end;
    });
    const teacherGroups=new Set<string>();
    const events: NotificationEventInput[] = [];
    const teachers = await this.events.teacherIds(workspaceId);
    const [students, subjects] = await Promise.all([
      this.db.collection('students').find({ workspaceId, _id: { $in: sessions.map((lesson) => lesson.studentId) } }).select('_id name').lean(),
      this.db.collection('subjects').find({ workspaceId, _id: { $in: sessions.map((lesson) => lesson.subjectId) } }).select('_id name').lean(),
    ]);
    const studentNames = new Map(students.map((student) => [student._id, student.name]));
    const subjectNames = new Map(subjects.map((subject) => [subject._id, subject.name]));
    for (const lesson of sessions) {
      const zone = zones.get(lesson.scheduleId) ?? timezone;
      const window = windows.get(zone)!;
      const firstEvent = events.length;
      const recipients = await this.events.studentRecipients(workspaceId, lesson.studentId);
      const label = ({'Asia/Jakarta': 'WIB', 'Asia/Makassar': 'WITA', 'Asia/Jayapura': 'WIT'} as Record<string, string>)[zone] ?? zone;
      const time = `${new Intl.DateTimeFormat('id-ID', { timeZone: zone, dateStyle: 'full', timeStyle: 'short' }).format(lesson.startAt)} ${label}`;
      const body = `Sesi ${subjectNames.get(lesson.subjectId) ?? 'belajar'} untuk siswa ${studentNames.get(lesson.studentId) ?? 'yang terdaftar'} dijadwalkan pada ${time}. Mohon siapkan kehadiran sesuai jadwal.`;
      const groupKey=lesson.groupId ? `${lesson.groupId}:${lesson.startAt.toISOString()}:${lesson.endAt.toISOString()}` : lesson._id;
      if(!teacherGroups.has(groupKey)) {
        teacherGroups.add(groupKey);
        const count=lesson.groupId ? sessions.filter(row=>row.groupId===lesson.groupId && row.startAt.getTime()===lesson.startAt.getTime() && row.endAt.getTime()===lesson.endAt.getTime()).length : 1;
        const teacherBody=count>1 ? `Sesi ${subjectNames.get(lesson.subjectId)??'belajar'} untuk ${count} siswa dijadwalkan pada ${time}. Mohon siapkan kegiatan belajar sesuai jadwal.` : body;
        // Keep the actual child occurrence as resourceId: audience validation
        // and deep links deliberately authorize a session, not a group UUID.
        for (const teacherId of teachers) events.push({ workspaceId, recipientAccountId: teacherId, title: 'Pengingat jadwal les', body:teacherBody, route: `/teacher/sessions/${lesson._id}`, eventKey: `lesson-reminder:${lesson._id}:${window.date}:teacher:${teacherId}` });
      }
      for (const parentId of recipients.parentIds) events.push({ workspaceId, recipientAccountId: parentId, title: 'Pengingat jadwal les', body, route: `/parent/sessions/${lesson._id}`, eventKey: `lesson-reminder:${lesson._id}:${window.date}:parent:${parentId}` });
      for (const studentId of recipients.studentIds) events.push({ workspaceId, recipientAccountId: studentId, title: 'Pengingat jadwal les', body, route: `/student/sessions/${lesson._id}`, eventKey: `lesson-reminder:${lesson._id}:${window.date}:student:${studentId}` });
      for (let index = firstEvent; index < events.length; index++) events[index].deliveryExpiresAt = window.start;
    }
    await this.events.deliverAfterCommit(await this.events.create(events));
  }

  private displayDate(date: string) {
    const [year, month, day] = date.split('-').map(Number);
    return new Intl.DateTimeFormat('id-ID', { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(year, month - 1, day)));
  }

  private async remindTuition(workspaceId: string, timezone: string, now: Date) {
    const local = this.parts(now, timezone);
    const today = `${local.year}-${String(local.month).padStart(2, '0')}-${String(local.day).padStart(2, '0')}`;
    const tomorrow = this.tomorrowWindow(now, timezone);
    const preferences = await this.db.collection('tutorPreferences').findOne({workspaceId}).lean();
    const forTeacher = preferences?.tuitionTeacherReminders !== false;
    const forParent = preferences?.tuitionParentReminders !== false;
    if (!forTeacher && !forParent) return;
    const teacherIds = forTeacher ? await this.events.teacherIds(workspaceId) : [];
    let after: string | undefined;
    while (true) {
      const fees = await this.db.collection('tuitionFees').find({workspaceId, status: 'unpaid',
        dueDate: forTeacher ? {$lte: tomorrow.date} : {$in: [today, tomorrow.date]}, ...(after ? {_id: {$gt: after}} : {})})
        .sort({_id: 1}).limit(200).lean();
      if (!fees.length) break;
      const students = await this.db.collection('students').find({workspaceId, status: 'active', _id: {$in: fees.map(fee => fee.studentId)}}).select('_id name').lean();
      const names = new Map(students.map(student => [student._id, student.name]));
      const events: NotificationEventInput[] = [];
      for (const fee of fees) {
        const name = names.get(fee.studentId);
        if (!name) continue;
        const amount = new Intl.NumberFormat('id-ID', {style: 'currency', currency: 'IDR', maximumFractionDigits: 0}).format(fee.amount);
        if (fee.dueDate <= today) {
          for (const teacherId of teacherIds) events.push({workspaceId, recipientAccountId: teacherId,
            title: `Cek biaya bimbel ${name}`,
            body: `Biaya bimbel ${name} sebesar ${amount}, jatuh tempo ${this.displayDate(fee.dueDate)}, masih tercatat belum lunas. Jika pembayaran sudah diterima, perbarui statusnya.`,
            route: `/teacher/students/${fee.studentId}?tab=tuition`,
            // Stable across fee revisions: at most one durable event per student/local day.
            eventKey: `tuition-check:${fee._id}:${today}:teacher:${teacherId}`,
            tuitionFeeVersion: fee.version, deliveryExpiresAt: tomorrow.start,
          });
        }
        if (!forParent || (fee.dueDate !== today && fee.dueDate !== tomorrow.date)) continue;
        const stage = fee.dueDate === today ? 'today' : 'tomorrow';
        const {parentIds} = await this.events.studentRecipients(workspaceId, fee.studentId);
        for (const parentId of parentIds) events.push({workspaceId, recipientAccountId: parentId,
          title: stage === 'today' ? 'Biaya bimbel jatuh tempo hari ini' : 'Pengingat biaya bimbel besok',
          body: `Biaya bimbel ${name} sebesar ${amount} jatuh tempo ${stage === 'today' ? 'hari ini' : 'besok'}, ${this.displayDate(fee.dueDate)}. Buka detail untuk menghubungi Guru.`,
          route: `/parent/students/${fee.studentId}?tab=tuition`,
          eventKey: `tuition-due:${fee._id}:${fee.version}:${fee.dueDate}:${stage}:parent:${parentId}`,
          deliveryExpiresAt: tomorrow.start,
        });
      }
      await this.events.deliverAfterCommit(await this.events.create(events));
      after = fees[fees.length - 1]._id;
      if (fees.length < 200) break;
    }
  }
}
