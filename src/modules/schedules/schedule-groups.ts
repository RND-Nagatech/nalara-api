import type { PipelineStage } from 'mongoose';
import type { LessonSession, Schedule } from '../../database/entities';
import type { ScopedService } from '../../common/scoped.service';

// Group identity includes the current interval: an approved parent reschedule
// moves only that child's occurrence, never the other families' occurrences.
export function occurrenceMembers(row:LessonSession) {
  return row.groupId
    ? {workspaceId:row.workspaceId,groupId:row.groupId,startAt:row.startAt,endAt:row.endAt}
    : {workspaceId:row.workspaceId,_id:row._id};
}

export function groupPipeline(filter:Record<string,unknown>, sessions:boolean):PipelineStage[] {
  return [
    {$match:filter},
    {$sort:{_id:1}},
    {$group:{
      _id:sessions ? {group:{$ifNull:['$groupId','$_id']},start:'$startAt',end:'$endAt'} : {$ifNull:['$groupId','$_id']},
      row:{$first:'$$ROOT'},members:{$push:'$$ROOT'},
    }},
    {$set:{'row.status':{$cond:[{$in:['scheduled','$members.status']},'scheduled',{$cond:[{$in:['completed','$members.status']},'completed','cancelled']}]}}},
    {$sort:sessions ? {'row.startAt':1,'row._id':1} : {'row.createdAt':-1,'row._id':1}},
  ];
}

type Named<T> = T & {studentName:string;studentAvatarId:string|null;subjectName:string};
export function groupView<T extends Schedule | LessonSession>(row:Named<T>, members:Named<T>[]) {
  const participants = members.map(member=>({
    studentId:member.studentId,studentName:member.studentName,studentAvatarId:member.studentAvatarId,
    scheduleId:'scheduleId' in member ? member.scheduleId : member._id,
    ...('attendance' in member ? {sessionId:member._id,attendance:member.attendance,status:member.status,cancellationReason:member.cancellationReason} : {}),
  }));
  const statuses=members.map(member=>member.status);
  const status=statuses.includes('scheduled') ? 'scheduled' : statuses.includes('completed') ? 'completed' : 'cancelled';
  const reasons=new Set(members.map(member=>member.cancellationReason));
  const cancellationReason=status==='cancelled' && reasons.size===1 ? members[0]?.cancellationReason : undefined;
  const attendances=members.flatMap(member=>'attendance' in member ? [member.attendance] : []);
  const attendance=attendances.includes('pending') ? 'pending' : new Set(attendances).size===1 ? attendances[0] : 'mixed';
  return {...row,participants,participantCount:members.length,
    studentName:members.length>1 ? `${members.length} siswa` : row.studentName,
    studentAvatarId:members.length>1 ? null : row.studentAvatarId,
    ...(members.length>1 ? {studentGrade:''} : {}),
    status,cancellationReason,...('attendance' in row ? {attendance,recordedCount:attendances.filter(value=>value!=='pending').length} : {}),
  };
}

export async function namedGroups<T extends Schedule | LessonSession>(scope:ScopedService,workspaceId:string,groups:{row:T;members:T[]}[]) {
  const rows=await scope.teachingNames({workspaceId},groups.flatMap(group=>group.members));
  const byId=new Map(rows.map(row=>[row._id,row]));
  return groups.map(group=>groupView(byId.get(group.row._id)!,group.members.map(member=>byId.get(member._id)!)));
}
