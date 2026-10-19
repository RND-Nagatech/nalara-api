import { Injectable, UnauthorizedException } from '@nestjs/common';
import type { ClientSession } from 'mongoose';
import { randomUUID } from 'node:crypto';
import { Database } from '../../database/database.module';
import type { PortalAccount } from '../../database/entities';
import type { Principal } from '../../common/api';
import { NotificationDeviceDto } from './notifications.dto';

type DeviceOwner = Pick<Principal, '_id' | 'workspaceId'>;

@Injectable()
export class NotificationDevicesService {
  constructor(private readonly db: Database) {}

  async register(
    owner: DeviceOwner,
    accountType: 'teacher' | 'parent' | 'student',
    dto: NotificationDeviceDto,
    session?: ClientSession,
  ) {
    return this.db.collection('notificationDevices').findOneAndUpdate(
      { token: dto.token.trim() },
      {
        $set: {
          workspaceId: owner.workspaceId,
          accountId: owner._id,
          accountType,
          platform: dto.platform,
          lastSeenAt: new Date(),
        },
        $setOnInsert: { _id: randomUUID() },
      },
      { upsert: true, returnDocument: 'after', runValidators: true, ...(session ? {session} : {}) },
    ).lean();
  }

  async unregister(owner: DeviceOwner, dto: NotificationDeviceDto) {
    await this.db.collection('notificationDevices').deleteOne({
      workspaceId: owner.workspaceId,
      accountId: owner._id,
      token: dto.token.trim(),
    });
    return { removed: true };
  }

  async registerPortal(
    owner: Pick<PortalAccount, '_id' | 'workspaceId' | 'role'>,
    dto: NotificationDeviceDto,
    portalSessionId: string,
  ) {
    if (!portalSessionId) throw new UnauthorizedException('Sesi referral diperlukan.');
    return this.db.connection.transaction(async session => {
      // Revocation writes this same account in its transaction. Serialize a
      // registration already in flight so a stale session cannot restore a token
      // immediately after revokeAccess has removed its devices.
      const account = await this.db.collection('portalAccounts').findOneAndUpdate(
        {_id: owner._id, workspaceId: owner.workspaceId, role: owner.role, status: 'active'},
        {$inc: {notificationVersion: 1}}, {session, returnDocument: 'after'},
      ).lean();
      if (!account) throw new UnauthorizedException('Akses dicabut. Hubungi Guru.');
      // A later referral can reactivate the same account ID. Recheck the
      // original server-authenticated session, not merely its active status.
      const authenticatedSession = await this.db.collection('portalSessions').findOne({
        _id: portalSessionId, accountId: owner._id,
        accessExpiresAt: {$gt: new Date()}, expiresAt: {$gt: new Date()},
      }).session(session).select('_id').lean();
      if (!authenticatedSession) throw new UnauthorizedException('Sesi referral berakhir. Hubungi Guru.');
      return this.register(owner, owner.role, dto, session);
    });
  }

  async unregisterPortal(
    owner: Pick<PortalAccount, '_id' | 'workspaceId'>,
    dto: NotificationDeviceDto,
  ) {
    return this.unregister(owner, dto);
  }
}
