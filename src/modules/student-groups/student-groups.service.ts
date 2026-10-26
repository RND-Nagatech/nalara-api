import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { Principal } from '../../common/api';
import { ListQuery } from '../../common/query.dto';
import { Database } from '../../database/database.module';
import type { StudentGroup } from '../../database/entities';
import { StudentGroupDto, UpdateStudentGroupDto } from './student-groups.dto';

@Injectable()
export class StudentGroupsService {
  constructor(private readonly db: Database) {}

  async list(actor: Principal, query: ListQuery) {
    const filter = {workspaceId: actor.workspaceId,
      ...(query.search ? {name: {$regex: query.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i'}} : {})};
    const [rows, total] = await Promise.all([
      this.db.collection('studentGroups').find(filter).sort({createdAt: -1, _id: -1})
        .skip((query.page - 1) * query.limit).limit(query.limit).lean(),
      this.db.collection('studentGroups').countDocuments(filter),
    ]);
    return {items: await this.members(actor, rows), total, page: query.page, limit: query.limit};
  }

  async get(actor: Principal, id: string) {
    const row = await this.db.collection('studentGroups').findOne({_id: id, workspaceId: actor.workspaceId}).lean();
    if (!row) throw new NotFoundException('Grup siswa tidak ditemukan.');
    return (await this.members(actor, [row]))[0];
  }

  private async members(actor: Principal, rows: readonly StudentGroup[]) {
    const ids = [...new Set(rows.flatMap(row => row.studentIds))];
    const students = await this.db.collection('students').find({workspaceId: actor.workspaceId, _id: {$in: ids}})
      .select('_id name grade status avatarId').lean();
    const byId = new Map(students.map(student => [student._id, student]));
    return rows.map(row => ({...row, students: row.studentIds.flatMap(id => {
      const student = byId.get(id);
      return student ? [{_id: student._id, name: student.name, grade: student.grade, status: student.status, avatarId: student.avatarId ?? null}] : [];
    })}));
  }

  private async validateStudents(actor: Principal, ids: string[]) {
    const count = await this.db.collection('students').countDocuments({workspaceId: actor.workspaceId, _id: {$in: ids}, status: 'active'});
    if (count !== ids.length) throw new BadRequestException('Pilih anggota dari siswa aktif yang tersedia. Muat ulang daftar siswa.');
  }

  async create(actor: Principal, dto: StudentGroupDto) {
    await this.validateStudents(actor, dto.studentIds);
    const row = await this.db.collection('studentGroups').create({workspaceId: actor.workspaceId, name: dto.name, studentIds: dto.studentIds});
    return this.get(actor, row._id);
  }

  async update(actor: Principal, id: string, dto: UpdateStudentGroupDto) {
    await this.get(actor, id);
    await this.validateStudents(actor, dto.studentIds);
    const row = await this.db.collection('studentGroups').findOneAndUpdate(
      {_id: id, workspaceId: actor.workspaceId, version: dto.version},
      {$set: {name: dto.name, studentIds: dto.studentIds}, $inc: {version: 1}},
      {returnDocument: 'after', runValidators: true},
    ).lean();
    if (!row) throw new ConflictException('Grup sudah berubah. Buka kembali grup sebelum menyimpan.');
    return this.get(actor, id);
  }

  async remove(actor: Principal, id: string, version: number) {
    await this.get(actor, id);
    const result = await this.db.collection('studentGroups').deleteOne({_id: id, workspaceId: actor.workspaceId, version});
    if (!result.deletedCount) throw new ConflictException('Grup sudah berubah. Buka kembali grup sebelum menghapus.');
    return {deleted: true};
  }
}
