import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { ClientSession } from 'mongoose';
import { ScopedService } from '../../common/scoped.service';
import { Principal } from '../../common/api';
import { ListQuery } from '../../common/query.dto';
import { BatchReportDto, ReportDto, UpdateReportDto } from './reports.dto';
import { NotificationEventsService } from '../notifications/notification-events.service';
import type { NotificationEventInput } from '../notifications/notification-events.service';
import { occurrenceMembers } from '../schedules/schedule-groups';
import { lockCalendar } from '../../common/calendar-lock';
import type { LessonReport } from '../../database/entities';
@Injectable() export class ReportsService {
  constructor(private readonly scope:ScopedService,private readonly notifications:NotificationEventsService) {}
  async list(a:Principal,q:ListQuery) {
    if(!q.sessionId) return this.scope.list('reports',a,q);
    const lesson=await this.scope.get('sessions',q.sessionId,a);
    const members=await this.scope.db.collection('sessions').find(occurrenceMembers(lesson)).select('_id').lean();
    return this.scope.list('reports',a,{...q,sessionId:undefined},{sessionId:{$in:members.map(row=>row._id)}});
  }
  async get(a:Principal,id:string) {
    const report=await this.scope.get('reports',id,a);
    return (await this.scope.teachingNames(a,[report]))[0];
  }
  private async targets(a:Principal,ids:string[],studentId:string,subjectId:string,session?:ClientSession) {
    for(const id of ids) { const target=await this.scope.get('targets',id,a,session); if(target.studentId!==studentId || target.subjectId!==subjectId) throw new BadRequestException('Target laporan harus sesuai siswa dan bidang belajar sesi'); }
  }
  async create(a:Principal,sessionId:string,d:ReportDto) {
    const lesson=await this.scope.get('sessions',sessionId,a);
    if(lesson.status==='cancelled') throw new BadRequestException('Sesi dibatalkan');
    await this.targets(a,d.targetIds??[],lesson.studentId,lesson.subjectId);
    return this.scope.db.collection('reports').create({...d,workspaceId:a.workspaceId,sessionId,studentId:lesson.studentId});
  }
  async createBatch(a:Principal,sessionId:string,d:BatchReportDto) {
    if(!Array.isArray(d.entries) || !d.entries.length || d.entries.length>100 ||
      new Set(d.entries.map(entry=>entry?.sessionId)).size!==d.entries.length) {
      throw new BadRequestException('Pilih 1–100 siswa yang berbeda');
    }
    const result=await this.scope.db.connection.transaction(async session=>{
      await lockCalendar(this.scope.db,a.workspaceId,session);
      const anchor=await this.scope.get('sessions',sessionId,a,session);
      const members=await this.scope.db.collection('sessions').find(occurrenceMembers(anchor)).session(session).lean();
      const lessons=d.entries.map(entry=>{
        const lesson=members.find(member=>member._id===entry.sessionId && member.subjectId===anchor.subjectId);
        if(!lesson) throw new NotFoundException('Siswa harus berasal dari pertemuan yang sama');
        if(lesson.status==='cancelled') throw new BadRequestException('Sesi siswa dibatalkan');
        return lesson;
      });
      // Validate every recipient and private target before writing anything.
      for(let index=0;index<lessons.length;index++) {
        const lesson=lessons[index];
        await this.targets(a,d.entries[index].targetIds??[],lesson.studentId,lesson.subjectId,session);
      }
      const exists=await this.scope.db.collection('reports').exists({workspaceId:a.workspaceId,sessionId:{$in:lessons.map(lesson=>lesson._id)}}).session(session);
      if(exists) throw new ConflictException('Sebagian siswa sudah memiliki laporan pada sesi ini. Muat ulang sesi dan pilih siswa yang belum memiliki laporan.');
      const {entries,status,...content}=d;
      const items:LessonReport[]=[];
      const notificationIds:string[]=[];
      for(let index=0;index<lessons.length;index++) {
        const lesson=lessons[index];
        const [created]=await this.scope.db.collection('reports').create([{
          ...content,workspaceId:a.workspaceId,sessionId:lesson._id,studentId:lesson.studentId,
          targetIds:entries[index].targetIds??[],status,...(status==='published'?{publishedAt:new Date()}:{}),
        }],{session});
        const report=created.toObject();
        items.push(report);
        await this.scope.audit(a,'report.created',report._id,session);
        if(status==='published') {
          notificationIds.push(...await this.publishedNotifications(a,report,session));
          await this.scope.audit(a,'report.published',report._id,session);
        }
      }
      return {items,total:items.length,notificationIds};
    });
    await this.notifications.deliverAfterCommit(result.notificationIds);
    return {items:result.items,total:result.total};
  }

  private async publishedNotifications(a:Principal,report:LessonReport,session:ClientSession) {
    if(report.visibility!=='student' && report.visibility!=='shared') return [];
    const recipients=await this.notifications.studentRecipients(a.workspaceId,report.studentId,session);
    const events:NotificationEventInput[]=[
      ...recipients.studentIds.map(studentId=>({
        workspaceId:a.workspaceId,recipientAccountId:studentId,title:'Laporan belajar baru',
        body:`Guru telah menerbitkan laporan belajar baru: ${report.topic}`,
        route:`/student/reports/${report._id}`,eventKey:`report:${report._id}:published:student:${studentId}`,
      })),
      ...(report.visibility==='shared'?recipients.parentIds.map(parentId=>({
        workspaceId:a.workspaceId,recipientAccountId:parentId,title:'Laporan belajar baru',
        body:`Guru telah menerbitkan laporan belajar baru untuk anak Anda: ${report.topic}`,
        route:`/parent/reports/${report._id}`,eventKey:`report:${report._id}:published:parent:${parentId}`,
      })):[]),
    ];
    return this.notifications.create(events,session);
  }
  async update(a:Principal,sessionId:string,id:string,d:UpdateReportDto) {
    const report=await this.get(a,id); if(report.sessionId!==sessionId) throw new NotFoundException('Laporan tidak ditemukan');
    if(report.status==='published') throw new BadRequestException('Laporan terbit tidak dapat diubah');
    const lesson=await this.scope.get('sessions',sessionId,a); await this.targets(a,d.targetIds??[],lesson.studentId,lesson.subjectId);
    return this.scope.db.collection('reports').findOneAndUpdate({_id:id,workspaceId:a.workspaceId,status:'draft'},{$set:d},{returnDocument: 'after',runValidators:true}).lean();
  }
  async publish(a:Principal,sessionId:string,id:string) {
    const result=await this.scope.db.connection.transaction(async session=>{
      const report=await this.scope.get('reports',id,a,session);
      if(report.sessionId!==sessionId) throw new NotFoundException('Laporan tidak ditemukan');
      if(report.status==='published') return {report,notificationIds:[] as string[]};
      const lesson=await this.scope.get('sessions',sessionId,a,session);
      if(lesson.status==='cancelled') throw new BadRequestException('Sesi dibatalkan');
      const updated=await this.scope.db.collection('reports').findOneAndUpdate({_id:id,workspaceId:a.workspaceId,status:'draft'},{$set:{status:'published',publishedAt:new Date()}},{returnDocument: 'after',session}).lean();
      const notificationIds=await this.publishedNotifications(a,report,session);
      await this.scope.audit(a,'report.published',id,session);
      return {report:updated,notificationIds};
    });
    await this.notifications.deliverAfterCommit(result.notificationIds);
    return result.report;
  }
}
