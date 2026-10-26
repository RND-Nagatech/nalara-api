import { Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Amount, ApiError, AuthenticationError, ConfigurationError, InvalidAmountError, JsonNormalizationError, SingaPay } from '@aliziodev/singapay';

export function paymentCreationFailure(error: unknown) {
  const status = error instanceof ApiError ? error.status : undefined;
  const code = error instanceof ApiError && error.code && /^[A-Z0-9_-]{1,32}$/i.test(String(error.code)) ? String(error.code).toUpperCase() : undefined;
  // Explicit pre-creation rejections only. Duplicate/unknown-outcome responses
  // must retain their reference for inquiry, just like transport timeouts.
  const rejected = error instanceof AuthenticationError || error instanceof ConfigurationError
    || error instanceof InvalidAmountError || error instanceof JsonNormalizationError
    || (status !== undefined && [401, 403, 404, 405, 422].includes(status)
      && !['SP001', 'SP004', 'SP005'].includes(code ?? ''));
  return {rejected, status, code};
}

export const singapayCallback = '/api/v1/subscriptions/webhooks/singapay';
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const identifiers = (...values: unknown[]) => [...new Set(values.filter((value): value is string | number => (typeof value === 'string' && value.length > 0) || (typeof value === 'number' && Number.isSafeInteger(value))).map(String))];
export function paymentFacts(value: unknown) {
  const row = object(value), transaction = object(row.transaction), payment = object(row.payment), link = object(row.payment_link);
  const webhookLink = object(object(payment.additional_info).payment_link);
  const references = identifiers(row.payment_link_reff_no, link.reff_no, webhookLink.reff_no, transaction.payment_link_reff_no, payment.payment_link_reff_no);
  const linkIds = identifiers(row.payment_link_id, link.id, webhookLink.id, transaction.payment_link_id, payment.payment_link_id);
  const accountIds = identifiers(row.account_id, link.account_id, object(link.account).id, transaction.account_id, payment.account_id);
  const amount = transaction.amount ?? payment.amount ?? row.amount ?? row.total_amount;
  let rupiah: number | null = null;
  try { const value = object(amount).value ?? amount; if (typeof value === 'number' || typeof value === 'string') rupiah = Amount.from(value).value; } catch { /* Reject unknown amount shapes. */ }
  const currency = object(amount).currency ?? row.currency ?? 'IDR';
  return {reference: references.length === 1 ? references[0] : '', references, linkIds, accountIds,
    transactionReference: String(transaction.reff_no ?? payment.reff_no ?? row.reff_no ?? ''), amount: rupiah, currency,
    paid: ['paid', 'success', 'successful', 'completed', 'settlement'].includes(String(transaction.status ?? payment.status ?? row.status ?? '').toLowerCase()),
    id: String(row.id ?? transaction.id ?? '')};
}
@Injectable()
export class SingaPayProvider {
  private readonly client: SingaPay | null;
  private readonly accountId: string | undefined;
  constructor(config: ConfigService) {
    this.accountId = config.get<string>('SINGAPAY_ACCOUNT_ID')?.trim();
    const clientId = config.get<string>('SINGAPAY_CLIENT_ID')?.trim(), clientSecret = config.get<string>('SINGAPAY_CLIENT_SECRET')?.trim(), apiKey = config.get<string>('SINGAPAY_API_KEY')?.trim();
    this.client = config.get('SINGAPAY_ENABLED') === 'true' && clientId && clientSecret && apiKey
      ? new SingaPay({environment: config.get<'sandbox' | 'production'>('SINGAPAY_ENVIRONMENT') ?? 'sandbox', clientId, clientSecret, apiKey,
        accountId: this.accountId, timeoutMs: 15_000, retry: {times: 0},
        webhooks: {secrets: (config.get<string>('SINGAPAY_HMAC_KEY') ?? '').split(',').map(s => s.trim()).filter(Boolean)}}) : null;
  }
  get configured() { return Boolean(this.client); }
  private requireClient() {
    if (!this.client) throw new ServiceUnavailableException('Pembayaran sedang disiapkan. Silakan coba kembali setelah layanan pembayaran diaktifkan.');
    return this.client;
  }
  async create(reference: string, amount: number) {
    const response = await this.requireClient().paymentLinks.create({reff_no: reference, payment_link_type: 'total', total_amount: amount, max_usage: 1});
    const data = object(response.data), checkoutUrl = String(data.payment_url ?? data.checkout_url ?? '');
    let url: URL;
    try { url = new URL(checkoutUrl); } catch { throw new ServiceUnavailableException('Tautan pembayaran belum tersedia. Periksa kembali status pembayaran sebelum mencoba ulang.'); }
    if (url.protocol !== 'https:') throw new ServiceUnavailableException('Tautan pembayaran tidak valid.');
    return {checkoutUrl, providerId: String(data.id ?? data.payment_link_id ?? '')};
  }
  async recover(reference: string, amount: number) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.recoverHistory(reference, amount),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new ServiceUnavailableException('Daftar tautan pembayaran belum dapat dipastikan. Silakan periksa kembali.')), 8_000);
        }),
      ]);
    } finally { if (timer) clearTimeout(timer); }
  }
  private async recoverHistory(reference: string, amount: number) {
    const client = this.requireClient(), deadline = Date.now() + 8_000;
    let perPage = 25, expectedPages: number | undefined;
    for (let page = 1; page <= 5; page++) {
      if (Date.now() > deadline) throw new ServiceUnavailableException('Pemeriksaan tautan pembayaran belum selesai.');
      // The installed endpoint wrapper has no pagination argument. Its public
      // signed transport preserves credential/account scoping for later pages.
      const response = page === 1 ? await client.paymentLinks.list() : await client.client.send({
        method: 'GET', path: `/api/v1.0/payment-link-manage/${encodeURIComponent(this.accountId!)}`,
        query: {page, per_page: perPage},
      });
      const rows = response.items ?? [];
      const matches = rows.map(object).filter(row => row.reff_no === reference);
      if (matches.length > 1) throw new ServiceUnavailableException('Identitas tautan pembayaran tidak konsisten.');
      if (matches.length === 1) {
        const row = matches[0], account = object(row.account);
        let actualAmount: number | undefined;
        try { actualAmount = Amount.from(row.total_amount as string | number ?? row.amount as string | number).value; } catch { /* Fail closed below. */ }
        const providerId = String(row.id ?? row.payment_link_id ?? '');
        if (actualAmount !== amount || (row.currency && row.currency !== 'IDR')
          || (account.id && String(account.id) !== this.accountId) || !/^\d+$/.test(providerId)) {
          throw new ServiceUnavailableException('Identitas tautan pembayaran belum dapat dikonfirmasi.');
        }
        const checkoutUrl = String(row.payment_url ?? row.checkout_url ?? '');
        try { if (new URL(checkoutUrl).protocol === 'https:') return {providerId, checkoutUrl}; } catch { /* Retain ID for safe cancellation, never launch an invalid URL. */ }
        return {providerId};
      }
      const pagination = object(object(response.raw).pagination);
      const current = Number(pagination.currentPage ?? pagination.current_page);
      const last = Number(pagination.totalPages ?? pagination.last_page);
      if (current !== page || !Number.isSafeInteger(last) || last < 0 || (last > page && rows.length === 0)
        || (expectedPages !== undefined && expectedPages !== last)) {
        throw new ServiceUnavailableException('Daftar tautan pembayaran belum lengkap. Silakan periksa kembali.');
      }
      if (page >= last) return null;
      expectedPages = last;
      const size = Number(pagination.perPage ?? pagination.per_page ?? 25);
      if (!Number.isSafeInteger(size) || size < 1 || size > 100) throw new ServiceUnavailableException('Ukuran halaman pembayaran tidak valid.');
      perPage = size;
    }
    throw new ServiceUnavailableException('Daftar tautan pembayaran masih perlu diperiksa. Silakan coba kembali.');
  }
  async cancel(providerId: string) {
    if(!/^\d+$/.test(providerId)) throw new ServiceUnavailableException('Tautan pembayaran belum dapat dibatalkan. Periksa pembayaran kembali.');
    try { await this.requireClient().paymentLinks.delete(Number(providerId)); }
    catch (error) {
      // An earlier cancellation may have reached the provider while its response
      // was lost. Only an explicit 404 is idempotent, not 403/timeout/5xx.
      if (!(error instanceof ApiError && error.status === 404)) throw error;
    }
  }
  async paid(reference: string, amount: number, providerId?: string) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.paidHistory(reference, amount, providerId),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new ServiceUnavailableException('Pemeriksaan pembayaran belum selesai. Silakan periksa kembali.')), 8_000);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  private async paidHistory(reference: string, amount: number, providerId?: string) {
    const client = this.requireClient(), deadline = Date.now() + 8_000;
    // History reff_no identifies the *transaction*, not our payment link.
    // There is no documented payment_link_reff_no filter; inspect scoped,
    // paginated histories and always compare the immutable link identity locally.
    for (let page = 1; page <= 5; page++) {
      if (Date.now() > deadline) throw new ServiceUnavailableException('Pemeriksaan pembayaran belum selesai. Silakan periksa kembali.');
      const response = await client.paymentLinkHistories.list(undefined, {amount, status: 'paid', per_page: 100, page, sort_by: 'id', sort_order: 'desc'});
      const rows = response.items ?? [];
      const found = rows.map(paymentFacts).find(row => row.reference === reference && row.paid && row.amount === amount && row.currency === 'IDR'
        && (!providerId || (row.linkIds.length === 1 && row.linkIds[0] === providerId))
        && row.accountIds.every(id => !this.accountId || id === this.accountId));
      if (found) return found;
      const pagination = object(object(response.raw).pagination);
      const currentPage = Number(pagination.currentPage ?? pagination.current_page);
      const totalPages = Number(pagination.totalPages ?? pagination.last_page);
      if (currentPage !== page || !Number.isSafeInteger(totalPages) || totalPages < 0 || (totalPages > page && rows.length === 0)) {
        throw new ServiceUnavailableException('Halaman riwayat pembayaran tidak dapat dikonfirmasi. Silakan periksa kembali.');
      }
      if (page >= totalPages) return null;
    }
    throw new ServiceUnavailableException('Riwayat pembayaran masih perlu diperiksa. Silakan coba kembali atau hubungi dukungan dengan nomor referensi.');
  }
  async verify(rawBody: string, headers: Record<string, string | string[] | undefined>) {
    try { return await this.requireClient().verifyWebhook(rawBody, headers, singapayCallback); }
    catch (error) { if (error instanceof ServiceUnavailableException) throw error; throw new UnauthorizedException('Signature pembayaran tidak valid.'); }
  }
}
