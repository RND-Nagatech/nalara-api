import { ConflictException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { Principal } from '../../common/api';
import { Database } from '../../database/database.module';
import { nextBillingDate, PaidPlan, planCatalog } from './catalog';
import { SubscriptionsService } from './subscriptions.service';
import { paymentFacts, SingaPayProvider } from './singapay.provider';
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
      if (existing.plan !== planId) throw new ConflictException('Masih ada pembayaran paket lain yang belum selesai. Selesaikan pembayaran tersebut terlebih dahulu.');
      if (!existing.checkoutUrl) throw new ConflictException('Pembayaran sedang dikonfirmasi. Periksa status pembayaran; jangan membuat pembayaran ganda.');
      return existing;
    }
    const reference = `NLR-${randomUUID().replace(/-/g, '')}`;
    try { existing = (await this.db.collection('subscriptionOrders').create({workspaceId: actor.workspaceId, reference, plan: planId, amount: plan.price, currency: 'IDR'})).toObject(); }
    catch (error) { if ((error as {code?: number}).code === 11000) throw new ConflictException('Pembayaran lain sedang dibuat. Muat ulang halaman langganan.'); throw error; }
    try {
      const link = await this.provider.create(reference, plan.price);
      await this.db.collection('subscriptionOrders').updateOne({_id: existing._id, status: 'creating'}, {$set: {status: 'pending'}});
      return await this.db.collection('subscriptionOrders').findOneAndUpdate({_id: existing._id, workspaceId: actor.workspaceId}, {$set: link}, {returnDocument: 'after'}).lean();
    } catch {
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
    } catch (error) {
      // Preserve the current entitlement if the provider is unavailable; never
      // turn a failed lookup into a successful payment or expose provider secrets.
      this.logger.warn({event: 'subscription.payment.sync_failed', orderId: order._id, errorType: error instanceof Error ? error.name : 'unknown'});
      return 'Status pembayaran belum dapat disinkronkan. Paket sebelumnya tetap ditampilkan. Silakan periksa pembayaran kembali.';
    }
  }
  async refresh(actor: Principal, id: string) {
    const order = await this.db.collection('subscriptionOrders').findOne({_id: id, workspaceId: actor.workspaceId}).lean();
    if (!order) throw new NotFoundException('Pembayaran tidak ditemukan.');
    if (order.status !== 'paid') {
      await this.reconcile(order.reference);
      const latest = await this.db.collection('subscriptionOrders').findOne({_id: id, workspaceId: actor.workspaceId}).lean();
      if (latest && latest.status !== 'paid' && !latest.checkoutUrl && latest.open) {
        const recovered = await this.provider.recover(order.reference,order.amount);
        if(recovered) await this.db.collection('subscriptionOrders').updateOne({_id:id,workspaceId:actor.workspaceId,status:'creating'},{$set:{...recovered,status:'pending'}});
      }
    }
    return (await this.db.collection('subscriptionOrders').findOne({_id: id, workspaceId: actor.workspaceId}).lean())!;
  }
  async cancel(actor: Principal, id: string) {
    const order = await this.refresh(actor,id);
    if(order.status === 'paid') throw new ConflictException('Pembayaran sudah berhasil dan tidak dapat dibatalkan.');
    if(!order.open) return order;
    if(!order.providerId) throw new ConflictException('Status pembayaran belum pasti. Periksa kembali atau hubungi dukungan dengan nomor referensi.');
    await this.provider.cancel(order.providerId);
    return this.db.collection('subscriptionOrders').findOneAndUpdate({_id:id,workspaceId:actor.workspaceId,status:{$ne:'paid'}},{$set:{open:false,status:'failed'}},{returnDocument:'after'}).lean();
  }
  async reconcile(reference: string) {
    const order = await this.db.collection('subscriptionOrders').findOne({reference}).lean();
    if (!order || order.status === 'paid') return;
    if (!await this.provider.paid(order.reference, order.amount, order.providerId)) return;
    await this.db.connection.transaction(async session => {
      const current = await this.db.collection('subscriptions').findOneAndUpdate({workspaceId: order.workspaceId}, {$inc: {usageVersion: 1}}, {session, returnDocument: 'after'}).lean();
      if (!current) throw new NotFoundException('Langganan tidak ditemukan.');
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
