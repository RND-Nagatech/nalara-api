// Indonesian mobile numbers have one canonical login key, regardless of display format.
export function normalizePhone(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 32 || !/^[+\d\s()-]+$/.test(value)) return null;
  let phone = value.replace(/[\s()-]/g, '');
  if (phone.startsWith('0')) phone = `+62${phone.slice(1)}`;
  else if (phone.startsWith('62')) phone = `+${phone}`;
  return /^\+628[1-9]\d{7,10}$/.test(phone) ? phone : null;
}
