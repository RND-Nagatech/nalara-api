import { BadRequestException, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Student } from '../../database/entities';
import { ScopedService } from '../../common/scoped.service';
import { Principal } from '../../common/api';
import { ListQuery } from '../../common/query.dto';
import { InvitationsService } from '../invitations/invitations.service';
import { StudentDto, UpdateStudentDto } from './students.dto';
import { StudentListProgressService } from './student-list-progress.service';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
@Injectable()
export class StudentsService {
  constructor(private readonly scope:ScopedService,private readonly codes:InvitationsService,private readonly progress:StudentListProgressService,private readonly subscriptions:SubscriptionsService) {}
  async list(actor:Principal, query:ListQuery) {
    const page = await this.scope.list('students',actor,query);
    return {...page, items:await this.progress.enrich<Student>(actor,page.items)};
  }
  get(actor:Principal,id:string) { return this.scope.get('students',id,actor); }
  async create(actor:Principal,dto:StudentDto) {
    const id=randomUUID();
    await this.scope.db.connection.transaction(async session=>{
      await this.subscriptions.capacity(actor.workspaceId,session);
      if (dto.familyId) {
        await this.scope.get('families',dto.familyId,actor,session);
        await this.scope.db.collection('families').updateOne({_id:dto.familyId,workspaceId:actor.workspaceId},{$inc:{version:1}},{session});
      }
      const {familyId,...fields}=dto;
      await this.scope.db.collection('students').create([{...fields,_id:id,workspaceId:actor.workspaceId,...(familyId?{familyId}:{})}],{session});
      await this.scope.audit(actor,'student.created',id,session);
    });
    return this.get(actor,id);
  }
  async update(actor:Principal,id:string,dto:UpdateStudentDto) {
    await this.scope.db.connection.transaction(async session=>{
      const student=await this.scope.get('students',id,actor,session);
      if (student.status !== 'active' && dto.status === 'active') await this.subscriptions.capacity(actor.workspaceId,session);
      const {familyId,...fields}=dto;
      const next=familyId===undefined?student.familyId:familyId??undefined;
      if (next && next!==student.familyId && (dto.status??student.status)!=='active') throw new BadRequestException('Siswa yang diarsipkan tidak dapat ditambahkan ke keluarga baru');
      if (next) await this.scope.get('families',next,actor,session);
      for (const family of new Set([student.familyId,next].filter((f):f is string=>!!f))) {
        await this.scope.db.collection('families').updateOne({_id:family,workspaceId:actor.workspaceId},{$inc:{version:1}},{session});
      }
      await this.scope.db.collection('students').updateOne({_id:id,workspaceId:actor.workspaceId},{$set:{...fields,...(next?{familyId:next}:{})},...(familyId===null?{$unset:{familyId:''}}:{})},{session,runValidators:true});
      await this.scope.audit(actor,'student.updated',id,session);
    });
    return this.get(actor,id);
  }
  invite(actor:Principal,id:string) { return this.codes.issueStudent(actor,id); }
  invitations(actor:Principal,id:string,query:ListQuery) { return this.codes.studentInvitations(actor,id,query); }
  async revoke(actor:Principal,id:string,invitationId:string) {
    await this.get(actor,id); const invite = await this.scope.get('invitations',invitationId,actor);
    if (invite.studentId !== id) return this.scope.get('invitations','invalid',actor);
    await this.scope.db.collection('invitations').updateOne({_id:invitationId,workspaceId:actor.workspaceId},{$set:{revokedAt:new Date()}});
    await this.scope.audit(actor,'invitation.revoked',invitationId); return {message:'Kode referral dicabut. Sesi yang sudah aktif dicabut melalui Cabut akses Siswa.'};
  }
}
