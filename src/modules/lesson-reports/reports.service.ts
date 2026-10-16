import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ScopedService } from '../../common/scoped.service';
import { Principal } from '../../common/api';
import { ListQuery } from '../../common/query.dto';
import { ReportDto, UpdateReportDto } from './reports.dto';
import { NotificationEventsService } from '../notifications/notification-events.service';
import type { NotificationEventInput } from '../notifications/notification-events.service';
@Injectable() export class ReportsService {
  constructor(private readonly scope:ScopedService,private readonly notifications:NotificationEventsService) {}
  list(a:Principal,q:ListQuery) { return this.scope.list('reports',a,q); }
  async get(a:Principal,id:string) {
    const report=await this.scope.get('reports',id,a);
    return (await this.scope.teachingNames(a,[report]))[0];
  }
  private async targets(a:Principal,ids:string[],studentId:string,subjectId:string) {
    for(const id of ids) { const target=await this.scope.get('targets',id,a); if(target.studentId!==studentId || target.subjectId!==subjectId) throw new BadRequestException('Target laporan harus sesuai siswa dan bidang belajar sesi'); }
  }
  async create(a:Principal,sessionId:string,d:ReportDto) {
    const lesson=await this.scope.get('sessions',sessionId,a);
    if(lesson.status==='cancelled') throw new BadRequestException('Sesi dibatalkan');
    await this.targets(a,d.targetIds??[],lesson.studentId,lesson.subjectId);
    return this.scope.db.collection('reports').create({...d,workspaceId:a.workspaceId,sessionId,studentId:lesson.studentId});
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
      let notificationIds:string[]=[];
      if(report.visibility==='student' || report.visibility==='shared') {
        const recipients=await this.notifications.studentRecipients(a.workspaceId,lesson.studentId,session);
        const events:NotificationEventInput[]=[
          ...recipients.studentIds.map(studentId=>({
            workspaceId:a.workspaceId,
            recipientAccountId:studentId,
            title:'Laporan belajar baru',
            body:`Guru telah menerbitkan laporan belajar baru: ${report.topic}`,
            route:`/student/reports/${id}`,
            eventKey:`report:${id}:published:student:${studentId}`,
          })),
          ...(report.visibility==='shared' ? recipients.parentIds.map(parentId=>({
            workspaceId:a.workspaceId,
            recipientAccountId:parentId,
            title:'Laporan belajar baru',
            body:`Guru telah menerbitkan laporan belajar baru untuk anak Anda: ${report.topic}`,
            route:`/parent/reports/${id}`,
            eventKey:`report:${id}:published:parent:${parentId}`,
          })) : []),
        ];
        notificationIds=await this.notifications.create(events,session);
      }
      await this.scope.audit(a,'report.published',id,session);
      return {report:updated,notificationIds};
    });
    await this.notifications.deliverAfterCommit(result.notificationIds);
    return result.report;
  }
}
