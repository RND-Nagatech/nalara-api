import type { ConfigService } from '@nestjs/config';

export const proFeatures = ['recurringSchedules', 'reschedule', 'automaticReminders', 'reportTemplates', 'pdfExport', 'progressAnalytics', 'assignments', 'branding', 'dataExport', 'notificationPreferences'] as const;
export type ProFeature = typeof proFeatures[number];
export type PaidPlan = 'basic' | 'pro';
export const featureLabels: Record<ProFeature, string> = {
  recurringSchedules: 'Jadwal berulang', reschedule: 'Permintaan perubahan jadwal', automaticReminders: 'Pengingat otomatis H-1',
  reportTemplates: 'Template laporan', pdfExport: 'Laporan PDF', progressAnalytics: 'Analitik perkembangan',
  assignments: 'Tugas & materi teks', branding: 'Identitas laporan tutor', dataExport: 'Export data CSV', notificationPreferences: 'Preferensi notifikasi',
};
export function planCatalog(config: ConfigService) {
  const price = (key: string) => { const v = Number(config.get(key)); return Number.isSafeInteger(v) && v > 0 ? v : null; };
  return [
    {id: 'basic' as const, name: 'Tutor Basic', description: 'Fondasi mengajar yang tertata, setiap hari.', price: price('SUBSCRIPTION_BASIC_PRICE') ?? 39000, currency: 'IDR', period: 'month', studentLimit: Number(config.get('SUBSCRIPTION_BASIC_STUDENTS') ?? 30) as number | null, features: [] as ProFeature[]},
    {id: 'pro' as const, name: 'Tutor Pro', description: 'Lebih efisien mengajar. Lebih bermakna mendampingi.', price: price('SUBSCRIPTION_PRO_PRICE') ?? 79000, currency: 'IDR', period: 'month', studentLimit: null as number | null, features: [...proFeatures]},
  ];
}
export function effectiveSubscription(row: {plan: 'trial' | PaidPlan; trialEndsAt: Date; paidThrough?: Date}, now = new Date()) {
  const endsAt = row.plan === 'trial' ? row.trialEndsAt : row.paidThrough;
  const active = Boolean(endsAt && endsAt > now);
  return {status: active ? row.plan === 'trial' ? 'trialing' : 'active' : 'expired', active, plan: row.plan, endsAt: endsAt ?? row.trialEndsAt, daysRemaining: active ? Math.ceil((endsAt!.getTime() - now.getTime()) / 86_400_000) : 0};
}
export function nextBillingDate(from: Date) {
  const year = from.getUTCFullYear(), month = from.getUTCMonth() + 1;
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const result = new Date(from);
  result.setUTCDate(1); result.setUTCMonth(month); result.setUTCDate(Math.min(from.getUTCDate(), last));
  return result;
}
