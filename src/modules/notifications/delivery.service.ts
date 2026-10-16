import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Logger } from 'nestjs-pino';
import { getMessaging } from 'firebase-admin/messaging';
import { Database } from '../../database/database.module';
import { Notification } from '../../database/entities';
import { FirebaseAuthService } from '../auth/firebase-auth.service';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
@Injectable()
export class NotificationDelivery {
  constructor(private readonly db:Database,private readonly config:ConfigService,private readonly logger:Logger,private readonly firebase:FirebaseAuthService,private readonly subscriptions:SubscriptionsService) {}
  async send(notification:Notification) {
    await this.sendFirebase(notification);
    const url=this.config.get<string>('NOTIFICATION_DELIVERY_URL');
    if(!url) return; // The persisted in-app record is the default delivery provider.
    const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json','idempotency-key':notification.eventKey,...(this.config.get<string>('NOTIFICATION_DELIVERY_TOKEN')?{authorization:`Bearer ${this.config.get<string>('NOTIFICATION_DELIVERY_TOKEN')}`}:{})},body:JSON.stringify({eventId:notification._id,workspaceId:notification.workspaceId,title:notification.title,body:notification.body,route:notification.route}),signal:AbortSignal.timeout(8000)});
    if(!response.ok) throw new Error('NotificationProviderUnavailable');
  }
  private async sendFirebase(notification:Notification) {
    const filter = notification.recipientAccountId
      ? {workspaceId:notification.workspaceId,accountId:notification.recipientAccountId}
      : {workspaceId:notification.workspaceId,accountType:'teacher' as const};
    const preferences = await this.db.collection('tutorPreferences').findOne({workspaceId:notification.workspaceId}).lean();
    const category = /^(target-due|lesson-reminder):/.test(notification.eventKey) ? 'reminders' : notification.eventKey.startsWith('progress:') ? 'progress' : notification.eventKey.startsWith('report:') ? 'reports' : notification.eventKey.startsWith('assignment:') ? 'assignments' : null;
    const custom = preferences && category && preferences[category] === false && await this.subscriptions.canUse(notification.workspaceId,'notificationPreferences');
    // Tutor preferences affect only this tutor's push, never the child's or
    // parent's delivery and never remove durable inbox messages.
    const devices = await this.db.collection('notificationDevices').find({...filter,...(custom?{accountType:{$ne:'teacher'}}:{})}).select('_id token').lean();
    if (!devices.length) return;
    const messaging = getMessaging(this.firebase.getAdminApp());
    for (let offset = 0; offset < devices.length; offset += 500) {
      const batch = devices.slice(offset, offset + 500);
      const response = await messaging.sendEachForMulticast({
        tokens: batch.map((device) => device.token),
        notification: {title: notification.title, body: notification.body},
        data: {notificationId: notification._id, route: notification.route},
        android: {notification: {channelId: 'nalara_notifications', clickAction: 'FLUTTER_NOTIFICATION_CLICK'}},
        apns: {payload: {aps: {sound: 'default'}}},
      });
      const invalid = batch.filter((_, index) => {
        const code = response.responses[index]?.error?.code;
        return code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token';
      });
      if (invalid.length) await this.db.collection('notificationDevices').deleteMany({_id:{$in:invalid.map((device) => device._id)}});
      if (response.failureCount === response.responses.length) throw new Error('FirebaseNotificationProviderUnavailable');
    }
  }
  // Called only after commit. Provider failures never undo teaching data.
  async deliver(id:string) {
    try {
      const record=await this.db.collection('notifications').findOneAndUpdate({_id:id,deliveryAttempts:{$lt:10},$or:[{deliveryStatus:'pending'},{deliveryStatus:'delivering',updatedAt:{$lt:new Date(Date.now()-5*60_000)}}]},{$set:{deliveryStatus:'delivering'},$inc:{deliveryAttempts:1}},{returnDocument:'after'}).lean();
      if(!record) return;
      try { await this.send(record); await this.db.collection('notifications').updateOne({_id:id},{$set:{deliveryStatus:'delivered'},$unset:{lastDeliveryError:1}}); }
      catch(error) { await this.db.collection('notifications').updateOne({_id:id},{$set:{deliveryStatus:'pending',lastDeliveryError:error instanceof Error?error.name:'Unknown'}}); this.logger.warn({eventId:id},'Notification pending retry'); }
    } catch { this.logger.warn({eventId:id},'Notification delivery state unavailable; event remains durable'); }
  }
}
