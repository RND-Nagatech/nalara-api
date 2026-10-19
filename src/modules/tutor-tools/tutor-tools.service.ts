import { BadRequestException, Injectable } from '@nestjs/common';
import type { Principal } from '../../common/api';
import { ListQuery } from '../../common/query.dto';
import { ScopedService } from '../../common/scoped.service';
import { aggregateProgress } from '../learning-plans/progress.rules';
import { BrandingDto, PreferencesDto, TemplateDto } from './tutor-tools.dto';
import { BrandingLogoService } from './branding-logo.service';
import { renderReportPdf } from './report-pdf';

export function csvCell(value: unknown) {
  let text = value instanceof Date ? value.toISOString() : String(value ?? '');
  if (/^\s*[=+@-]/.test(text) || /^[\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}
@Injectable()
export class TutorToolsService {
  constructor(private readonly scope: ScopedService, private readonly logos: BrandingLogoService) {}
  async preferences(actor: Principal) {
    const row = await this.scope.db.collection('tutorPreferences').findOne({workspaceId: actor.workspaceId}).lean();
    if (!row) return {displayName: '', tagline: '', footer: '', accentColor: '#155D49', logoVersion: null, reminders: true, progress: true, reports: true, assignments: true};
    const {logoKey, ...preferences} = row;
    return {...preferences, logoVersion: logoKey ?? null};
  }
  async savePreferences(actor: Principal, dto: BrandingDto | PreferencesDto) {
    await this.scope.db.collection('tutorPreferences').findOneAndUpdate({workspaceId: actor.workspaceId}, {$set: dto, $setOnInsert: {workspaceId: actor.workspaceId}}, {upsert: true, returnDocument: 'after', runValidators: true, setDefaultsOnInsert: true}).lean();
    return this.preferences(actor);
  }
  templates(actor: Principal, q: ListQuery) { return this.scope.list('reportTemplates', actor, q); }
  async saveTemplate(actor: Principal, dto: TemplateDto, id?: string) {
    if (id) { await this.scope.get('reportTemplates', id, actor); return this.scope.db.collection('reportTemplates').findOneAndUpdate({_id: id, workspaceId: actor.workspaceId}, {$set: dto}, {returnDocument: 'after', runValidators: true}).lean(); }
    return this.scope.db.collection('reportTemplates').create({...dto, workspaceId: actor.workspaceId});
  }
  async removeTemplate(actor: Principal, id: string) { await this.scope.get('reportTemplates', id, actor); await this.scope.db.collection('reportTemplates').deleteOne({_id: id, workspaceId: actor.workspaceId}); return {deleted: true}; }
  async analytics(actor: Principal, q: ListQuery) {
    if (q.studentId) await this.scope.get('students', q.studentId, actor);
    const filter = {workspaceId: actor.workspaceId, ...(q.studentId ? {studentId: q.studentId} : {})};
    const now = new Date();
    const [targets, plans, subjects, histories, sessions] = await Promise.all([
      this.scope.db.collection('targets').find(filter).lean(), this.scope.db.collection('plans').find(filter).select('_id endAt').lean(),
      this.scope.db.collection('subjects').find({workspaceId: actor.workspaceId}).select('_id name').lean(),
      this.scope.db.collection('histories').find({...filter, ...(q.from || q.to ? {createdAt: {...(q.from ? {$gte: new Date(q.from)} : {}), ...(q.to ? {$lte: new Date(q.to)} : {})}} : {})}).sort({createdAt: -1}).limit(100).lean(),
      this.scope.db.collection('sessions').find({...filter, ...(q.from || q.to ? {startAt: {...(q.from ? {$gte: new Date(q.from)} : {}), ...(q.to ? {$lte: new Date(q.to)} : {})}} : {})}).select('attendance status').lean(),
    ]);
    const eligible = targets.filter(t => !['archived', 'cancelled'].includes(t.status));
    const deadlines = new Map(plans.map(p => [p._id, p.endAt]));
    const names = new Map(targets.map(t => [t._id, t.title]));
    return {generatedAt: now, ...aggregateProgress(targets), completed: eligible.filter(t => t.status === 'completed').length,
      overdue: eligible.filter(t => t.progress < 100 && (deadlines.get(t.planId)?.getTime() ?? Infinity) < now.getTime()).length,
      attendance: {present: sessions.filter(s => s.attendance === 'present').length, recorded: sessions.filter(s => s.attendance !== 'pending' && s.status !== 'cancelled').length},
      bySubject: subjects.map(subject => ({subjectId: subject._id, name: subject.name, ...aggregateProgress(targets.filter(t => t.subjectId === subject._id))})).filter(s => s.targetCount > 0),
      history: histories.map(h => ({_id: h._id, targetId: h.targetId, title: names.get(h.targetId) ?? 'Target belajar', before: h.before, after: h.after, createdAt: h.createdAt})),
      historyLimit: 100, periodNote: 'Progress menggunakan seluruh target aktif/selesai saat ini; arsip dan pembatalan tidak dihitung. Riwayat dan presensi mengikuti periode filter. Deadline mengikuti akhir rencana belajar.'};
  }
  async pdf(actor: Principal, reportId: string) {
    const report = await this.scope.get('reports', reportId, actor);
    const lesson = await this.scope.get('sessions', report.sessionId, actor);
    const [student, subject, branding, schedule] = await Promise.all([this.scope.get('students', report.studentId, actor),
      this.scope.get('subjects', lesson.subjectId, actor), this.preferences(actor), this.scope.get('schedules', lesson.scheduleId, actor)]);
    const logo = await this.logos.read(actor);
    const bytes = await renderReportPdf({report, lesson, student, subject, branding, teacherName: actor.name,
      timezone: schedule.timezone, logo: logo?.bytes});
    return {filename: `nalara-laporan-${reportId}.pdf`, mimeType: 'application/pdf', contentBase64: bytes.toString('base64')};
  }
  async export(actor: Principal) {
    const tables = [
      ['students', ['_id', 'name', 'grade', 'notes', 'status', 'familyId']], ['subjects', ['_id', 'name']],
      ['families', ['_id', 'name', 'parentName', 'parentPhone']],
      ['plans', ['_id', 'studentId', 'subjectId', 'title', 'startAt', 'endAt']],
      ['sessions', ['_id', 'studentId', 'subjectId', 'startAt', 'endAt', 'status', 'attendance']],
      ['targets', ['_id', 'planId', 'studentId', 'subjectId', 'title', 'description', 'successCriteria', 'priority', 'status', 'progress']],
      ['histories', ['_id', 'targetId', 'studentId', 'before', 'after', 'note', 'visibility', 'createdAt']],
      ['reports', ['_id', 'studentId', 'sessionId', 'topic', 'summary', 'observations', 'difficulties', 'homework', 'recommendation', 'visibility', 'status', 'publishedAt']],
      ['assignments', ['_id', 'studentId', 'subjectId', 'title', 'kind', 'content', 'dueAt', 'visibility', 'status']],
      ['submissions', ['_id', 'assignmentId', 'studentId', 'text', 'feedback', 'reviewedAt']],
      ['reportTemplates', ['_id', 'name', 'topic', 'summary', 'observations', 'difficulties', 'homework', 'recommendation']],
    ] as const;
    const files = [];
    for (const [table, columns] of tables) {
      const rows = await this.scope.db.collection(table).find({workspaceId: actor.workspaceId}).sort({createdAt: 1}).limit(5001).lean();
      if (rows.length > 5000) throw new BadRequestException('Export melebihi 5.000 data per jenis. Hubungi dukungan untuk export lengkap.');
      const csv = '\uFEFF' + [columns.map(csvCell).join(','), ...rows.map(row => columns.map(key => csvCell((row as unknown as Record<string, unknown>)[key])).join(','))].join('\r\n');
      files.push({filename: `nalara-${table}.csv`, mimeType: 'text/csv', contentBase64: Buffer.from(csv).toString('base64')});
    }
    await this.scope.audit(actor, 'workspace.data.exported', actor.workspaceId);
    return {generatedAt: new Date(), files};
  }
}
