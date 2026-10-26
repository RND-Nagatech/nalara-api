import { BadRequestException, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Principal } from '../../common/api';
import type { PortalAccount } from '../../database/entities';
import { Database } from '../../database/database.module';
import { allowedAvatar, avatarOptions } from './avatar-catalog';
import type { AvatarAudience } from './avatar-catalog';

@Injectable()
export class AvatarsService {
  constructor(private readonly db: Database) {}

  options(audience: AvatarAudience) { return { items: avatarOptions(audience) }; }
  private validate(audience: AvatarAudience, avatarId: string | null) {
    if (!allowedAvatar(audience, avatarId)) throw new BadRequestException('Karakter profil tidak tersedia untuk akun Anda. Silakan pilih karakter dari daftar.');
  }
  async teacher(actor: Principal, avatarId: string | null) {
    if (actor.role !== 'teacher') throw new ForbiddenException('Hanya Guru yang dapat mengubah foto profilnya sendiri.');
    this.validate('teacher', avatarId);
    const result = await this.db.collection('users').updateOne({ _id: actor._id, workspaceId: actor.workspaceId, role: 'teacher', deletionRequestedAt: { $exists: false } }, { $set: { avatarId } }, { runValidators: true });
    if (!result.matchedCount) throw new UnauthorizedException('Akun Guru tidak tersedia. Silakan masuk kembali.');
    return { avatarId };
  }
  async student(account: PortalAccount, avatarId: string | null) {
    if (account.role !== 'student' || !account.studentId) throw new ForbiddenException('Hanya Siswa yang dapat mengubah foto profilnya sendiri.');
    this.validate('student', avatarId);
    // The account and student come exclusively from the authenticated portal session.
    return this.db.connection.transaction(async session => {
      const current = await this.db.collection('portalAccounts').findOne({ _id: account._id, workspaceId: account.workspaceId, studentId: account.studentId, role: 'student', status: 'active' }).session(session).lean();
      if (!current) throw new UnauthorizedException('Akses siswa sudah tidak aktif. Hubungi Guru.');
      // Touch the account to conflict with concurrent access revocation.
      await this.db.collection('portalAccounts').updateOne({ _id: current._id, workspaceId: current.workspaceId, status: 'active' }, { $inc: { notificationVersion: 1 } }, { session });
      const result = await this.db.collection('students').updateOne({ _id: current.studentId, workspaceId: current.workspaceId, status: 'active' }, { $set: { avatarId } }, { session, runValidators: true });
      if (!result.matchedCount) throw new UnauthorizedException('Data siswa tidak tersedia. Hubungi Guru.');
      return { avatarId };
    });
  }
}
