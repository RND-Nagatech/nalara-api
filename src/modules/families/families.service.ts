import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { ClientSession } from 'mongoose';
import { ScopedService } from '../../common/scoped.service';
import type { Principal } from '../../common/api';
import { ListQuery } from '../../common/query.dto';
import { FamilyDto, UpdateFamilyDto } from './families.dto';
@Injectable()
export class FamiliesService {
  constructor(private readonly scope:ScopedService) {}
  async list(actor:Principal, query:ListQuery) {
    const page = await this.scope.list('families',actor,query);
    const children = await this.scope.db.collection('students').find({workspaceId:actor.workspaceId,familyId:{$in:page.items.map(f=>f._id)}}).select('_id name grade status familyId').lean();
    return {...page,items:page.items.map(f=>({...f,students:children.filter(s=>s.familyId===f._id)}))};
  }
  async get(actor:Principal,id:string) {
    const family = await this.scope.get('families',id,actor);
    const students = await this.scope.db.collection('students').find({workspaceId:actor.workspaceId,familyId:id}).select('_id name grade status familyId').sort({name:1}).lean();
    return {...family,students};
  }
  private async checkChildren(actor:Principal,ids:string[],familyId:string,session:ClientSession) {
    const students = await this.scope.db.collection('students').find({_id:{$in:ids},workspaceId:actor.workspaceId}).session(session).lean();
    if (students.length !== ids.length) throw new NotFoundException('Siswa tidak ditemukan');
    if (students.some(s=>s.familyId && s.familyId!==familyId)) throw new BadRequestException('Ada siswa yang terhubung ke Orang Tua lain. Ubah hubungan dari profil siswa terlebih dahulu.');
    if (students.some(s=>s.status!=='active' && s.familyId!==familyId)) throw new BadRequestException('Siswa yang diarsipkan tidak dapat ditambahkan ke keluarga baru');
  }
  async create(actor:Principal,dto:FamilyDto) {
    const id = randomUUID(), ids = dto.studentIds ?? [];
    try {
      await this.scope.db.connection.transaction(async session=>{
        await this.checkChildren(actor,ids,id,session);
        await this.scope.db.collection('families').create([{_id:id,workspaceId:actor.workspaceId,name:dto.parentName,parentName:dto.parentName,parentPhone:dto.parentPhone}],{session});
        await this.scope.db.collection('students').updateMany({_id:{$in:ids},workspaceId:actor.workspaceId},{$set:{familyId:id}},{session});
        await this.scope.audit(actor,'family.created',id,session);
      });
    } catch (error) { this.conflict(error); }
    return this.get(actor,id);
  }
  async update(actor:Principal,id:string,dto:UpdateFamilyDto) {
    try {
      await this.scope.db.connection.transaction(async session=>{
        await this.scope.get('families',id,actor,session);
        if (dto.studentIds) await this.checkChildren(actor,dto.studentIds,id,session);
        const updated = await this.scope.db.collection('families').findOneAndUpdate({_id:id,workspaceId:actor.workspaceId,version:dto.version},{$set:{name:dto.parentName,parentName:dto.parentName,parentPhone:dto.parentPhone},$inc:{version:1}},{session,returnDocument:'after',runValidators:true}).lean();
        if (!updated) throw new ConflictException('Data keluarga berubah. Muat ulang sebelum menyimpan.');
        if (dto.studentIds) {
          await this.scope.db.collection('students').updateMany({workspaceId:actor.workspaceId,familyId:id,_id:{$nin:dto.studentIds}},{$unset:{familyId:''}},{session});
          await this.scope.db.collection('students').updateMany({workspaceId:actor.workspaceId,_id:{$in:dto.studentIds}},{$set:{familyId:id}},{session});
        }
        await this.scope.audit(actor,'family.updated',id,session);
      });
    } catch (error) { this.conflict(error); }
    return this.get(actor,id);
  }
  private conflict(error:unknown):never {
    if ((error as {code?:number})?.code===11000) throw new ConflictException('Nomor HP Orang Tua sudah terdaftar pada keluarga lain. Gunakan keluarga yang sudah ada.');
    throw error;
  }
}
