import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { Principal } from '../../common/api';
import { Database } from '../../database/database.module';
import type { PortalAccount, TuitionFee } from '../../database/entities';
import { normalizePhone } from '../auth/phone-number';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { SaveTuitionFeeDto } from './tuition-fees.dto';

@Injectable()
export class TuitionFeesService {
  constructor(private readonly db: Database, private readonly subscriptions: SubscriptionsService) {}

  private async student(workspaceId: string, studentId: string, familyId?: string) {
    const student = await this.db.collection('students').findOne({_id: studentId, workspaceId, ...(familyId ? {familyId} : {})}).lean();
    if (!student) throw new NotFoundException('Data siswa tidak tersedia.');
    return student;
  }

  private async overview(workspaceId: string, studentId: string) {
    const fee = await this.db.collection('tuitionFees').findOne({workspaceId, studentId}).lean();
    const workspace = await this.db.collection('workspaces').findOne({_id: workspaceId}).select('ownerId').lean();
    const teacher = workspace ? await this.db.collection('users').findOne({_id: workspace.ownerId, workspaceId, role: 'teacher', deletionRequestedAt: {$exists: false}}).select('name phone timezone').lean() : null;
    const preferences = await this.db.collection('tutorPreferences').findOne({workspaceId}).select('tuitionTeacherReminders tuitionParentReminders').lean();
    return {fee: fee ? this.view(fee) : null,
      teacher: {name: teacher?.name ?? '', phone: normalizePhone(teacher?.phone), timezone: teacher?.timezone ?? 'Asia/Jakarta'},
      automaticReminders: await this.subscriptions.canUse(workspaceId, 'automaticReminders'),
      tuitionTeacherReminders: preferences?.tuitionTeacherReminders !== false, tuitionParentReminders: preferences?.tuitionParentReminders !== false};
  }

  private view(fee: TuitionFee) {
    return {_id: fee._id, studentId: fee.studentId, amount: fee.amount, dueDate: fee.dueDate,
      status: fee.status, version: fee.version, paidAt: fee.paidAt ?? null, updatedAt: fee.updatedAt};
  }

  async get(actor: Principal, studentId: string) {
    await this.student(actor.workspaceId, studentId);
    return this.overview(actor.workspaceId, studentId);
  }

  async parent(account: PortalAccount, studentId: string) {
    if (account.role !== 'parent' || !account.familyId) throw new ForbiddenException('Biaya bimbel hanya dibagikan kepada Orang Tua.');
    if (!await this.db.collection('families').exists({_id: account.familyId, workspaceId: account.workspaceId})) throw new NotFoundException('Keluarga tidak tersedia.');
    await this.student(account.workspaceId, studentId, account.familyId);
    return this.overview(account.workspaceId, studentId);
  }

  async save(actor: Principal, studentId: string, dto: SaveTuitionFeeDto) {
    const student = await this.student(actor.workspaceId, studentId);
    if (student.status !== 'active') throw new BadRequestException('Biaya hanya dapat diubah untuk siswa aktif.');
    const filter = {workspaceId: actor.workspaceId, studentId};
    const current = await this.db.collection('tuitionFees').findOne(filter).lean();
    if ((current?.version ?? 0) !== dto.version) throw new ConflictException('Biaya bimbel sudah berubah. Muat ulang sebelum menyimpan.');
    if (current && current.amount === dto.amount && current.dueDate === dto.dueDate && current.status === dto.status) return this.overview(actor.workspaceId, studentId);
    const fields = {amount: dto.amount, dueDate: dto.dueDate, status: dto.status,
      ...(dto.status === 'paid' ? {paidAt: current?.status === 'paid' ? current.paidAt : new Date()} : {})};
    if (!current) {
      await this.db.collection('tuitionFees').create({...filter, ...fields, version: 1});
    } else {
      const result = await this.db.collection('tuitionFees').updateOne({...filter, version: dto.version},
        {$set: fields, $inc: {version: 1}, ...(dto.status === 'unpaid' ? {$unset: {paidAt: 1}} : {})}, {runValidators: true});
      if (!result.modifiedCount) throw new ConflictException('Biaya bimbel sudah berubah. Muat ulang sebelum menyimpan.');
    }
    return this.overview(actor.workspaceId, studentId);
  }
}
