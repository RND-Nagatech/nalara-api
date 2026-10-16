import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { ScopedService } from '../../common/scoped.service';
import { Principal } from '../../common/api';
import { ListQuery } from '../../common/query.dto';
import { validateRange } from '../schedules/schedules.service';
import { PlanDto, ProgressDto, TargetDto, UpdateTargetDto } from './learning.dto';
import { aggregateProgress } from './progress.rules';
import { NotificationEventsService } from '../notifications/notification-events.service';
import type { NotificationEventInput } from '../notifications/notification-events.service';
@Injectable() export class LearningService {
  constructor(private readonly scope:ScopedService,private readonly notifications:NotificationEventsService) {}
  async plans(a:Principal,q:ListQuery) {
    const result=await this.scope.list('plans',a,q);
    const items=await Promise.all(result.items.map(async plan=>({...plan,...aggregateProgress(await this.scope.db.collection('targets').find({planId:plan._id,workspaceId:a.workspaceId}).lean())})));
    return {...result,items};
  }
  targets(a:Principal,q:ListQuery) { return this.scope.list('targets',a,q); }
  async plan(a:Principal,id:string) {
    const plan=await this.scope.get('plans',id,a);
    const targets=await this.scope.db.collection('targets').find({planId:id,workspaceId:a.workspaceId}).sort({createdAt:1}).lean();
    const student=await this.scope.get('students',plan.studentId,a),subject=await this.scope.get('subjects',plan.subjectId,a);
    return {...plan,studentName:student.name,subjectName:subject.name,targets,...aggregateProgress(targets)};
  }
  async createPlan(a:Principal,d:PlanDto) {
    await this.scope.activeStudent(d.studentId,a); await this.scope.get('subjects',d.subjectId,a);
    const startAt=new Date(d.startAt),endAt=new Date(d.endAt); validateRange(startAt,endAt);
    const {targets=[],...fields}=d;
    const result=await this.scope.db.connection.transaction(async session=>{
      const [plan]=await this.scope.db.collection('plans').create([{...fields,startAt,endAt,workspaceId:a.workspaceId}],{session});
      const created=[];
      for(const target of targets) { const [record]=await this.scope.db.collection('targets').create([{...target,planId:plan._id,studentId:plan.studentId,subjectId:plan.subjectId,workspaceId:a.workspaceId}],{session}); created.push(record.toObject()); }
      const recipients=await this.notifications.studentRecipients(a.workspaceId,plan.studentId,session);
      const events:NotificationEventInput[]=created.flatMap(target=>[
        ...recipients.parentIds.map(parentId=>({workspaceId:a.workspaceId,recipientAccountId:parentId,title:'Target belajar baru',body:`Target "${target.title}" telah ditambahkan untuk anak Anda.`,route:`/parent/plans/${plan._id}`,eventKey:`target-created:${target._id}:parent:${parentId}` })),
        ...recipients.studentIds.map(studentId=>({workspaceId:a.workspaceId,recipientAccountId:studentId,title:'Target belajar baru',body:`Target "${target.title}" telah ditambahkan untuk rencana belajar Anda.`,route:'/student/targets',eventKey:`target-created:${target._id}:student:${studentId}` })),
      ]);
      return {plan:plan.toObject(),targets:created,notificationIds:await this.notifications.create(events,session)};
    });
    await this.notifications.deliverAfterCommit(result.notificationIds);
    return {...result.plan,targets:result.targets,...aggregateProgress(result.targets)};
  }
  async addTarget(a:Principal,id:string,d:TargetDto) {
    const plan=await this.scope.get('plans',id,a); await this.scope.activeStudent(plan.studentId,a);
    const result=await this.scope.db.connection.transaction(async session=>{
      const [target]=await this.scope.db.collection('targets').create([{...d,workspaceId:a.workspaceId,planId:id,studentId:plan.studentId,subjectId:plan.subjectId}],{session});
      const recipients=await this.notifications.studentRecipients(a.workspaceId,plan.studentId,session);
      const events:NotificationEventInput[]=[
        ...recipients.parentIds.map(parentId=>({workspaceId:a.workspaceId,recipientAccountId:parentId,title:'Target belajar baru',body:`Target "${target.title}" telah ditambahkan untuk anak Anda.`,route:`/parent/plans/${id}`,eventKey:`target-created:${target._id}:parent:${parentId}` })),
        ...recipients.studentIds.map(studentId=>({workspaceId:a.workspaceId,recipientAccountId:studentId,title:'Target belajar baru',body:`Target "${target.title}" telah ditambahkan untuk rencana belajar Anda.`,route:'/student/targets',eventKey:`target-created:${target._id}:student:${studentId}` })),
      ];
      return {target:target.toObject(),notificationIds:await this.notifications.create(events,session)};
    });
    await this.notifications.deliverAfterCommit(result.notificationIds);
    return result.target;
  }
  async target(a:Principal,id:string) {
    const target=await this.scope.get('targets',id,a);
    const plan=await this.plan(a,target.planId);
    return {...target,studentName:plan.studentName,subjectName:plan.subjectName,plan:{_id:plan._id,title:plan.title,startAt:plan.startAt,endAt:plan.endAt,progress:plan.progress,targetCount:plan.targetCount}};
  }
  async update(a:Principal,id:string,d:UpdateTargetDto) {
    const target=await this.scope.get('targets',id,a);
    if(d.status==='active' && target.progress===100) throw new BadRequestException('Turunkan progress melalui form update untuk membuka target kembali');
    return this.scope.db.collection('targets').findOneAndUpdate({_id:id,workspaceId:a.workspaceId},{$set:d,$inc:{version:1}},{returnDocument: 'after',runValidators:true}).lean();
  }
  async updateProgress(a:Principal,id:string,d:ProgressDto) {
    const progressResult=await this.scope.db.connection.transaction(async session=>{
      const target=await this.scope.get('targets',id,a,session);
      if(target.status==='archived' || target.status==='cancelled') throw new BadRequestException('Target sudah diarsipkan atau dibatalkan');
      await this.scope.activeStudent(target.studentId,a,session);
      if(target.version!==d.version) throw new ConflictException('Target berubah. Muat ulang sebelum menyimpan.');
      if(d.sessionId) { const lesson=await this.scope.get('sessions',d.sessionId,a,session); if(lesson.studentId!==target.studentId || lesson.subjectId!==target.subjectId) throw new BadRequestException('Sesi harus sesuai siswa dan bidang belajar target'); }
      const updated=await this.scope.db.collection('targets').updateOne({_id:id,workspaceId:a.workspaceId,version:d.version},{$set:{progress:d.progress,status:d.progress===100?'completed':'active'},$inc:{version:1}},{session});
      if(updated.modifiedCount!==1) throw new ConflictException('Target berubah. Muat ulang.');
      const [history]=await this.scope.db.collection('histories').create([{workspaceId:a.workspaceId,targetId:id,planId:target.planId,studentId:target.studentId,before:target.progress,after:d.progress,note:d.note??'',visibility:d.visibility,actorId:a._id,sessionId:d.sessionId}],{session});
      await this.scope.audit(a,'target.progress.updated',id,session);
      // In-app delivery is the MVP provider. Its durable record commits with the event.
      // No network provider is called inside a transaction; push/email can later consume these records.
      if(d.visibility==='student' || d.visibility==='shared') {
        const recipients=await this.notifications.studentRecipients(a.workspaceId,target.studentId,session);
        const events:NotificationEventInput[]=[
          ...recipients.studentIds.map(studentId=>({workspaceId:a.workspaceId,recipientAccountId:studentId,title:'Progress belajar diperbarui',body:`${target.title}: ${target.progress}% → ${d.progress}%`,route:`/student/targets/${id}`,eventKey:`progress:${history._id}:student:${studentId}`})),
          ...(d.visibility==='shared' ? recipients.parentIds.map(parentId=>({workspaceId:a.workspaceId,recipientAccountId:parentId,title:'Progress belajar diperbarui',body:`${target.title}: ${target.progress}% → ${d.progress}%`,route:'/parent/targets',eventKey:`progress:${history._id}:parent:${parentId}`})) : []),
        ];
        return { notificationIds: await this.notifications.create(events,session) };
      }
      return { notificationIds: [] as string[] };
    });
    await this.notifications.deliverAfterCommit(progressResult.notificationIds);
    return this.target(a,id);
  }
  async history(a:Principal,id:string,q:ListQuery) { await this.scope.get('targets',id,a); return this.scope.list('histories',a,q,{targetId:id}); }
  async studentProgress(a:Principal,id:string,q:ListQuery) { await this.scope.get('students',id,a); return this.plans(a,{...q,studentId:id}); }
}
