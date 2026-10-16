import { HttpException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ClientSession } from 'mongoose';
import { Database } from '../../database/database.module';
import { effectiveSubscription, featureLabels, planCatalog, ProFeature } from './catalog';

export class SubscriptionRequired extends HttpException {
  constructor(message: string, code = 'SUBSCRIPTION_REQUIRED', feature?: string) { super({message, code, feature, route: '/teacher/subscription'}, 402); }
}
@Injectable()
export class SubscriptionsService {
  constructor(readonly db: Database, readonly config: ConfigService) {}
  async ensure(workspaceId: string) {
    const existing = await this.db.collection('subscriptions').findOne({workspaceId}).lean();
    if(existing) return existing;
    if (!await this.db.collection('workspaces').exists({_id: workspaceId})) throw new NotFoundException('Workspace tidak ditemukan');
    const now = new Date();
    const trialEndsAt = new Date(now.getTime() + Number(this.config.get('SUBSCRIPTION_TRIAL_DAYS') ?? 14) * 86_400_000);
    // Existing workspaces receive one migration trial on first use. The unique
    // workspace index and $setOnInsert ensure logout/reinstall cannot reset it.
    try {
      return (await this.db.collection('subscriptions').findOneAndUpdate({workspaceId}, {$setOnInsert: {workspaceId, plan: 'trial', trialStartedAt: now, trialEndsAt}}, {upsert: true, returnDocument: 'after', setDefaultsOnInsert: true}).lean())!;
    } catch (error) {
      if ((error as {code?: number}).code !== 11000) throw error;
      return (await this.db.collection('subscriptions').findOne({workspaceId}).lean())!;
    }
  }
  async state(workspaceId: string) {
    const row = await this.ensure(workspaceId), now = new Date(), effective = effectiveSubscription(row, now);
    const catalog = planCatalog(this.config), selected = catalog.find(p => p.id === (row.plan === 'trial' ? 'pro' : row.plan))!;
    return {...effective, serverNow: now, trialStartedAt: row.trialStartedAt, trialEndsAt: row.trialEndsAt, studentLimit: row.plan === 'trial' ? 5 : selected.studentLimit, features: effective.active ? selected.features : []};
  }
  async current(workspaceId: string) {
    const [state, activeStudents] = await Promise.all([this.state(workspaceId), this.db.collection('students').countDocuments({workspaceId, status: 'active'})]);
    return {...state, activeStudents, trialDays: Number(this.config.get('SUBSCRIPTION_TRIAL_DAYS') ?? 14), featureLabels, plans: planCatalog(this.config)};
  }
  async requireActive(workspaceId: string) {
    const state = await this.state(workspaceId);
    if (!state.active) throw new SubscriptionRequired('Masa akses Anda telah berakhir. Pilih paket untuk melanjutkan mengajar. Data Anda tetap tersimpan.');
    return state;
  }
  async requireFeature(workspaceId: string, feature: ProFeature) {
    const state = await this.requireActive(workspaceId);
    if (!state.features.includes(feature)) throw new SubscriptionRequired(`${featureLabels[feature]} tersedia dalam paket Tutor Pro.`, 'FEATURE_NOT_INCLUDED', feature);
    return state;
  }
  async canUse(workspaceId: string, feature: ProFeature) {
    // A background scan must not start a trial for an unused legacy account.
    const row = await this.db.collection('subscriptions').findOne({workspaceId}).lean();
    return Boolean(row && effectiveSubscription(row).active && row.plan !== 'basic' && planCatalog(this.config)[1].features.includes(feature));
  }
  async capacity(workspaceId: string, session: ClientSession) {
    // Serialize additions/reactivations against this workspace's subscription.
    // Both the lock and count run in the student's creation transaction.
    const row = await this.db.collection('subscriptions').findOneAndUpdate({workspaceId}, {$inc: {usageVersion: 1}}, {session, returnDocument: 'after'}).lean();
    if (!row || !effectiveSubscription(row).active) throw new SubscriptionRequired('Masa akses Anda telah berakhir. Silakan berlangganan.');
    const plan = planCatalog(this.config).find(p => p.id === (row.plan === 'trial' ? 'pro' : row.plan))!;
    const count = await this.db.collection('students').countDocuments({workspaceId, status: 'active'}).session(session);
    const limit = row.plan === 'trial' ? 5 : plan.studentLimit;
    if (limit !== null && count >= limit) throw new SubscriptionRequired(`Batas ${limit} siswa aktif telah tercapai. Arsipkan siswa yang tidak aktif atau pilih paket lebih besar.`, 'STUDENT_LIMIT_REACHED');
  }
}
