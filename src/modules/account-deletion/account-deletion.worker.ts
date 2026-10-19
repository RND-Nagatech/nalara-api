import { Injectable, Logger, OnModuleDestroy, OnModuleInit, ConflictException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import type { QueryFilter } from 'mongoose';
import { Database } from '../../database/database.module';
import type { AccountDeletion, Collections } from '../../database/entities';
import { FirebaseAuthService } from '../auth/firebase-auth.service';
import { BillingService } from '../subscriptions/billing.service';
import { LogoStorage } from '../../storage/logo-storage.service';

export const erasedWorkspaceCollections = [
  'notificationDevices', 'notifications', 'invitations', 'rescheduleRequests',
  'submissions', 'assignments', 'reportTemplates', 'tutorPreferences',
  'histories', 'reports', 'targets', 'plans', 'sessions', 'schedules',
  'subjects', 'students', 'families', 'audits',
] as const;
type ErasedCollection = typeof erasedWorkspaceCollections[number];
// Adding a collection must explicitly choose how account erasure handles it.
export const collectionErasurePolicy: Record<keyof Collections, 'workspace-batch'|'special'|'tombstone'> = {
  users: 'special', workspaces: 'special', authSessions: 'special', portalSessions: 'special',
  portalAccounts: 'special', subscriptions: 'special', subscriptionOrders: 'special', billingEvents: 'special',
  accountDeletions: 'tombstone',
  families: 'workspace-batch', students: 'workspace-batch', subjects: 'workspace-batch',
  schedules: 'workspace-batch', sessions: 'workspace-batch', plans: 'workspace-batch', targets: 'workspace-batch',
  histories: 'workspace-batch', reports: 'workspace-batch', invitations: 'workspace-batch',
  notifications: 'workspace-batch', notificationDevices: 'workspace-batch', rescheduleRequests: 'workspace-batch',
  audits: 'workspace-batch', assignments: 'workspace-batch', submissions: 'workspace-batch',
  reportTemplates: 'workspace-batch', tutorPreferences: 'workspace-batch',
};
const pageSize = 500;

export function deletionDue(now = new Date()): QueryFilter<AccountDeletion> {
  return {nextAttemptAt: {$lte: now}, $or: [{leaseUntil: {$exists: false}}, {leaseUntil: {$lte: now}}]};
}

@Injectable()
export class AccountDeletionWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AccountDeletionWorker.name);
  private timer?: ReturnType<typeof setInterval>;
  private inFlight?: Promise<void>;
  private stopped = false;
  constructor(private readonly db: Database, private readonly firebase: FirebaseAuthService,
    private readonly billing: BillingService, private readonly config: ConfigService, private readonly logos: LogoStorage) {}

  onModuleInit() {
    this.timer = setInterval(() => void this.run(), Number(this.config.get('ACCOUNT_DELETION_INTERVAL_SECONDS') ?? 60) * 1000);
    this.timer.unref();
    void this.run();
  }

  run(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.scan().catch(() => this.logger.warn({event: 'account.deletion.scan_failed'}, 'Deletion requests remain durable'))
      .finally(() => {this.inFlight = undefined;});
    return this.inFlight;
  }

  private async scan() {
    const jobs = await this.db.collection('accountDeletions').find(deletionDue()).select('_id')
      .sort({nextAttemptAt: 1, _id: 1}).limit(Number(this.config.get('ACCOUNT_DELETION_BATCH_SIZE') ?? 5)).lean();
    for (const job of jobs) {
      if (this.stopped) break;
      try { await this.process(job._id); }
      catch { this.logger.warn({event: 'account.deletion.state_unavailable', jobId: job._id}, 'Deletion lease remains recoverable'); }
    }
  }

  private async process(id: string) {
    const now = new Date();
    const job = await this.db.collection('accountDeletions').findOneAndUpdate({_id: id, ...deletionDue(now)},
      {$set: {status: 'processing', claimId: randomUUID(), leaseUntil: new Date(now.getTime() + 10 * 60_000)}, $inc: {attempts: 1}},
      {returnDocument: 'after'}).lean();
    if (!job) return;
    let complete = false;
    try {
      const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      if (!uuid.test(job.workspaceId) || !uuid.test(job.userId)) throw new ConflictException('Invalid deletion target');
      const workspace = await this.db.collection('workspaces').findOne({_id: job.workspaceId}).lean();
      // Do not widen an old request to a transferred/shared workspace.
      if ((workspace && (workspace.ownerId !== job.userId || !workspace.deletionRequestedAt)) ||
          await this.db.collection('users').exists({workspaceId: job.workspaceId, _id: {$ne: job.userId}})) {
        throw new ConflictException('Deletion ownership changed');
      }
      const filter = {workspaceId: job.workspaceId};
      await this.db.collection('authSessions').deleteMany({userId: job.userId});
      const accounts = await this.db.collection('portalAccounts').find(filter).select('_id').limit(pageSize).lean();
      await this.db.collection('portalSessions').deleteMany({accountId: {$in: accounts.map(account => account._id)}});
      await this.db.collection('portalAccounts').deleteMany({...filter, _id: {$in: accounts.map(account => account._id)}});
      // Bounded, idempotent deletion. Repeated passes also catch pre-deletion
      // in-flight writes; the tombstone is rechecked after completion.
      for (const name of erasedWorkspaceCollections) {
        await this.renew(job);
        await this.eraseBatch(name, job.workspaceId);
      }
      await this.db.collection('users').deleteMany({_id: job.userId, workspaceId: job.workspaceId});

      let externalPending = false;
      try {
        await this.renew(job);
        if (!await this.logos.purgeWorkspace(job.workspaceId)) externalPending = true;
      } catch {
        externalPending = true;
        this.logger.warn({event: 'account.deletion.logo_cleanup_pending', jobId: id}, 'Private logo files remain scheduled for erasure');
      }
      try { await this.eraseOrders(job); }
      catch (error) {
        externalPending = true;
        this.logger.warn({event: 'account.deletion.payment_cleanup_pending', jobId: id, errorType: error instanceof Error ? error.name : 'Unknown'}, 'Unpaid links will be checked again; no refund or new charge is created');
      }
      if (job.firebaseUid) {
        try {
          await this.renew(job);
          await this.firebase.deleteUser(job.firebaseUid);
          await this.db.collection('accountDeletions').updateOne({_id: id, claimId: job.claimId}, {$unset: {firebaseUid: 1}});
        } catch (error) {
          externalPending = true;
          this.logger.warn({event: 'account.deletion.firebase_cleanup_pending', jobId: id, errorType: error instanceof Error ? error.name : 'Unknown'}, 'Firebase identity cleanup will retry');
        }
      }
      const remaining = await Promise.all([
        ...erasedWorkspaceCollections.map(name => this.db.collection(name).exists(filter)),
        this.db.collection('portalAccounts').exists(filter),
        this.db.collection('subscriptionOrders').exists(filter),
      ]);
      complete = !externalPending && !remaining.some(Boolean);
      if (complete) {
        await this.renew(job);
        await this.db.collection('subscriptions').deleteMany(filter);
        await this.db.collection('workspaces').deleteMany({_id: job.workspaceId, ownerId: job.userId, deletionRequestedAt: {$exists: true}});
      }
    } catch (error) {
      complete = false;
      this.logger.warn({event: 'account.deletion.retry_scheduled', jobId: id, errorType: error instanceof Error ? error.name : 'Unknown'}, 'Account access remains closed while erasure retries');
    }
    const delay = complete ? 24 * 60 * 60_000 : Math.min(60 * 60_000, 60_000 * 2 ** Math.min(6, Math.max(0, job.attempts - 1)));
    const checkpoint = await this.db.collection('accountDeletions').updateOne({_id: id, claimId: job.claimId}, {
      $set: {status: complete ? 'completed' : 'pending', nextAttemptAt: new Date(Date.now() + delay),
        ...(complete && !job.completedAt ? {completedAt: new Date()} : {})},
      $unset: {claimId: 1, leaseUntil: 1},
    });
    if (complete && checkpoint.matchedCount === 1) this.logger.log({event: 'account.deletion.completed', jobId: id});
  }

  private async renew(job: AccountDeletion) {
    if (this.stopped) throw new ConflictException('Deletion worker stopping');
    const renewed = await this.db.collection('accountDeletions').updateOne(
      {_id: job._id, claimId: job.claimId, leaseUntil: {$gt: new Date()}},
      {$set: {leaseUntil: new Date(Date.now() + 10 * 60_000)}});
    if (renewed.matchedCount !== 1) throw new ConflictException('Deletion lease lost');
  }

  private async eraseBatch<K extends ErasedCollection>(name: K, workspaceId: string) {
    const model = this.db.collection(name);
    const rows = await model.find({workspaceId} as QueryFilter<Collections[K]>).select('_id').limit(pageSize).lean() as {_id: string}[];
    if (rows.length) await model.deleteMany({workspaceId, _id: {$in: rows.map(row => row._id)}} as QueryFilter<Collections[K]>);
  }

  private async eraseOrders(job: AccountDeletion) {
    const workspaceId = job.workspaceId;
    const orders = await this.db.collection('subscriptionOrders').find({workspaceId}).limit(20).lean();
    for (const order of orders) {
      await this.renew(job);
      if (order.open && order.status !== 'paid') {
        try { await this.billing.cancel({workspaceId}, order._id); }
        catch (error) {
          const paid = await this.db.collection('subscriptionOrders').exists({_id: order._id, workspaceId, status: 'paid'});
          if (!paid) throw error;
        }
      }
      if (typeof order.reference !== 'string' || !order.reference.startsWith('NLR-')) throw new ConflictException('Invalid payment reference');
      await this.db.collection('billingEvents').deleteMany({reference: order.reference});
      await this.db.collection('subscriptionOrders').deleteMany({_id: order._id, workspaceId});
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
