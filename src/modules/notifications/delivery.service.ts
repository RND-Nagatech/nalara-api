import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Logger } from 'nestjs-pino';
import { createHash, randomUUID } from 'node:crypto';
import { getMessaging } from 'firebase-admin/messaging';
import type { QueryFilter } from 'mongoose';
import { Database } from '../../database/database.module';
import type { Notification, NotificationDevice } from '../../database/entities';
import { FirebaseAuthService } from '../auth/firebase-auth.service';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { NotificationAudienceService } from './notification-audience.service';

export const NOTIFICATION_MAX_ATTEMPTS = 10;
const leaseMs = 2 * 60_000;
export function notificationRetryFilter(now = new Date()): QueryFilter<Notification> {
  return {
    deliveryAttempts: {$lt: NOTIFICATION_MAX_ATTEMPTS},
    $or: [
      {deliveryStatus: 'pending', $or: [{deliveryNextAttemptAt: {$lte: now}}, {deliveryNextAttemptAt: {$exists: false}}]},
      {deliveryStatus: 'delivering', $or: [
        {deliveryLeaseUntil: {$lte: now}},
        {deliveryLeaseUntil: {$exists: false}, updatedAt: {$lte: new Date(now.getTime() - 5 * 60_000)}},
      ]},
    ],
  };
}
export function notificationRetryDelay(attempt: number) {
  return Math.min(60 * 60_000, 15_000 * 2 ** Math.max(0, attempt - 1)) + Math.floor(Math.random() * 5_000);
}
const deviceKey = (device: Pick<NotificationDevice, '_id' | 'accountId' | 'accountType' | 'token'>) =>
  createHash('sha256').update(JSON.stringify([device._id, device.accountId, device.accountType, device.token])).digest('hex');
class DeliveryLeaseLost extends Error { override name = 'DeliveryLeaseLost'; }
class DeliveryAccessRevoked extends Error { override name = 'DeliveryAccessRevoked'; }
class FirebaseDeliveryUnavailable extends Error { override name = 'FirebaseDeliveryUnavailable'; }

@Injectable()
export class NotificationDelivery {
  constructor(
    private readonly db: Database,
    private readonly config: ConfigService,
    private readonly logger: Logger,
    private readonly firebase: FirebaseAuthService,
    private readonly subscriptions: SubscriptionsService,
    private readonly audience: NotificationAudienceService,
  ) {}

  private claim(notification: Notification) {
    return {_id: notification._id, deliveryStatus: 'delivering' as const, deliveryClaimId: notification.deliveryClaimId};
  }

  private async checkpoint(notification: Notification, completed: string[] = []) {
    const result = await this.db.collection('notifications').updateOne(this.claim(notification), {
      $set: {deliveryLeaseUntil: new Date(Date.now() + leaseMs)},
      ...(completed.length ? {$addToSet: {deliveredDeviceKeys: {$each: completed}}} : {}),
    });
    if (!result.matchedCount) throw new DeliveryLeaseLost();
  }

  private async requireAudience(notification: Notification) {
    const audience = await this.audience.resolve(notification);
    if (!audience) throw new DeliveryAccessRevoked();
    return audience;
  }

  async send(notification: Notification) {
    await this.requireAudience(notification);
    await this.sendFirebase(notification);
    const url = this.config.get<string>('NOTIFICATION_DELIVERY_URL');
    if (!url || notification.adapterDeliveredAt) return;
    await this.checkpoint(notification);
    const authorizedAudience = await this.requireAudience(notification);
    const token = this.config.get<string>('NOTIFICATION_DELIVERY_TOKEN');
    const response = await fetch(url, {
      method: 'POST',
      headers: {'content-type': 'application/json', 'idempotency-key': notification.eventKey, ...(token ? {authorization: `Bearer ${token}`} : {})},
      body: JSON.stringify({eventId: notification._id, workspaceId: notification.workspaceId, audience: authorizedAudience, title: notification.title, body: notification.body, route: notification.route}),
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error('NotificationProviderUnavailable');
    await this.db.collection('notifications').updateOne(this.claim(notification), {$set: {adapterDeliveredAt: new Date()}});
  }

  private async sendFirebase(notification: Notification) {
    const audience = await this.requireAudience(notification);
    const preferences = await this.db.collection('tutorPreferences').findOne({workspaceId: notification.workspaceId}).lean();
    const category = /^(target-due|lesson-reminder):/.test(notification.eventKey) ? 'reminders'
      : notification.eventKey.startsWith('progress:') ? 'progress'
      : notification.eventKey.startsWith('report:') ? 'reports'
      : notification.eventKey.startsWith('assignment:') ? 'assignments' : null;
    if (audience.accountType === 'teacher' && preferences && category && preferences[category] === false
      && await this.subscriptions.canUse(notification.workspaceId, 'notificationPreferences')) return;
    const filter = {workspaceId: notification.workspaceId, accountType: audience.accountType, accountId: {$in: audience.accountIds}};
    const devices = await this.db.collection('notificationDevices').find(filter).select('_id token accountId accountType').lean();
    const completed = new Set(notification.deliveredDeviceKeys ?? []);
    const pending = devices.filter(device => !completed.has(deviceKey(device)));
    if (!pending.length) return;
    const messaging = getMessaging(this.firebase.getAdminApp());
    for (let offset = 0; offset < pending.length; offset += 500) {
      await this.checkpoint(notification);
      const currentAudience = await this.requireAudience(notification);
      // Registrations can change owner or rotate tokens while a job waits.
      const candidates = pending.slice(offset, offset + 500);
      const current = await this.db.collection('notificationDevices').find({
        workspaceId: notification.workspaceId, _id: {$in: candidates.map(device => device._id)},
        accountType: currentAudience.accountType, accountId: {$in: currentAudience.accountIds},
      }).select('_id token accountId accountType').lean();
      const batch = current.filter(device => candidates.some(candidate => deviceKey(candidate) === deviceKey(device)));
      if (!batch.length) continue;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const response = await Promise.race([
        messaging.sendEachForMulticast({
          tokens: batch.map(device => device.token),
          notification: {title: notification.title, body: notification.body},
          data: {notificationId: notification._id, route: notification.route},
          android: {notification: {channelId: 'nalara_notifications', clickAction: 'FLUTTER_NOTIFICATION_CLICK'}},
          apns: {payload: {aps: {sound: 'default'}}},
        }),
        new Promise<never>((_resolve, reject) => {timeout = setTimeout(() => reject(new FirebaseDeliveryUnavailable()), 30_000);}),
      ]).finally(() => {if (timeout) clearTimeout(timeout);});
      const settled: string[] = [];
      let transientFailure = false;
      for (const [index, device] of batch.entries()) {
        const result = response.responses[index];
        const code = result?.error?.code;
        if (result?.success) settled.push(deviceKey(device));
        else if (code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token') {
          await this.db.collection('notificationDevices').deleteMany({_id: device._id, token: device.token, ...filter});
          settled.push(deviceKey(device));
        } else transientFailure = true;
      }
      // Save partial success before retrying another device.
      await this.checkpoint(notification, settled);
      if (transientFailure) throw new FirebaseDeliveryUnavailable();
    }
  }

  // Called after commit. Fenced leases coordinate API replicas and workers;
  // provider failures never roll back attendance, reports or other teaching data.
  async deliver(id: string) {
    try {
      const now = new Date();
      const record = await this.db.collection('notifications').findOneAndUpdate(
        {_id: id, ...notificationRetryFilter(now)},
        {$set: {deliveryStatus: 'delivering', deliveryClaimId: randomUUID(), deliveryLeaseUntil: new Date(now.getTime() + leaseMs)}, $inc: {deliveryAttempts: 1}},
        {returnDocument: 'after'},
      ).lean();
      if (!record) return;
      const clearLease = {deliveryClaimId: 1 as const, deliveryLeaseUntil: 1 as const, deliveryNextAttemptAt: 1 as const, lastDeliveryError: 1 as const};
      try {
        await this.send(record);
        await this.db.collection('notifications').updateOne(this.claim(record), {$set: {deliveryStatus: 'delivered'}, $unset: clearLease});
      } catch (error) {
        if (error instanceof DeliveryLeaseLost) return;
        if (error instanceof DeliveryAccessRevoked) {
          await this.db.collection('notifications').updateOne(this.claim(record), {$set: {deliveryStatus: 'suppressed'}, $unset: clearLease});
          return;
        }
        const exhausted = record.deliveryAttempts >= NOTIFICATION_MAX_ATTEMPTS;
        await this.db.collection('notifications').updateOne(this.claim(record), {
          $set: {deliveryStatus: exhausted ? 'failed' : 'pending', lastDeliveryError: error instanceof Error ? error.name : 'Unknown', deliveryNextAttemptAt: new Date(Date.now() + notificationRetryDelay(record.deliveryAttempts))},
          $unset: {deliveryClaimId: 1, deliveryLeaseUntil: 1},
        });
        this.logger.warn({event: exhausted ? 'notification.delivery.exhausted' : 'notification.delivery.retry_scheduled', eventId: id, attempts: record.deliveryAttempts}, 'Notification delivery incomplete');
      }
    } catch {
      this.logger.warn({event: 'notification.delivery.state_unavailable', eventId: id}, 'Notification remains durable for recovery');
    }
  }
}
