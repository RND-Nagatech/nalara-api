import { createHash, randomBytes } from 'node:crypto';
const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function isNormalizedReferralCode(value:unknown):value is string {
  return typeof value==='string' && /^(?:[A-HJ-NP-Z2-9]{20}|[A-Za-z0-9_-]{43})$/.test(value);
}
export function createReferralCode() {
  const raw = [...randomBytes(20)].map(byte=>alphabet[byte & 31]).join('');
  return {raw,display:`NLR-${raw.match(/.{5}/g)!.join('-')}`};
}
export function normalizeReferralCode(value:unknown):unknown {
  if (typeof value!=='string') return value;
  const trimmed = value.trim();
  if (/^NLR-(?:[A-HJ-NP-Z2-9]{5}-){3}[A-HJ-NP-Z2-9]{5}$/i.test(trimmed)) return trimmed.slice(4).replaceAll('-','').toUpperCase();
  if (/^[A-HJ-NP-Z2-9]{20}$/i.test(trimmed)) return trimmed.toUpperCase();
  return trimmed;
}
export const referralCodeHash = (value:string) => createHash('sha256').update(value).digest('hex');
