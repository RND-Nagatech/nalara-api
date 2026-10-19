import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { verify } from 'argon2';
import { createHash } from 'node:crypto';
import type { ClientSession } from 'mongoose';
import type { Principal } from '../../common/api';
import { Database } from '../../database/database.module';
import type { User } from '../../database/entities';
import { FirebaseAuthService } from '../auth/firebase-auth.service';
import { DeleteAccountDto } from './account-deletion.dto';

@Injectable()
export class AccountDeletionService {
  constructor(private readonly db: Database, private readonly firebase: FirebaseAuthService) {}

  private async owner(actor: Principal, session?: ClientSession) {
    const workspace = await this.db.collection('workspaces').findOne({_id: actor.workspaceId, ownerId: actor._id}).session(session ?? null).lean();
    if (!workspace) throw new ForbiddenException('Hanya pemilik akun Guru yang dapat menghapus ruang kerja ini.');
    if (await this.db.collection('users').exists({workspaceId: actor.workspaceId, _id: {$ne: actor._id}}).session(session ?? null)) {
      throw new ConflictException('Ruang kerja memiliki lebih dari satu akun Guru. Penghapusan tidak dapat menghapus data akun lain.');
    }
    return workspace;
  }

  async summary(actor: Principal) {
    await this.owner(actor);
    const user = await this.db.collection('users').findOne({_id: actor._id, workspaceId: actor.workspaceId}).lean();
    if (!user) throw new NotFoundException('Akun tidak ditemukan.');
    const filter = {workspaceId: actor.workspaceId};
    const [students, schedules, targets, reports, openPayment] = await Promise.all([
      this.db.collection('students').countDocuments(filter),
      this.db.collection('schedules').countDocuments(filter),
      this.db.collection('targets').countDocuments(filter),
      this.db.collection('reports').countDocuments(filter),
      this.db.collection('subscriptionOrders').exists({...filter, open: true}),
    ]);
    return {userId: user._id, email: user.email, phone: user.phone, googleLinked: !!user.firebaseUid,
      students, schedules, targets, reports, openPayment: !!openPayment,
      processingNotice: 'Akses akun dan portal terkait ditutup setelah konfirmasi. Data dihapus permanen secara otomatis di server; proses dapat tertunda bila layanan terkait sedang bermasalah.',
    };
  }

  async request(actor: Principal, dto: DeleteAccountDto, now = new Date()) {
    if (dto.confirmation !== 'HAPUS AKUN' || dto.acknowledged !== true) throw new BadRequestException('Konfirmasi penghapusan akun belum lengkap.');
    if ((dto.password === undefined) === (dto.idToken === undefined)) throw new BadRequestException('Gunakan tepat satu verifikasi: kata sandi atau akun Google.');
    const user = await this.db.collection('users').findOne({_id: actor._id, workspaceId: actor.workspaceId}).select('+passwordHash').lean();
    if (!user) throw new NotFoundException('Akun tidak ditemukan.');
    await this.owner(actor);
    await this.reauthenticate(user, dto, now);

    await this.db.connection.transaction(async session => {
      await this.owner(actor, session);
      // This write serializes session issuance and concurrent deletion attempts.
      const locked = await this.db.collection('users').findOneAndUpdate(
        {_id: actor._id, workspaceId: actor.workspaceId, passwordHash: user.passwordHash,
          ...(user.firebaseUid ? {firebaseUid: user.firebaseUid} : {firebaseUid: {$exists: false}})},
        {$set: {deletionRequestedAt: now}, $inc: {authVersion: 1}},
        {session, returnDocument: 'after'},
      ).lean();
      if (!locked) throw new ConflictException('Informasi akun berubah. Verifikasi ulang sebelum menghapus akun.');
      await this.db.collection('workspaces').updateOne({_id: actor.workspaceId, ownerId: actor._id},
        {$set: {deletionRequestedAt: now, name: 'Akun dihapus'}, $inc: {scheduleVersion: 1}}, {session});
      await this.db.collection('subscriptions').updateMany({workspaceId: actor.workspaceId},
        {$set: {deletionRequestedAt: now}, $inc: {usageVersion: 1}}, {session});
      await this.db.collection('accountDeletions').findOneAndUpdate({workspaceId: actor.workspaceId}, {
        $setOnInsert: {workspaceId: actor.workspaceId, userId: actor._id, requestedAt: now,
          nextAttemptAt: now, ...(user.firebaseUid ? {firebaseUid: user.firebaseUid,
            firebaseUidHash: createHash('sha256').update(user.firebaseUid).digest('hex')} : {})},
      }, {session, upsert: true, returnDocument: 'after'}).lean();
      const accounts = await this.db.collection('portalAccounts').find({workspaceId: actor.workspaceId}).select('_id').session(session).lean();
      await this.db.collection('portalAccounts').updateMany({workspaceId: actor.workspaceId}, {$set: {status: 'revoked'}}, {session});
      await this.db.collection('authSessions').deleteMany({userId: actor._id}, {session});
      await this.db.collection('portalSessions').deleteMany({accountId: {$in: accounts.map(account => account._id)}}, {session});
      await this.db.collection('notificationDevices').deleteMany({workspaceId: actor.workspaceId}, {session});
      await this.db.collection('notifications').updateMany({workspaceId: actor.workspaceId, deliveryStatus: {$in: ['pending', 'delivering']}},
        {$set: {deliveryStatus: 'suppressed'}, $unset: {deliveryClaimId: 1, deliveryLeaseUntil: 1, deliveryNextAttemptAt: 1}}, {session});
      await this.db.collection('invitations').updateMany({workspaceId: actor.workspaceId}, {$set: {revokedAt: now}}, {session});
    });
    return {accepted: true, status: 'pending', message: 'Permintaan penghapusan diterima. Akses akun telah ditutup dan data akan dihapus permanen oleh server.'};
  }

  private async reauthenticate(user: User, dto: DeleteAccountDto, now: Date) {
    if (dto.password !== undefined) {
      if (!await verify(user.passwordHash, dto.password)) throw new ForbiddenException('Kata sandi salah. Akun belum dihapus.');
      return;
    }
    if (!user.firebaseUid) throw new ForbiddenException('Akun ini tidak terhubung dengan Google. Gunakan kata sandi.');
    try {
      const proof = await this.firebase.verifyIdToken(dto.idToken!, true);
      const age = now.getTime() / 1000 - proof.auth_time;
      if (proof.uid !== user.firebaseUid || proof.firebase?.sign_in_provider !== 'google.com' ||
          !Number.isFinite(age) || age < -60 || age > 300) {
        throw new ForbiddenException('Verifikasi ulang dengan akun Google yang sama. Akun belum dihapus.');
      }
    } catch (error) {
      if (error instanceof UnauthorizedException) throw new ForbiddenException('Verifikasi Google tidak valid. Silakan verifikasi ulang. Akun belum dihapus.');
      throw error;
    }
  }
}
