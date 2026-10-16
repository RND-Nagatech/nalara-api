import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { QueryFilter } from 'mongoose';
import type { Principal } from '../../common/api';
import { ListQuery } from '../../common/query.dto';
import { ScopedService } from '../../common/scoped.service';
import type { Assignment, PortalAccount } from '../../database/entities';
import { NotificationEventsService } from '../notifications/notification-events.service';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { AssignmentDto, FeedbackDto, SubmissionDto } from './tutor-tools.dto';
@Injectable()
export class AssignmentsService {
  constructor(private readonly scope: ScopedService, private readonly subscriptions: SubscriptionsService, private readonly events: NotificationEventsService) {}
  async list(actor: Principal, q: ListQuery) { return this.scope.list('assignments', actor, q); }
  async get(actor: Principal, id: string) {
    const row = await this.scope.get('assignments', id, actor);
    const submissions = await this.scope.db.collection('submissions').find({workspaceId: actor.workspaceId, assignmentId: id}).lean();
    return {...(await this.scope.teachingNames(actor, [row]))[0], submissions};
  }
  async save(actor: Principal, dto: AssignmentDto, id?: string) {
    await this.subscriptions.requireFeature(actor.workspaceId, 'assignments');
    await this.scope.activeStudent(dto.studentId, actor); await this.scope.get('subjects', dto.subjectId, actor);
    const prior = id ? await this.scope.get('assignments', id, actor) : null;
    if (prior && (prior.studentId !== dto.studentId || prior.subjectId !== dto.subjectId || prior.kind !== dto.kind)) throw new BadRequestException('Siswa, bidang belajar, dan jenis tidak dapat diubah. Buat tugas baru untuk tujuan lain.');
    const result = await this.scope.db.connection.transaction(async session => {
      const fields = {...dto, dueAt: dto.kind === 'task' && dto.dueAt ? new Date(dto.dueAt) : undefined};
      const row = id ? await this.scope.db.collection('assignments').findOneAndUpdate({_id: id, workspaceId: actor.workspaceId}, {$set: fields, ...(!fields.dueAt ? {$unset: {dueAt: ''}} : {})}, {session, returnDocument: 'after', runValidators: true}).lean()
        : (await this.scope.db.collection('assignments').create([{...fields, workspaceId: actor.workspaceId}], {session}))[0].toObject();
      if (!row) throw new NotFoundException('Tugas tidak ditemukan.');
      let notificationIds: string[] = [];
      if (dto.status === 'published' && prior?.status !== 'published') {
        const recipients = await this.events.studentRecipients(actor.workspaceId, row.studentId, session);
        notificationIds = await this.events.create([
          ...recipients.studentIds.map(recipientAccountId => ({workspaceId: actor.workspaceId, recipientAccountId, title: dto.kind === 'task' ? 'Tugas belajar baru' : 'Materi belajar baru', body: `Guru membagikan ${dto.kind === 'task' ? 'tugas' : 'materi'}: ${row.title}.`, route: `/student/assignments/${row._id}`, eventKey: `assignment:${row._id}:student:${recipientAccountId}`})),
          ...(dto.visibility === 'shared' ? recipients.parentIds.map(recipientAccountId => ({workspaceId: actor.workspaceId, recipientAccountId, title: 'Aktivitas belajar baru', body: `Guru membagikan aktivitas belajar untuk anak Anda: ${row.title}.`, route: `/parent/assignments/${row._id}`, eventKey: `assignment:${row._id}:parent:${recipientAccountId}`})) : []),
        ], session);
      }
      await this.scope.audit(actor, id ? 'assignment.updated' : 'assignment.created', row._id, session);
      return {id: row._id, notificationIds};
    });
    await this.events.deliverAfterCommit(result.notificationIds);
    return this.get(actor, result.id);
  }
  private async portalStudents(account: PortalAccount) {
    const filter = {workspaceId: account.workspaceId, status: 'active' as const, ...(account.role === 'student' ? {_id: account.studentId ?? 'invalid'} : {familyId: account.familyId ?? 'invalid'})};
    return (await this.scope.db.collection('students').find(filter).select('_id').lean()).map(row => row._id);
  }
  private portalAssignmentFilter(account: PortalAccount, studentIds: string[]): QueryFilter<Assignment> {
    return {
      workspaceId: account.workspaceId,
      studentId: {$in: studentIds},
      status: 'published',
      visibility: account.role === 'parent' ? 'shared' : {$in: ['student', 'shared']},
    };
  }
  async portalList(account: PortalAccount, q: ListQuery) {
    const ids = await this.portalStudents(account);
    if (q.studentId && !ids.includes(q.studentId)) throw new NotFoundException('Siswa tidak ditemukan.');
    const filter = this.portalAssignmentFilter(account, q.studentId ? [q.studentId] : ids);
    const [items, total] = await Promise.all([this.scope.db.collection('assignments').find(filter).sort({createdAt: -1}).skip((q.page - 1) * q.limit).limit(q.limit).lean(), this.scope.db.collection('assignments').countDocuments(filter)]);
    const names = await this.scope.teachingNames({workspaceId: account.workspaceId}, items);
    return {items: names, total, page: q.page, limit: q.limit};
  }
  async portalGet(account: PortalAccount, id: string) {
    const ids = await this.portalStudents(account);
    const row = await this.scope.db.collection('assignments').findOne({...this.portalAssignmentFilter(account, ids), _id: id}).lean();
    if (!row) throw new NotFoundException('Aktivitas belajar tidak ditemukan.');
    const submissions = await this.scope.db.collection('submissions').find({workspaceId: account.workspaceId, assignmentId: id, studentId: row.studentId}).lean();
    return {...row, submissions};
  }
  async submit(account: PortalAccount, id: string, dto: SubmissionDto) {
    if (account.role !== 'student') throw new NotFoundException('Akses siswa diperlukan.');
    await this.subscriptions.requireFeature(account.workspaceId, 'assignments');
    const row = await this.portalGet(account, id);
    if (row.kind !== 'task') throw new BadRequestException('Materi tidak memerlukan pengumpulan jawaban.');
    const filter = {workspaceId: account.workspaceId, assignmentId: id, studentId: row.studentId};
    const existing = await this.scope.db.collection('submissions').findOne(filter).lean();
    if (!existing) {
      if (dto.version !== 0) throw new ConflictException('Muat ulang jawaban sebelum menyimpan.');
      try { return (await this.scope.db.collection('submissions').create({...filter, text: dto.text, version: 1})).toObject(); }
      catch (error) { if ((error as {code?: number}).code === 11000) throw new ConflictException('Jawaban sudah tersimpan. Muat ulang halaman.'); throw error; }
    }
    const updated = await this.scope.db.collection('submissions').findOneAndUpdate({...filter, version: dto.version, reviewedAt: {$exists: false}}, {$set: {text: dto.text}, $inc: {version: 1}}, {returnDocument: 'after'}).lean();
    if (!updated) throw new ConflictException('Jawaban telah berubah atau sudah ditinjau Guru. Muat ulang halaman.');
    return updated;
  }
  async feedback(actor: Principal, id: string, dto: FeedbackDto) {
    const row = await this.scope.db.collection('submissions').findOneAndUpdate({_id: id, workspaceId: actor.workspaceId, version: dto.version}, {$set: {feedback: dto.feedback, reviewedAt: new Date()}, $inc: {version: 1}}, {returnDocument: 'after'}).lean();
    if (!row) throw new ConflictException('Jawaban tidak ditemukan atau telah berubah. Muat ulang halaman.');
    return row;
  }
}
