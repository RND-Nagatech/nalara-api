import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { ScopedService } from '../../common/scoped.service';
import { Principal } from '../../common/api';
import { ListQuery } from '../../common/query.dto';
import { AttendanceDto, ScheduleDto, UpdateScheduleDto, UpdateSessionDto } from './schedules.dto';
import { NotificationEventsService } from '../notifications/notification-events.service';
import type { NotificationEventInput } from '../notifications/notification-events.service';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { lockCalendar, requireFreeSlot } from '../../common/calendar-lock';
export function validateRange(start:Date,end:Date,maxHours?:number) {
  if (end <= start || (maxHours && end.getTime()-start.getTime()>maxHours*3600_000)) throw new BadRequestException('Waktu selesai harus setelah mulai dan durasi harus wajar');
}
// Keep the same local wall time even across DST boundaries.
export function nextWeekly(date:Date,timezone:string,week:number):Date {
  const local = (value:Date) => Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(value).filter(x=>x.type!=='literal').map(x=>[x.type,Number(x.value)]));
  const p=local(date);
  const target=Date.UTC(p.year,p.month-1,p.day+7*week,p.hour,p.minute,p.second);
  let result=new Date(date.getTime()+7*week*86400_000);
  for(let i=0;i<3;i++) { const q=local(result); const current=Date.UTC(q.year,q.month-1,q.day,q.hour,q.minute,q.second); result=new Date(result.getTime()+target-current); }
  return result;
}
@Injectable() export class SchedulesService {
  constructor(private readonly scope:ScopedService,private readonly notifications:NotificationEventsService,private readonly subscriptions:SubscriptionsService) {}
  list(a:Principal,q:ListQuery) { return this.scope.list('schedules',a,q); }
  sessions(a:Principal,q:ListQuery) { return this.scope.list('sessions',a,q); }
  async get(a:Principal,id:string) {
    const schedule=await this.scope.get('schedules',id,a);
    return (await this.scope.teachingNames(a,[schedule]))[0];
  }
  async session(a:Principal,id:string) {
    const lesson=await this.scope.get('sessions',id,a);
    return (await this.scope.teachingNames(a,[lesson]))[0];
  }
  async create(a:Principal,d:ScheduleDto) {
    if(d.recurrence==='weekly') await this.subscriptions.requireFeature(a.workspaceId,'recurringSchedules');
    await this.scope.activeStudent(d.studentId,a); await this.scope.get('subjects',d.subjectId,a);
    const startAt=new Date(d.startAt),endAt=new Date(d.endAt); validateRange(startAt,endAt,12);
    const repeatCount=d.recurrence==='weekly' ? d.repeatCount ?? 4 : 1;
    return this.scope.db.connection.transaction(async session => {
      await lockCalendar(this.scope.db, a.workspaceId, session);
      const [schedule]=await this.scope.db.collection('schedules').create([{...d,startAt,endAt,repeatCount,workspaceId:a.workspaceId}],{session});
      for(let i=0;i<repeatCount;i++) {
        const occurrenceStart = nextWeekly(startAt,d.timezone,i), occurrenceEnd = nextWeekly(endAt,d.timezone,i);
        await requireFreeSlot(this.scope.db, a.workspaceId, occurrenceStart, occurrenceEnd, session);
        await this.scope.db.collection('sessions').create([{workspaceId:a.workspaceId,scheduleId:schedule._id,studentId:d.studentId,subjectId:d.subjectId,startAt:occurrenceStart,endAt:occurrenceEnd}],{session});
      }
      return schedule;
    });
  }
  async update(a:Principal,id:string,d:UpdateScheduleDto) {
    const current=await this.get(a,id);
    if (d.recurrence || d.repeatCount || d.startAt || d.endAt || d.studentId || d.subjectId || d.timezone) throw new BadRequestException('Ubah pertemuan melalui detail sesi. Untuk pola seri baru, buat jadwal baru.');
    return this.scope.db.connection.transaction(async session=>{
      await lockCalendar(this.scope.db, a.workspaceId, session);
      const schedule=await this.scope.db.collection('schedules').findOneAndUpdate({_id:id,workspaceId:a.workspaceId},{$set:d},{returnDocument: 'after',session});
      if (d.status==='cancelled' && current.status!=='cancelled') await this.scope.db.collection('sessions').updateMany({scheduleId:id,workspaceId:a.workspaceId,status:'scheduled'},{$set:{status:'cancelled',attendance:'cancelled'}},{session});
      return schedule;
    });
  }
  async updateSession(a:Principal,id:string,d:UpdateSessionDto) {
    if(d.startAt || d.endAt) await this.subscriptions.requireFeature(a.workspaceId,'reschedule');
    return this.scope.db.connection.transaction(async session => {
      await lockCalendar(this.scope.db, a.workspaceId, session);
      const current=await this.scope.get('sessions',id,a,session);
      if(current.status==='completed') throw new BadRequestException('Sesi selesai tidak dapat dijadwalkan ulang');
      const startAt=d.startAt ? new Date(d.startAt) : current.startAt,endAt=d.endAt ? new Date(d.endAt) : current.endAt;
      validateRange(startAt,endAt,12);
      if ((d.status ?? current.status) !== 'cancelled') await requireFreeSlot(this.scope.db, a.workspaceId, startAt, endAt, session, id);
      return this.scope.db.collection('sessions').findOneAndUpdate({_id:id,workspaceId:a.workspaceId},{$set:{...d,startAt,endAt,...(d.status==='cancelled'?{attendance:'cancelled'}:{})}},{session,returnDocument: 'after',runValidators:true}).lean();
    });
  }
  async attendance(a:Principal,id:string,d:AttendanceDto) {
    const current=await this.session(a,id);
    if(current.attendance!=='pending') throw new ConflictException('Presensi sudah dikunci dan tidak dapat diubah.');
    if(current.status==='cancelled' && d.attendance!=='cancelled') throw new BadRequestException('Sesi dibatalkan');
    const result=await this.scope.db.connection.transaction(async session=>{
      await lockCalendar(this.scope.db, a.workspaceId, session);
      const updated=await this.scope.db.collection('sessions').findOneAndUpdate(
        {_id:id,workspaceId:a.workspaceId,attendance:'pending'},
        {$set:{attendance:d.attendance,status:d.attendance==='cancelled'?'cancelled':'completed'}},
        {returnDocument: 'after',session}
      ).lean();
      if(!updated) throw new ConflictException('Presensi sudah dikunci dan tidak dapat diubah.');
      if(d.attendance!=='present') return {updated,notificationIds:[] as string[]};
      const [student,subject,recipients]=await Promise.all([
        this.scope.db.collection('students').findOne({_id:updated.studentId,workspaceId:a.workspaceId}).select('name').session(session).lean(),
        this.scope.db.collection('subjects').findOne({_id:updated.subjectId,workspaceId:a.workspaceId}).select('name').session(session).lean(),
        this.notifications.studentRecipients(a.workspaceId,updated.studentId,session),
      ]);
      const events:NotificationEventInput[]=recipients.parentIds.map(parentId=>({
        workspaceId:a.workspaceId,
        recipientAccountId:parentId,
        title:'Kehadiran anak tercatat',
        body:`${student?.name??'Siswa'} tercatat hadir pada sesi ${subject?.name??'belajar'} yang dijadwalkan.`,
        route:`/parent/sessions/${id}`,
        eventKey:`attendance:${id}:present:${parentId}`,
      }));
      return {updated,notificationIds:await this.notifications.create(events,session)};
    });
    await this.notifications.deliverAfterCommit(result.notificationIds);
    return result.updated;
  }
}
