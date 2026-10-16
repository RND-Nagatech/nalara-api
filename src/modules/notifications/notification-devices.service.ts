import { Injectable } from '@nestjs/common';
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
      { upsert: true, returnDocument: 'after', runValidators: true },
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
  ) {
    return this.register(owner, owner.role, dto);
  }

  async unregisterPortal(
    owner: Pick<PortalAccount, '_id' | 'workspaceId'>,
    dto: NotificationDeviceDto,
  ) {
    return this.unregister(owner, dto);
  }
}
