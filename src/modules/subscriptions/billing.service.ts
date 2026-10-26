import { ConflictException, HttpException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { Principal } from '../../common/api';
import { Database } from '../../database/database.module';
import type { SubscriptionOrder } from '../../database/entities';
import { nextBillingDate, PaidPlan, planCatalog } from './catalog';
import { SubscriptionsService } from './subscriptions.service';
import { paymentCreationFailure, paymentFacts, SingaPayProvider } from './singapay.provider';

const creationGraceMs = 2 * 60_000;
@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);
  constructor(private readonly db: Database, private readonly subscriptions: SubscriptionsService, readonly provider: SingaPayProvider) {}
  async checkout(actor: Principal, planId: PaidPlan) {
    const current = await this.subscriptions.state(actor.workspaceId);
    if (current.active && current.plan === 'pro' && planId === 'basic') throw new ConflictException('Paket Pro Anda masih aktif. Pilih Basic setelah periode Pro berakhir agar manfaat saat ini tetap tersedia.');
    const plan = planCatalog(this.subscriptions.config).find(p => p.id === planId)!;
    if (!plan.price || !this.provider.configured) throw new ServiceUnavailableException('Paket ini belum dapat dibeli. Harga dan pembayaran sedang disiapkan.');
    const activeStudents = await this.db.collection('students').countDocuments({workspaceId: actor.workspaceId, status: 'active'});
    if (plan.studentLimit !== null && activeStudents > plan.studentLimit) throw new ConflictException(`Paket ini menampung ${plan.studentLimit} siswa aktif. Arsipkan siswa yang tidak aktif terlebih dahulu atau pilih Tutor Pro.`);
    let existing = await this.db.collection('subscriptionOrders').findOne({workspaceId: actor.workspaceId, open: true}).lean();
    if (existing) {
      if (existing.plan !== planId) throw new ConflictException('Masih ada order paket lain yang terbuka. Buka Riwayat pembayaran, lalu lanjutkan atau batalkan order tersebut sebelum memilih paket baru.');
      if (!existing.checkoutUrl) throw new ConflictException('Tautan pembayaran order sebelumnya belum tersedia. Buka Riwayat pembayaran untuk memeriksa atau membatalkan order; belum ada pembayaran yang dinyatakan berhasil.');
      return existing;
    }
    const reference = `NLR-${randomUUID().replace(/-/g, '')}`;
    const creationLeaseUntil = new Date(Date.now() + creationGraceMs);
    try { existing = (await this.db.collection('subscriptionOrders').create({workspaceId: actor.workspaceId, reference, plan: planId, amount: plan.price, currency: 'IDR', creationLeaseUntil})).toObject(); }
    catch (error) { if ((error as {code?: number}).code === 11000) throw new ConflictException('Pembayaran lain sedang dibuat. Muat ulang halaman langganan.'); throw error; }
    try {
      const link = await this.provider.create(reference, plan.price);
      const saved = await this.db.collection('subscriptionOrders').findOneAndUpdate(
        {_id: existing._id, workspaceId: actor.workspaceId, open: true, status: 'creating'},
        {$set: {...link, status: 'pending', creationFinishedAt: new Date()}, $unset: {creationLeaseUntil: 1}},
        {returnDocument: 'after'},
      ).lean();
      // A verified webhook/recovery may have won while create was in flight.
      return saved ?? await this.order(actor.workspaceId, existing._id);
    } catch (error) {
      const failure = paymentCreationFailure(error);
      this.logger.warn({event: 'subscription.checkout.create_failed', orderId: existing._id,
        errorType: error instanceof Error ? error.name : 'Unknown', providerStatus: failure.status, providerCode: failure.code,
        definitiveRejection: failure.rejected});
      await this.db.collection('subscriptionOrders').updateOne(
        {_id: existing._id, workspaceId: actor.workspaceId, open: true, status: 'creating'},
        {$set: {creationFinishedAt: new Date(), ...(failure.status ? {creationErrorStatus: failure.status} : {}),
          ...(failure.code ? {creationErrorCode: failure.code} : {}), ...(failure.rejected ? {status: 'failed', open: false} : {})},
          ...(failure.rejected ? {$unset: {creationLeaseUntil: 1}} : {})},
      );
      if (failure.rejected) throw new ServiceUnavailableException({code: 'PAYMENT_CREATION_REJECTED',
        message: 'Penyedia menolak pembuatan tautan pembayaran. Order ini sudah ditutup dan belum dinyatakan terbayar. Silakan coba kembali; bila berulang, hubungi dukungan dengan nomor referensi.'});
      // A timeout may mean the provider DID create the link. Preserve the
      // reference for reconciliation instead of issuing another charge.
      throw new ServiceUnavailableException('Status pembuatan pembayaran belum dapat dipastikan. Gunakan Periksa pembayaran; langganan hanya aktif setelah pembayaran terverifikasi.');
    }
  }
  async history(actor: Principal, page: number, limit: number) {
    const filter = {workspaceId: actor.workspaceId};
    const [items, total] = await Promise.all([this.db.collection('subscriptionOrders').find(filter).sort({createdAt: -1}).skip((page - 1) * limit).limit(limit).lean(), this.db.collection('subscriptionOrders').countDocuments(filter)]);
    return {items, total, page, limit};
  }
  async synchronize(actor: Principal): Promise<string | undefined> {
    const order = await this.db.collection('subscriptionOrders').findOne({workspaceId: actor.workspaceId, open: true, status: {$in: ['creating', 'pending']}}).lean();
    if (!order) return;
    try {
      await this.reconcile(order.reference);
      await this.recoverLink(order.reference);
    } catch (error) {
      // Preserve the current entitlement if the provider is unavailable; never
      // turn a failed lookup into a successful payment or expose provider secrets.
      this.logger.warn({event: 'subscription.payment.sync_failed', orderId: order._id, errorType: error instanceof Error ? error.name : 'unknown'});
      return 'Status pembayaran belum dapat disinkronkan. Paket sebelumnya tetap ditampilkan. Silakan periksa pembayaran kembali.';
    }
  }
  async refresh(actor: Pick<Principal, 'workspaceId'>, id: string) {
    const order = await this.order(actor.workspaceId, id);
    if (order.open && order.status !== 'paid') {
      await this.reconcile(order.reference);
      const latest = await this.db.collection('subscriptionOrders').findOne({_id: id, workspaceId: actor.workspaceId}).lean();
      if (latest && latest.status !== 'paid' && (!latest.checkoutUrl || !latest.providerId) && latest.open) {
        await this.recoverLink(order.reference);
      }
    }
    return this.order(actor.workspaceId, id);
  }
  async recoverLink(reference: string) {
    const order = await this.db.collection('subscriptionOrders').findOne({reference,open:true,status:{$in:['creating','pending']}}).lean();
    if (!order) return;
    if (order.checkoutUrl && order.providerId) return true;
    // Recovery is read-only at the provider. Never create another link/charge
    // merely because the response to the original request was lost.
    const recovered = await this.providerOperation(order, 'recover', () => this.provider.recover(order.reference,order.amount));
    if (recovered) await this.db.collection('subscriptionOrders').updateOne({_id:order._id,workspaceId:order.workspaceId,open:true,status:{$in:['creating','pending']}},{$set:{...recovered,status:'pending'}});
    return recovered !== null;
  }
  async cancel(actor: Pick<Principal, 'workspaceId'>, id: string) {
    let order = await this.order(actor.workspaceId, id);
    if(order.status === 'paid') throw new ConflictException('Pembayaran sudah berhasil dan tidak dapat dibatalkan.');
    if(!order.open) return order;
    if (this.creationInFlight(order)) throw new ConflictException('Tautan pembayaran masih dalam proses pembuatan. Tunggu hingga dua menit sejak order dibuat, lalu coba Batalkan kembali.');
    // Both provider reads must succeed. A timeout, incomplete page or mismatched
    // identity is not evidence that a link/payment never existed.
    await this.reconcile(order.reference);
    order = await this.order(actor.workspaceId, id);
    if (order.status === 'paid') throw new ConflictException('Pembayaran sudah berhasil dan tidak dapat dibatalkan.');
    if (!order.open) return order;
    if (!order.providerId) {
      const found = await this.recoverLink(order.reference);
      order = await this.order(actor.workspaceId, id);
      if (order.status === 'paid') throw new ConflictException('Pembayaran sudah berhasil dan tidak dapat dibatalkan.');
      if (!order.open) return order;
      if (!order.providerId && found !== false) throw new ConflictException('Identitas pembayaran belum dapat dipastikan. Silakan periksa kembali sebelum membatalkan.');
    }
    if (this.creationInFlight(order)) throw new ConflictException('Pembuatan tautan pembayaran belum selesai. Silakan coba kembali.');
    if (order.providerId) {
      const providerId = order.providerId;
      await this.providerOperation(order, 'cancel', () => this.provider.cancel(providerId));
      // Recheck settlement after deletion acknowledgement, including a retry
      // whose original delete response was lost. Provider errors leave it open.
      await this.reconcile(order.reference);
    }
    const closed = await this.db.collection('subscriptionOrders').findOneAndUpdate(
      {_id:id,workspaceId:actor.workspaceId,open:true,status:{$in:['creating','pending']},
        ...(order.providerId ? {providerId:order.providerId} : {$or:[{providerId:{$exists:false}},{providerId:''},{providerId:null}]} )},
      {$set:{open:false,status:'cancelled',cancelledAt:new Date()},$unset:{creationLeaseUntil:1}},
      {returnDocument:'after'},
    ).lean();
    const latest = closed ?? await this.order(actor.workspaceId, id);
    if (latest.status === 'paid') throw new ConflictException('Pembayaran sudah berhasil dan tidak dapat dibatalkan.');
    if (latest.open) throw new ConflictException('Status order berubah saat pembatalan. Periksa pembayaran kembali.');
    return latest;
  }
  private async order(workspaceId: string, id: string): Promise<SubscriptionOrder> {
    const order = await this.db.collection('subscriptionOrders').findOne({_id:id,workspaceId}).lean();
    if (!order) throw new NotFoundException('Pembayaran tidak ditemukan.');
    return order;
  }
  private creationInFlight(order: SubscriptionOrder) {
    if (order.status !== 'creating') return false;
    const deadline = order.creationLeaseUntil?.getTime() ?? new Date(order.createdAt).getTime() + creationGraceMs;
    return !Number.isFinite(deadline) || deadline > Date.now();
  }
  private async providerOperation<T>(order: SubscriptionOrder, operation: string, action: () => Promise<T>): Promise<T> {
    try { return await action(); }
    catch (error) {
      if (error instanceof HttpException) throw error;
      const failure = paymentCreationFailure(error);
      this.logger.warn({event: 'subscription.provider.operation_failed', orderId: order._id, operation,
        errorType: error instanceof Error ? error.name : 'Unknown', providerStatus: failure.status, providerCode: failure.code});
      throw new ServiceUnavailableException(operation === 'cancel'
        ? 'Pembatalan belum dikonfirmasi penyedia. Periksa pembayaran kembali sebelum membuat order baru.'
        : 'Status pembayaran belum dapat dipastikan dari penyedia. Silakan periksa kembali sebelum membuat order baru.');
    }
  }
  async reconcile(reference: string) {
    const order = await this.db.collection('subscriptionOrders').findOne({reference}).lean();
    if (!order || order.status === 'paid') return;
    if (!await this.providerOperation(order, 'paid', () => this.provider.paid(order.reference, order.amount, order.providerId))) return;
    await this.db.connection.transaction(async session => {
      const current = await this.db.collection('subscriptions').findOneAndUpdate({workspaceId: order.workspaceId, deletionRequestedAt: {$exists: false}}, {$inc: {usageVersion: 1}}, {session, returnDocument: 'after'}).lean();
      if (!current) {
        if (await this.db.collection('accountDeletions').exists({workspaceId: order.workspaceId}).session(session)) {
          // Record a provider-verified settlement for cleanup, never reactivate
          // an account whose deletion has already been accepted.
          await this.db.collection('subscriptionOrders').updateOne({_id: order._id, workspaceId: order.workspaceId, status: {$ne: 'paid'}}, {$set: {status: 'paid', open: false, paidAt: new Date()}}, {session});
          return;
        }
        throw new NotFoundException('Langganan tidak ditemukan.');
      }
      const claimed = await this.db.collection('subscriptionOrders').findOneAndUpdate({_id: order._id, status: {$ne: 'paid'}}, {$set: {status: 'paid', open: false, paidAt: new Date()}}, {session, returnDocument: 'after'}).lean();
      if (!claimed) return;
      const now = new Date();
      const periodStart = current.paidThrough && current.paidThrough > now ? current.paidThrough : now;
      const periodEnd = nextBillingDate(periodStart);
      await this.db.collection('subscriptions').updateOne({_id: current._id}, {$set: {plan: order.plan, paidThrough: periodEnd}}, {session});
      await this.db.collection('subscriptionOrders').updateOne({_id: order._id}, {$set: {periodStart, periodEnd}}, {session});
      await this.db.collection('audits').create([{workspaceId: order.workspaceId, actorId: 'singapay', action: 'subscription.payment.verified', resourceId: order._id}], {session});
    });
  }
  async webhook(raw: string, headers: Record<string, string | string[] | undefined>) {
    const verified = await this.provider.verify(raw, headers);
    const eventHash = createHash('sha256').update(raw).digest('hex');
    if (await this.db.collection('billingEvents').exists({eventHash})) return {received: true};
    if (verified.type !== 'payment-link-transaction') return {received: true, ignored: true};
    const facts = paymentFacts(verified.payload.data);
    if (facts.references.length > 1) throw new ConflictException('Referensi payment link tidak konsisten.');
    const reference = facts.reference || facts.transactionReference;
    // Never trust callback/redirect success as proof: query the provider using
    // our stored reference and amount before granting any entitlement.
    if (!reference) throw new ConflictException('Referensi pembayaran tidak dikenali.');
    const known = await this.db.collection('subscriptionOrders').findOne({reference}).lean();
    if (!known) return {received: true, ignored: true};
    await this.reconcile(reference);
    const order = await this.db.collection('subscriptionOrders').findOne({reference}).lean();
    if(order && order.status !== 'paid') throw new ConflictException('Pembayaran masih menunggu konfirmasi penyedia.');
    try { await this.db.collection('billingEvents').create({eventHash, type: verified.type, reference}); }
    catch (error) { if ((error as {code?: number}).code !== 11000) throw error; }
    return {received: true};
  }
}
