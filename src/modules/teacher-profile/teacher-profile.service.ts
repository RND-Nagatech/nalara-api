import { BadRequestException, ConflictException, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Principal } from '../../common/api';
import { Database } from '../../database/database.module';
import { normalizePhone } from '../auth/phone-number';

@Injectable()
export class TeacherProfileService {
  constructor(private readonly db: Database) {}

  async updateTimezone(actor: Principal, timezone: string) {
    if (actor.role !== 'teacher') throw new ForbiddenException('Hanya Guru yang dapat mengubah zona waktu akun sendiri.');
    // Keep this self-service allowlist separate from existing schedule IANA zones.
    if (!['Asia/Jakarta', 'Asia/Makassar', 'Asia/Jayapura'].includes(timezone)) {
      throw new BadRequestException('Pilih zona waktu WIB, WITA, atau WIT.');
    }
    const user = await this.db.collection('users').findOneAndUpdate({
      _id: actor._id, workspaceId: actor.workspaceId, role: 'teacher', deletionRequestedAt: {$exists: false},
    }, {$set: {timezone}}, {returnDocument: 'after', runValidators: true, maxTimeMS: 5000}).select('timezone').lean();
    if (!user) throw new UnauthorizedException('Akun Guru tidak tersedia. Silakan masuk kembali.');
    // Never rewrite occurrences or repeat anchors when changing a display default.
    return {timezone: user.timezone};
  }

  async updatePhone(actor: Principal, value: string) {
    if (actor.role !== 'teacher') throw new ForbiddenException('Hanya Guru yang dapat mengubah nomor HP sendiri.');
    const phone = normalizePhone(value);
    if (!phone) throw new BadRequestException('Nomor HP Indonesia tidak valid');
    try {
      // The existing unique canonical-phone index also arbitrates concurrent updates.
      const user = await this.db.collection('users').findOneAndUpdate({
        _id: actor._id, workspaceId: actor.workspaceId, role: 'teacher', deletionRequestedAt: {$exists: false},
      }, {$set: {phone}}, {returnDocument: 'after', runValidators: true, maxTimeMS: 5000}).select('phone').lean();
      if (!user) throw new UnauthorizedException('Akun Guru tidak tersedia. Silakan masuk kembali.');
      return {phone: user.phone!};
    } catch (error) {
      const duplicate = error as {code?: number; keyPattern?: {phone?: unknown}; keyValue?: {phone?: unknown}};
      if (duplicate.code === 11000 && (duplicate.keyPattern?.phone || duplicate.keyValue?.phone)) {
        throw new ConflictException('Nomor HP tersebut sudah digunakan akun lain. Gunakan nomor HP lain.');
      }
      throw error;
    }
  }
}
