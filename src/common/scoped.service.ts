import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import type { ClientSession, QueryFilter } from 'mongoose';
import { Database } from '../database/database.module';
import { Collections, Scoped } from '../database/entities';
import type { Principal } from './api';
import { ListQuery } from './query.dto';
export type ScopedCollection = { [K in keyof Collections]: Collections[K] extends Scoped ? K : never }[keyof Collections];
@Injectable()
export class ScopedService {
  constructor(readonly db: Database) {}
  async get<K extends ScopedCollection>(name: K, id: string, actor: Principal, session?: ClientSession) {
    const record = await this.db.collection(name).findOne({_id:id, workspaceId:actor.workspaceId} as QueryFilter<Collections[K]>).session(session ?? null).lean();
    if (!record) throw new NotFoundException('Data tidak ditemukan');
    return record as unknown as Collections[K];
  }
  async list<K extends ScopedCollection>(name: K, actor: Principal, query: ListQuery, extra: Record<string, unknown> = {}) {
    const filter: Record<string, unknown> = {workspaceId:actor.workspaceId, ...extra};
    if (query.studentId) filter.studentId = query.studentId;
    if (query.planId) filter.planId = query.planId;
    if (query.scheduleId) filter.scheduleId = query.scheduleId;
    if (query.sessionId) filter.sessionId = query.sessionId;
    if (query.status) filter.status = query.status;
    if (query.search) filter.name = {$regex: query.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options:'i'};
    if (query.from || query.to) filter.startAt = {...(query.from ? {$gte:new Date(query.from)} : {}), ...(query.to ? {$lte:new Date(query.to)} : {})};
    const model = this.db.collection(name);
    const [items,total] = await Promise.all([model.find(filter as QueryFilter<Collections[K]>).sort(name==='sessions'?{startAt:1}:{createdAt:-1}).skip((query.page-1)*query.limit).limit(query.limit).lean(), model.countDocuments(filter as QueryFilter<Collections[K]>)]);
    if (['schedules','sessions','plans','targets','reports','assignments'].includes(name)) {
      const rows=items as unknown as (Collections[K] & {studentId:string;subjectId?:string;sessionId?:string})[];
      return {items:await this.teachingNames(actor,rows),total,page:query.page,limit:query.limit};
    }
    return {items, total, page:query.page, limit:query.limit};
  }
  async teachingNames<T extends {studentId:string;subjectId?:string;sessionId?:string}>(actor:Pick<Principal,'workspaceId'>,rows:readonly T[]) {
    const sessionIds=rows.filter(row=>!row.subjectId && row.sessionId).map(row=>row.sessionId!);
    const sessions=sessionIds.length
      ? await this.db.collection('sessions').find({workspaceId:actor.workspaceId,_id:{$in:sessionIds}}).select('subjectId').lean()
      : [];
    const sessionSubjects=new Map(sessions.map(session=>[session._id,session.subjectId]));
    const subjectId=(row:T)=>row.subjectId ?? (row.sessionId ? sessionSubjects.get(row.sessionId) : undefined);
    const [students,subjects]=await Promise.all([
      this.db.collection('students').find({workspaceId:actor.workspaceId,_id:{$in:rows.map(row=>row.studentId)}}).select('name').lean(),
      this.db.collection('subjects').find({workspaceId:actor.workspaceId,_id:{$in:rows.map(subjectId).filter((id):id is string=>typeof id==='string')}}).select('name').lean(),
    ]);
    const studentNames=new Map(students.map(student=>[student._id,student.name]));
    const subjectNames=new Map(subjects.map(subject=>[subject._id,subject.name]));
    return rows.map(row=>({...row,studentName:studentNames.get(row.studentId)??'',subjectName:subjectNames.get(subjectId(row)??'')??''}));
  }
  async activeStudent(id: string, actor: Principal, session?: ClientSession) { const student = await this.get('students', id, actor, session); if (student.status !== 'active') throw new BadRequestException('Siswa sudah diarsipkan'); return student; }
  async audit(actor: Principal, action: string, resourceId: string, session?: ClientSession) { await this.db.collection('audits').create([{workspaceId:actor.workspaceId, actorId:actor._id, action, resourceId}], {session}); }
}
