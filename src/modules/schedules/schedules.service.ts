import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { ClientSession } from 'mongoose';
import type { LessonSession, Schedule } from '../../database/entities';
import { ScopedService } from '../../common/scoped.service';
import { Principal } from '../../common/api';
import { ListQuery } from '../../common/query.dto';
import { AttendanceDto, BatchAttendanceDto, RepeatScheduleDto, ScheduleDto, UpdateScheduleDto, UpdateSessionDto } from './schedules.dto';
import { NotificationEventsService } from '../notifications/notification-events.service';
import type { NotificationEventInput } from '../notifications/notification-events.service';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { lockCalendar, requireFreeSlot } from '../../common/calendar-lock';
import { groupPipeline, namedGroups, occurrenceMembers } from './schedule-groups';
import { repeatOccurrences, localWeekday } from './repeat-rules';
export function requireCancellationReason(status:string|undefined,reason:unknown):string|undefined {
  if(status!=='cancelled') {
    if(reason!==undefined) throw new BadRequestException('Alasan pembatalan hanya untuk sesi atau seri yang dibatalkan.');
    return undefined;
  }
  if(typeof reason!=='string' || reason.trim().length<3 || reason.trim().length>500) throw new BadRequestException('Alasan pembatalan wajib diisi, 3–500 karakter.');
  return reason.trim();
}
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
  list(a:Principal,q:ListQuery) { return this.groupedList(a,q,false); }
  sessions(a:Principal,q:ListQuery) { return this.groupedList(a,q,true); }
  private async groupedList(a:Principal,q:ListQuery,sessions:boolean) {
    // Student-specific histories/progress keep their original individual rows.
    const name=sessions ? 'sessions' : 'schedules';
    if(q.studentId) return this.scope.list(name,a,q);
    const filter:Record<string,unknown>={workspaceId:a.workspaceId};
    if(q.from || q.to) filter.startAt={...(q.from?{$gte:new Date(q.from)}:{}),...(q.to?{$lte:new Date(q.to)}:{})};
    if(sessions && q.scheduleId) {
      const schedule=await this.scope.get('schedules',q.scheduleId,a);
      const siblings=await this.scope.db.collection('schedules').find(schedule.groupId ? {workspaceId:a.workspaceId,groupId:schedule.groupId} : {workspaceId:a.workspaceId,_id:schedule._id}).lean();
      filter.scheduleId={$in:siblings.map(row=>row._id)};
    }
    const pipeline=groupPipeline(filter,sessions);
    if(q.status) pipeline.push({$match:{'row.status':q.status}});
    pipeline.push({$facet:{items:[{$skip:(q.page-1)*q.limit},{$limit:q.limit}],total:[{$count:'count'}]}});
    const [result]=await this.scope.db.collection(name).aggregate<{items:{row:Schedule|LessonSession;members:(Schedule|LessonSession)[]}[];total:{count:number}[]}>(pipeline).option({maxTimeMS:10000});
    return {items:await namedGroups(this.scope,a.workspaceId,result?.items??[]),total:result?.total[0]?.count??0,page:q.page,limit:q.limit};
  }
  async get(a:Principal,id:string) {
    const schedule=await this.scope.get('schedules',id,a);
    const members=await this.scope.db.collection('schedules').find(schedule.groupId ? {workspaceId:a.workspaceId,groupId:schedule.groupId} : {workspaceId:a.workspaceId,_id:id}).sort({_id:1}).lean();
    const next=await this.scope.db.collection('sessions').findOne({workspaceId:a.workspaceId,scheduleId:{$in:members.map(row=>row._id)},status:'scheduled',attendance:'pending',startAt:{$gte:new Date()}}).sort({startAt:1}).lean();
    return {...(await namedGroups(this.scope,a.workspaceId,[{row:schedule,members}]))[0],nextStartAt:next?.startAt??null,nextEndAt:next?.endAt??null};
  }
  async session(a:Principal,id:string) {
    const lesson=await this.scope.get('sessions',id,a);
    const members=await this.scope.db.collection('sessions').find(occurrenceMembers(lesson)).sort({_id:1}).lean();
    if(!members.some(member=>member._id===id)) throw new ConflictException('Jadwal baru saja berubah. Muat ulang sesi.');
    return (await namedGroups(this.scope,a.workspaceId,[{row:lesson,members}]))[0];
  }
  async create(a:Principal,d:ScheduleDto) {
    if(d.recurrence==='weekly') await this.subscriptions.requireFeature(a.workspaceId,'recurringSchedules');
    return this.scope.db.connection.transaction(async session => {
      await lockCalendar(this.scope.db, a.workspaceId, session);
      return this.createSeries(a,d,session);
    });
  }
  private async createSeries(a:Principal,d:ScheduleDto,session:ClientSession) {
    if(d.studentId && d.studentIds) throw new BadRequestException('Gunakan studentIds atau studentId, bukan keduanya.');
    const studentIds=d.studentIds ?? (d.studentId ? [d.studentId] : []);
    if(!studentIds.length || studentIds.length>100 || new Set(studentIds).size!==studentIds.length) throw new BadRequestException('Pilih 1–100 siswa berbeda untuk jadwal.');
    const startAt=new Date(d.startAt),endAt=new Date(d.endAt); validateRange(startAt,endAt,12);
    const repeatCount=d.recurrence==='weekly' ? d.repeatCount ?? 4 : 1;
    if ((d.repeatEnd || d.repeatDays || d.repeatUntil) && d.recurrence!=='weekly') throw new BadRequestException('Pengaturan hari hanya untuk jadwal berulang.');
    if ((d.repeatDays || d.repeatUntil) && !d.repeatEnd) throw new BadRequestException('Pilih akhir pengulangan jadwal.');
    const planned=d.repeatEnd ? repeatOccurrences({...d,startAt,endAt,repeatCount}) : null;
    if(planned && !planned.slots.length) throw new BadRequestException('Tidak ada hari terpilih sebelum tanggal akhir. Periksa pengulangan.');
    const slots=planned?.slots ?? Array.from({length:repeatCount},(_,i)=>({startAt:nextWeekly(startAt,d.timezone,i),endAt:nextWeekly(endAt,d.timezone,i)}));
    const {slots:_slots,...progress}=planned ?? {slots:[]};
    const pattern=d.repeatEnd ? {repeatDays:d.repeatDays,repeatEnd:d.repeatEnd,repeatUntil:d.repeatUntil,...progress,nextExpansionAt:new Date(Date.now()+3600_000)} : {};
      for(const studentId of studentIds) await this.scope.activeStudent(studentId,a,session);
      await this.scope.get('subjects',d.subjectId,a,session);
      const groupId=studentIds.length>1 ? randomUUID() : undefined;
      const schedules:Schedule[]=[];
      for(const studentId of studentIds) {
        const [schedule]=await this.scope.db.collection('schedules').create([{studentId,subjectId:d.subjectId,timezone:d.timezone,recurrence:d.recurrence??'none',startAt:slots[0].startAt,endAt:slots[0].endAt,repeatCount,workspaceId:a.workspaceId,...pattern,...(groupId?{groupId}:{})}],{session});
        schedules.push(schedule.toObject());
      }
      for(const {startAt:occurrenceStart,endAt:occurrenceEnd} of slots) {
        await requireFreeSlot(this.scope.db, a.workspaceId, occurrenceStart, occurrenceEnd, session);
        const occurrenceGroupId=groupId ? randomUUID() : undefined;
        await this.scope.db.collection('sessions').create(schedules.map(schedule=>({workspaceId:a.workspaceId,scheduleId:schedule._id,studentId:schedule.studentId,subjectId:d.subjectId,startAt:occurrenceStart,endAt:occurrenceEnd,...(occurrenceGroupId?{groupId:occurrenceGroupId}:{})})),{session,ordered:true});
      }
      return {...schedules[0],participantCount:schedules.length};
  }
  async update(a:Principal,id:string,d:UpdateScheduleDto) {
    if (Object.keys(d).some(key=>!['status','cancellationReason'].includes(key))) throw new BadRequestException('Ubah pola melalui pengaturan pengulangan jadwal.');
    const reason=requireCancellationReason(d.status,d.cancellationReason);
    return this.scope.db.connection.transaction(async session=>{
      await lockCalendar(this.scope.db, a.workspaceId, session);
      const current=await this.scope.get('schedules',id,a,session);
      if(current.status==='cancelled' && d.status==='scheduled') throw new BadRequestException('Seri dibatalkan tidak dapat diaktifkan kembali.');
      const filter=current.groupId ? {workspaceId:a.workspaceId,groupId:current.groupId} : {workspaceId:a.workspaceId,_id:id};
      const schedules=await this.scope.db.collection('schedules').find(filter).session(session).lean();
      if(d.status==='cancelled') {
        await this.scope.db.collection('schedules').updateMany({...filter,status:'scheduled'},{$set:{status:'cancelled',recurrenceComplete:true,cancellationReason:reason}},{session,runValidators:true});
        await this.scope.db.collection('sessions').updateMany({scheduleId:{$in:schedules.map(row=>row._id)},workspaceId:a.workspaceId,status:'scheduled',attendance:'pending'},{$set:{status:'cancelled',attendance:'cancelled',cancellationReason:reason}},{session,runValidators:true});
        return {...current,status:'cancelled',cancellationReason:current.status==='cancelled'?current.cancellationReason:reason};
      }
      await this.scope.db.collection('schedules').updateMany(filter,{$set:d},{session,runValidators:true});
      return {...current,...d};
    });
  }
  async updateSession(a:Principal,id:string,d:UpdateSessionDto) {
    const reason=requireCancellationReason(d.status,d.cancellationReason);
    if(d.status==='cancelled' && (d.startAt || d.endAt)) throw new BadRequestException('Pisahkan pembatalan dari perubahan waktu pertemuan.');
    if(d.scope==='following') return this.updateFollowing(a,id,d);
    if(d.startAt || d.endAt) await this.subscriptions.requireFeature(a.workspaceId,'reschedule');
    return this.scope.db.connection.transaction(async session => {
      await lockCalendar(this.scope.db, a.workspaceId, session);
      const current=await this.scope.get('sessions',id,a,session);
      const members=await this.scope.db.collection('sessions').find(occurrenceMembers(current)).session(session).lean();
      if(members.some(row=>row.status==='completed')) throw new BadRequestException('Sesi dengan presensi tersimpan tidak dapat diubah.');
      if((members.every(row=>row.status==='cancelled') && d.status!=='cancelled') || (d.status==='scheduled' && members.some(row=>row.status==='cancelled'))) throw new BadRequestException('Sesi dibatalkan tidak dapat diaktifkan kembali.');
      if(d.status==='cancelled') {
        await this.scope.db.collection('sessions').updateMany({workspaceId:a.workspaceId,_id:{$in:members.map(row=>row._id)},status:'scheduled',attendance:'pending'},{$set:{status:'cancelled',attendance:'cancelled',cancellationReason:reason}},{session,runValidators:true});
        return {...current,status:'cancelled',attendance:'cancelled',cancellationReason:current.status==='cancelled'?current.cancellationReason:reason};
      }
      const startAt=d.startAt ? new Date(d.startAt) : current.startAt,endAt=d.endAt ? new Date(d.endAt) : current.endAt;
      validateRange(startAt,endAt,12);
      if (members.some(row=>row.status==='scheduled')) await requireFreeSlot(this.scope.db, a.workspaceId, startAt, endAt, session, members.map(row=>row._id));
      const {scope:_scope,...fields}=d;
      await this.scope.db.collection('sessions').updateMany({workspaceId:a.workspaceId,_id:{$in:members.map(row=>row._id)}},{$set:{...fields,startAt,endAt}},{session,runValidators:true});
      return {...current,...d,startAt,endAt};
    });
  }
  // Split into a continuation series; never delete or rewrite historical rows.
  async changeRepeat(a:Principal,id:string,d:RepeatScheduleDto) {
    await this.subscriptions.requireFeature(a.workspaceId,'recurringSchedules');
    return this.scope.db.connection.transaction(async session=>{
      await lockCalendar(this.scope.db,a.workspaceId,session);
      const current=await this.scope.get('schedules',id,a,session);
      const members=await this.scope.db.collection('schedules').find(current.groupId?{workspaceId:a.workspaceId,groupId:current.groupId}:{workspaceId:a.workspaceId,_id:id}).session(session).lean();
      const next=await this.scope.db.collection('sessions').findOne({workspaceId:a.workspaceId,scheduleId:{$in:members.map(row=>row._id)},status:'scheduled',attendance:'pending',startAt:{$gte:new Date()}}).sort({startAt:1}).session(session).lean();
      if(current.status!=='scheduled') throw new BadRequestException('Pengulangan sudah dihentikan.');
      const from=next?.startAt??new Date();
      if(new Date(d.startAt)<from) throw new BadRequestException('Tanggal pola baru tidak boleh sebelum pertemuan berikutnya.');
      return this.continueSeries(a,current,from,d,session);
    });
  }
  private async updateFollowing(a:Principal,id:string,d:UpdateSessionDto) {
    if(d.startAt || d.endAt) {
      await this.subscriptions.requireFeature(a.workspaceId,'reschedule');
      await this.subscriptions.requireFeature(a.workspaceId,'recurringSchedules');
    }
    return this.scope.db.connection.transaction(async session=>{
      await lockCalendar(this.scope.db,a.workspaceId,session);
      const current=await this.scope.get('sessions',id,a,session);
      if(current.startAt<new Date() || current.status!=='scheduled' || current.attendance!=='pending') throw new BadRequestException('Hanya pertemuan mendatang yang belum dicatat dapat diubah bersama seri.');
      const schedule=await this.scope.get('schedules',current.scheduleId,a,session);
      const occurrence=await this.scope.db.collection('sessions').find(occurrenceMembers(current)).session(session).lean();
      if(schedule.groupId) {
        const series=await this.scope.db.collection('schedules').find({workspaceId:a.workspaceId,groupId:schedule.groupId}).session(session).lean();
        if(occurrence.length!==series.length) throw new BadRequestException('Pertemuan ini memiliki perubahan khusus. Ubah pertemuan ini saja atau atur pola dari detail seri.');
      }
      if(occurrence.some(row=>row.status==='completed')) throw new BadRequestException('Sesi dengan presensi tersimpan tidak dapat diubah.');
      if(d.status==='cancelled') {
        const reason=requireCancellationReason(d.status,d.cancellationReason);
        await this.stopFollowing(a,schedule,current.startAt,session,reason);
        return {...current,status:'cancelled',attendance:'cancelled',cancellationReason:reason};
      }
      const startAt=d.startAt?new Date(d.startAt):current.startAt,endAt=d.endAt?new Date(d.endAt):current.endAt;
      // A time change keeps the weekdays; moving the date rotates the weekly pattern.
      const oldDay=localWeekday(current.startAt,schedule.timezone),newDay=localWeekday(startAt,schedule.timezone);
      const days=(schedule.repeatDays??[oldDay]).map(day=>(day-1+newDay-oldDay+7)%7+1);
      const before=schedule.repeatEnd==='count' || !schedule.repeatEnd
        ? await this.scope.db.collection('sessions').countDocuments({workspaceId:a.workspaceId,scheduleId:schedule._id,startAt:{$lt:current.startAt}}).session(session) : 0;
      const remaining=Math.max(1,schedule.repeatCount-before);
      const updated=await this.continueSeries(a,schedule,current.startAt,{startAt:startAt.toISOString(),endAt:endAt.toISOString(),timezone:schedule.timezone,repeatDays:days,
        repeatEnd:schedule.repeatEnd??'count',repeatCount:remaining,repeatUntil:schedule.repeatUntil},session);
      return {continuationScheduleId:updated._id};
    });
  }
  private async stopFollowing(a:Principal,current:Schedule,from:Date,session:ClientSession,reason?:string) {
    const filter=current.groupId?{workspaceId:a.workspaceId,groupId:current.groupId}:{workspaceId:a.workspaceId,_id:current._id};
    const members=await this.scope.db.collection('schedules').find(filter).session(session).lean();
    await this.scope.db.collection('schedules').updateMany({...filter,status:'scheduled'},{$set:{status:'cancelled',recurrenceComplete:true,...(reason?{cancellationReason:reason}:{})}},{session,runValidators:true});
    await this.scope.db.collection('sessions').updateMany({workspaceId:a.workspaceId,scheduleId:{$in:members.map(row=>row._id)},status:'scheduled',attendance:'pending',startAt:{$gte:from}},{$set:{status:'cancelled',attendance:'cancelled',...(reason?{cancellationReason:reason}:{})}},{session,runValidators:true});
    return members;
  }
  private async continueSeries(a:Principal,current:Schedule,from:Date,d:RepeatScheduleDto,session:ClientSession) {
    if(current.status!=='scheduled') throw new BadRequestException('Pengulangan sudah dihentikan.');
    if(new Date(d.startAt)<new Date()) throw new BadRequestException('Pola baru harus dimulai pada waktu mendatang.');
    const series=await this.scope.db.collection('schedules').find(current.groupId?{workspaceId:a.workspaceId,groupId:current.groupId}:{workspaceId:a.workspaceId,_id:current._id}).session(session).lean();
    const locked=await this.scope.db.collection('sessions').exists({workspaceId:a.workspaceId,scheduleId:{$in:series.map(row=>row._id)},startAt:{$gte:from},status:'completed'}).session(session);
    if(locked) throw new BadRequestException('Ada presensi tersimpan pada rentang ini. Pilih setelah pertemuan tersebut.');
    const members=await this.stopFollowing(a,current,from,session);
    return this.createSeries(a,{...d,recurrence:'weekly',studentIds:members.map(row=>row.studentId),subjectId:current.subjectId},session);
  }
  async expandRepeat(id:string,now=new Date()) {
    const current=await this.scope.db.collection('schedules').findOne({_id:id,status:'scheduled',recurrenceComplete:false,repeatEnd:{$exists:true}}).lean();
    if(!current) return;
    const filter=current.groupId?{workspaceId:current.workspaceId,groupId:current.groupId,status:'scheduled' as const}:{workspaceId:current.workspaceId,_id:id,status:'scheduled' as const};
    try {
      if(!await this.subscriptions.canUse(current.workspaceId,'recurringSchedules')) throw new BadRequestException('Pengulangan membutuhkan Pro/Trial aktif.');
      const teacher=await this.scope.db.collection('users').findOne({workspaceId:current.workspaceId,role:'teacher',deletionRequestedAt:{$exists:false}}).lean();
      if(!teacher) {
        await this.scope.db.collection('schedules').updateMany(filter,{$set:{recurrenceComplete:true,recurrenceError:'Pengulangan dihentikan karena akun Guru tidak aktif.'}});
        return;
      }
      await this.scope.db.connection.transaction(async session=>{
        await lockCalendar(this.scope.db,current.workspaceId,session);
        const pattern=await this.scope.db.collection('schedules').findOne({...filter,_id:id,recurrenceComplete:false}).session(session).lean();
        if(!pattern) return;
        const members=await this.scope.db.collection('schedules').find(filter).session(session).lean();
        for(const member of members) await this.scope.activeStudent(member.studentId,teacher,session);
        const {slots,...progress}=repeatOccurrences(pattern,now);
        for(const slot of slots) {
          await requireFreeSlot(this.scope.db,current.workspaceId,slot.startAt,slot.endAt,session);
          const groupId=members.length>1?randomUUID():undefined;
          await this.scope.db.collection('sessions').create(members.map(member=>({workspaceId:member.workspaceId,scheduleId:member._id,studentId:member.studentId,subjectId:member.subjectId,...slot,...(groupId?{groupId}:{})})),{session,ordered:true});
        }
        await this.scope.db.collection('schedules').updateMany(filter,{$set:{...progress,nextExpansionAt:new Date(now.getTime()+3600_000)},$unset:{recurrenceError:1}},{session});
      });
    } catch(error) {
      const conflict=error instanceof ConflictException;
      await this.scope.db.collection('schedules').updateMany({...filter,generatedCount:current.generatedCount},{$set:{nextExpansionAt:new Date(now.getTime()+3600_000),recurrenceError:conflict?'Ada benturan jadwal pada kelanjutan pengulangan. Periksa jadwal atau ubah pola.':'Kelanjutan pengulangan belum tersedia. Periksa paket Pro/Trial dan siswa aktif.'}});
    }
  }
  async attendance(a:Principal,id:string,d:AttendanceDto) {
    requireCancellationReason(d.attendance,d.cancellationReason);
    const result=await this.scope.db.connection.transaction(async session=>{
      await lockCalendar(this.scope.db, a.workspaceId, session);
      const current=await this.scope.get('sessions',id,a,session);
      this.requirePending(current);
      return this.recordAttendance(a,current,d.attendance,session,d.cancellationReason);
    });
    await this.notifications.deliverAfterCommit(result.notificationIds);
    return result.updated;
  }
  async batchAttendance(a:Principal,id:string,d:BatchAttendanceDto) {
    if(!d.entries?.length || d.entries.length>100 || new Set(d.entries.map(entry=>entry.sessionId)).size!==d.entries.length) throw new BadRequestException('Pilih 1–100 presensi berbeda.');
    const result=await this.scope.db.connection.transaction(async session=>{
      await lockCalendar(this.scope.db,a.workspaceId,session);
      const current=await this.scope.get('sessions',id,a,session);
      const members=await this.scope.db.collection('sessions').find(occurrenceMembers(current)).session(session).lean();
      const byId=new Map(members.map(member=>[member._id,member]));
      // Validate the whole batch before writing anything; Mongo rolls back all
      // rows and outbox events if any subsequent conditional write fails.
      for(const entry of d.entries) {
        const member=byId.get(entry.sessionId);
        if(!member) throw new BadRequestException('Siswa bukan peserta pertemuan ini.');
        this.requirePending(member);
        requireCancellationReason(entry.attendance,entry.cancellationReason);
      }
      const notificationIds:string[]=[];
      for(const entry of d.entries) {
        const saved=await this.recordAttendance(a,byId.get(entry.sessionId)!,entry.attendance,session,entry.cancellationReason);
        notificationIds.push(...saved.notificationIds);
      }
      return {savedCount:d.entries.length,notificationIds};
    });
    await this.notifications.deliverAfterCommit(result.notificationIds);
    return {savedCount:result.savedCount};
  }
  private requirePending(row:LessonSession) {
    if(row.attendance!=='pending') throw new ConflictException('Presensi sudah dikunci dan tidak dapat diubah.');
    if(row.status!=='scheduled') throw new BadRequestException('Sesi tidak lagi terjadwal. Muat ulang presensi.');
    if(row.startAt.getTime()>Date.now()) throw new BadRequestException('Presensi tersedia saat sesi dimulai.');
  }
  private async recordAttendance(a:Principal,current:LessonSession,attendance:AttendanceDto['attendance'],session:ClientSession,cancellationReason?:string) {
    if(!['present','excused','absent','cancelled'].includes(attendance)) throw new BadRequestException('Status presensi tidak valid.');
    const reason=requireCancellationReason(attendance,cancellationReason);
    const id=current._id;
    const updated=await this.scope.db.collection('sessions').findOneAndUpdate(
      {_id:id,workspaceId:a.workspaceId,attendance:'pending',status:'scheduled'},
      {$set:{attendance,status:attendance==='cancelled'?'cancelled':'completed',...(reason?{cancellationReason:reason}:{})}},
      {returnDocument:'after',session}
    ).lean();
    if(!updated) throw new ConflictException('Presensi sudah dikunci dan tidak dapat diubah.');
    if(attendance!=='present') return {updated,notificationIds:[] as string[]};
    // Sequential operations on the transaction's single Mongo connection.
    const student=await this.scope.db.collection('students').findOne({_id:updated.studentId,workspaceId:a.workspaceId}).select('name').session(session).lean();
    const subject=await this.scope.db.collection('subjects').findOne({_id:updated.subjectId,workspaceId:a.workspaceId}).select('name').session(session).lean();
    const recipients=await this.notifications.studentRecipients(a.workspaceId,updated.studentId,session);
    const events:NotificationEventInput[]=recipients.parentIds.map(parentId=>({
      workspaceId:a.workspaceId,recipientAccountId:parentId,title:'Kehadiran anak tercatat',
      body:`${student?.name??'Siswa'} tercatat hadir pada sesi ${subject?.name??'belajar'} yang dijadwalkan.`,
      route:`/parent/sessions/${id}`,eventKey:`attendance:${id}:present:${parentId}`,
    }));
    return {updated,notificationIds:await this.notifications.create(events,session)};
  }
}
