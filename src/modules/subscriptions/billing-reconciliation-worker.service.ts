import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import type { QueryFilter } from 'mongoose';
import { Database } from '../../database/database.module';
import type { SubscriptionOrder } from '../../database/entities';
import { BillingService } from './billing.service';

export function billingRetryFilter(now = new Date()): QueryFilter<SubscriptionOrder> {
  return {open: true, status: {$in: ['creating', 'pending']}, $and: [
    {$or: [{reconcileNextAttemptAt: {$lte: now}}, {reconcileNextAttemptAt: {$exists: false}}]},
    {$or: [{reconcileLeaseUntil: {$lte: now}}, {reconcileLeaseUntil: {$exists: false}}]},
  ]};
}
export function billingRetryDelay(attempt: number) {
  return Math.min(6 * 60 * 60_000, 60_000 * 2 ** Math.min(16, Math.max(0, attempt - 1))) + Math.floor(Math.random() * 10_000);
}

@Injectable()
export class BillingReconciliationWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BillingReconciliationWorker.name);
  private timer?: ReturnType<typeof setInterval>;
  private inFlight?: Promise<void>;
  private stopped = false;

  constructor(private readonly db: Database, private readonly config: ConfigService, private readonly billing: BillingService) {}

  onModuleInit() {
    this.timer = setInterval(() => void this.run(), Number(this.config.get('BILLING_RECONCILIATION_INTERVAL_SECONDS') ?? 60) * 1000);
    this.timer.unref();
    void this.run();
  }

  run(): Promise<void> {
    if (this.stopped || !this.billing.provider.configured) return Promise.resolve();
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.scan().catch(() => {
      this.logger.warn({event: 'billing.reconciliation.scan_failed'}, 'Pending orders remain available for recovery');
    }).finally(() => {this.inFlight = undefined;});
    return this.inFlight;
  }

  private async scan() {
    const records = await this.db.collection('subscriptionOrders').find(billingRetryFilter())
      .select('_id').sort({reconcileNextAttemptAt: 1, _id: 1}).limit(Number(this.config.get('BILLING_RECONCILIATION_BATCH_SIZE') ?? 10)).lean();
    // Deliberately low concurrency: the provider is shared by every workspace.
    for (let offset = 0; offset < records.length && !this.stopped; offset += 2) {
      const batch = records.slice(offset, offset + 2);
      const results = await Promise.allSettled(batch.map(order => this.process(order._id)));
      for (const [index, result] of results.entries()) {
        if (result.status === 'rejected') this.logger.warn({event:'billing.reconciliation.state_unavailable',orderId:batch[index]._id}, 'Order lease remains recoverable');
      }
    }
  }

  private async process(id: string) {
    const now = new Date();
    const order = await this.db.collection('subscriptionOrders').findOneAndUpdate(
      {_id: id, ...billingRetryFilter(now)},
      {$set: {reconcileClaimId: randomUUID(), reconcileLeaseUntil: new Date(now.getTime() + 2 * 60_000)}, $inc: {reconcileAttempts: 1}},
      {returnDocument: 'after'},
    ).lean();
    if (!order) return;
    let errorType: string | undefined;
    try {
      // Reuse exactly the same provider verification + idempotent transaction
      // as authenticated sync and the signed webhook. No manual paid override.
      await this.billing.reconcile(order.reference);
      await this.billing.recoverLink(order.reference);
    } catch (error) {
      errorType = error instanceof Error ? error.name : 'Unknown';
      this.logger.warn({event: 'billing.reconciliation.retry_scheduled', orderId: id, errorType}, 'Payment verification will be retried');
    }
    await this.db.collection('subscriptionOrders').updateOne({_id: id, reconcileClaimId: order.reconcileClaimId}, {
      $set: {lastReconciledAt: new Date(), reconcileNextAttemptAt: new Date(Date.now() + billingRetryDelay(order.reconcileAttempts ?? 1)), ...(errorType ? {lastReconcileError: errorType} : {})},
      $unset: {reconcileClaimId: 1, reconcileLeaseUntil: 1, ...(!errorType ? {lastReconcileError: 1 as const} : {})},
    });
    if ((order.reconcileAttempts ?? 0) >= 10) {
      const unresolved = await this.db.collection('subscriptionOrders').exists({_id: id, open: true, status: {$in: ['creating', 'pending']}});
      if (unresolved) this.logger.warn({event: 'billing.reconciliation.needs_attention', orderId: id, attempts: order.reconcileAttempts}, 'Inspect unresolved payment; never charge again automatically');
    }
  }

  async onModuleDestroy() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (!this.inFlight) return;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([this.inFlight, new Promise<void>(resolve => {timeout = setTimeout(resolve, 10_000);})])
      .finally(() => {if (timeout) clearTimeout(timeout);});
  }
}
