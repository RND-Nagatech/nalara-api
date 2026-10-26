import { BadRequestException } from '@nestjs/common';

export type RepeatEnd = 'never' | 'count' | 'until';
export interface RepeatPattern {
  startAt: Date; endAt: Date; timezone: string; repeatDays?: number[];
  repeatEnd?: RepeatEnd; repeatUntil?: string; repeatCount: number;
  generatedThrough?: Date; generatedCount?: number;
}
export function localParts(date: Date, timezone: string) {
  return Object.fromEntries(new Intl.DateTimeFormat('en-GB', {timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'})
    .formatToParts(date).filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
}
export function localDate(date: Date, timezone: string) {
  const p = localParts(date, timezone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}
export function localWeekday(date: Date, timezone: string) {
  const p = localParts(date, timezone);
  return new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay() || 7;
}
function datePlusDays(date:Date,timezone:string,days:number) {
  const p=localParts(date,timezone);
  return new Date(Date.UTC(p.year,p.month-1,p.day+days)).toISOString().slice(0,10);
}
// Calendar-day shifts preserve wall time, including overnight lessons and DST.
export function shiftLocalDays(date: Date, timezone: string, days: number) {
  const p = localParts(date, timezone);
  const target = Date.UTC(p.year, p.month - 1, p.day + days, p.hour, p.minute, p.second);
  let result = new Date(date.getTime() + days * 86400_000);
  for (let attempt = 0; attempt < 4; attempt++) {
    const q = localParts(result, timezone);
    const current = Date.UTC(q.year, q.month - 1, q.day, q.hour, q.minute, q.second);
    if (target === current) return result;
    result = new Date(result.getTime() + target - current);
  }
  throw new BadRequestException('Jam pengulangan tidak tersedia pada perubahan zona waktu. Pilih jam lain.');
}
export function validateRepeat(pattern: RepeatPattern) {
  if (!pattern.repeatEnd || !['never', 'count', 'until'].includes(pattern.repeatEnd)) throw new BadRequestException('Pilih akhir pengulangan jadwal.');
  if (!pattern.repeatDays?.length || pattern.repeatDays.length > 7 || new Set(pattern.repeatDays).size !== pattern.repeatDays.length || pattern.repeatDays.some(day => !Number.isInteger(day) || day < 1 || day > 7)) throw new BadRequestException('Pilih minimal satu hari pengulangan yang valid.');
  if (pattern.repeatEnd === 'count' && (!Number.isInteger(pattern.repeatCount) || pattern.repeatCount < 1 || pattern.repeatCount > 52)) throw new BadRequestException('Jumlah pertemuan harus 1–52.');
  if (pattern.repeatEnd === 'until') {
    const date = pattern.repeatUntil;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(`${date}T00:00:00Z`)) || new Date(`${date}T00:00:00Z`).toISOString().slice(0,10) !== date
      || date < localDate(pattern.startAt, pattern.timezone)
      || date > datePlusDays(pattern.startAt, pattern.timezone, 366)) throw new BadRequestException('Tanggal akhir harus antara tanggal mulai dan satu tahun berikutnya.');
  } else if (pattern.repeatUntil !== undefined) throw new BadRequestException('Tanggal akhir hanya digunakan untuk pengulangan sampai tanggal tertentu.');
}

export function repeatOccurrences(pattern: RepeatPattern, now = new Date()) {
  validateRepeat(pattern);
  const origin = localParts(pattern.startAt, pattern.timezone);
  const baseDay = Date.UTC(origin.year, origin.month - 1, origin.day);
  const after = pattern.generatedThrough ? localParts(pattern.generatedThrough, pattern.timezone) : null;
  let firstOffset = after ? Math.floor((Date.UTC(after.year, after.month - 1, after.day) - baseDay) / 86400_000) + 1 : 0;
  // Materialize eight weeks, not an unbounded number of rows. Never backfill
  // missed historical sessions after prolonged server downtime.
  const today = localDate(now, pattern.timezone);
  if(after) firstOffset=Math.max(firstOffset,Math.floor((Date.parse(`${today}T00:00:00Z`)-baseDay)/86400_000));
  const horizon = datePlusDays(now > pattern.startAt ? now : pattern.startAt, pattern.timezone, 56);
  const slots: {startAt: Date; endAt: Date}[] = [];
  let count = pattern.generatedCount ?? 0, complete = false;
  let through = pattern.generatedThrough;
  for (let offset = firstOffset; offset < firstOffset + 430; offset++) {
    const calendarDay = new Date(baseDay + offset * 86400_000);
    const date = calendarDay.toISOString().slice(0,10);
    if ((pattern.repeatEnd === 'until' && date > pattern.repeatUntil!) || (pattern.repeatEnd === 'count' && count >= pattern.repeatCount)) {complete = true; break;}
    if (date >= horizon) break;
    if (!pattern.repeatDays!.includes(calendarDay.getUTCDay() || 7)) continue;
    const startAt = shiftLocalDays(pattern.startAt, pattern.timezone, offset);
    through = startAt;
    if (pattern.generatedThrough && startAt < now) continue;
    count++;
    const endAt = shiftLocalDays(pattern.endAt, pattern.timezone, offset);
    if (endAt <= startAt || endAt.getTime() - startAt.getTime() > 12 * 3600_000) throw new BadRequestException('Durasi pengulangan tidak valid pada zona waktu jadwal.');
    slots.push({startAt, endAt});
  }
  return {slots, generatedThrough: through, generatedCount: count, recurrenceComplete: complete};
}
