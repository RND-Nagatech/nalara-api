import { ConflictException, NotFoundException } from '@nestjs/common';
import type { ClientSession } from 'mongoose';
import { Database } from '../database/database.module';

// All calendar writers touch the same workspace document before reading slots.
// Concurrent transactions retry against a fresh snapshot instead of committing
// overlapping writes to different occurrence documents.
export async function lockCalendar(db: Database, workspaceId: string, session: ClientSession) {
  const result = await db.collection('workspaces').updateOne({ _id: workspaceId, deletionRequestedAt: { $exists: false } }, { $inc: { scheduleVersion: 1 } }, { session });
  if (!result.matchedCount) throw new NotFoundException('Ruang kerja tidak ditemukan');
}

export async function requireFreeSlot(db: Database, workspaceId: string, startAt: Date, endAt: Date, session: ClientSession, exceptId?: string | readonly string[]) {
  const excluded = typeof exceptId === 'string' ? [exceptId] : exceptId;
  const overlap = await db.collection('sessions').exists({ workspaceId, status: { $ne: 'cancelled' }, ...(excluded ? { _id: { $nin: excluded } } : {}), startAt: { $lt: endAt }, endAt: { $gt: startAt } }).session(session);
  if (overlap) throw new ConflictException('Waktu yang dipilih sudah digunakan. Pilih slot lain.');
}
