import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Database } from '../../database/database.module';
import { NotificationDelivery, notificationRetryFilter, NOTIFICATION_MAX_ATTEMPTS } from './delivery.service';

@Injectable()
export class NotificationDeliveryWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NotificationDeliveryWorker.name);
  private timer?: ReturnType<typeof setInterval>;
  private inFlight?: Promise<void>;
  private stopped = false;

  constructor(private readonly db: Database, private readonly config: ConfigService, private readonly delivery: NotificationDelivery) {}

  onModuleInit() {
    this.timer = setInterval(() => void this.run(), Number(this.config.get('NOTIFICATION_DELIVERY_INTERVAL_SECONDS') ?? 15) * 1000);
    this.timer.unref();
    void this.run();
  }

  run(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.scan().catch(() => {
      this.logger.warn({event: 'notification.worker.scan_failed'}, 'Durable notifications will be scanned again');
    }).finally(() => {this.inFlight = undefined;});
    return this.inFlight;
  }

  private async scan() {
    const now = new Date();
    // Older versions left exhausted rows pending forever. Preserve the inbox,
    // but make those failures visible instead of silently abandoning them.
    const exhausted = await this.db.collection('notifications').updateMany({
      deliveryAttempts: {$gte: NOTIFICATION_MAX_ATTEMPTS},
      $or: [{deliveryStatus: 'pending'}, {deliveryStatus: 'delivering', deliveryLeaseUntil: {$lte: now}}, {deliveryStatus: 'delivering', deliveryLeaseUntil: {$exists: false}, updatedAt: {$lte: new Date(now.getTime() - 5 * 60_000)}}],
    }, {$set: {deliveryStatus: 'failed'}, $unset: {deliveryClaimId: 1, deliveryLeaseUntil: 1}});
    if (exhausted.modifiedCount) this.logger.warn({event: 'notification.delivery.exhausted', count: exhausted.modifiedCount}, 'Delivery requires attention');
    const records = await this.db.collection('notifications').find(notificationRetryFilter(now))
      .select('_id').sort({deliveryNextAttemptAt: 1, _id: 1}).limit(Number(this.config.get('NOTIFICATION_DELIVERY_BATCH_SIZE') ?? 25)).lean();
    for (let offset = 0; offset < records.length && !this.stopped; offset += 4) {
      const batch = records.slice(offset, offset + 4);
      const results = await Promise.allSettled(batch.map(record => this.delivery.deliver(record._id)));
      for (const [index, result] of results.entries()) {
        if (result.status === 'rejected') this.logger.warn({event:'notification.delivery.state_unavailable',eventId:batch[index]._id}, 'Event remains recoverable');
      }
    }
  }

  async onModuleDestroy() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (!this.inFlight) return;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([this.inFlight, new Promise<void>(resolve => {timeout = setTimeout(resolve, 10_000);})])
      .finally(() => {if (timeout) clearTimeout(timeout);});
    // Work interrupted by shutdown is recovered through its expiring lease.
  }
}
