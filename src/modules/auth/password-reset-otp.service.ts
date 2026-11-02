import { HttpException, HttpStatus, Injectable, Logger, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ClientSession } from 'mongoose';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { Database } from '../../database/database.module';
import type { PasswordResetChallenge } from '../../database/entities';

export type IssuedPasswordResetOtp = {otp: string | null; expiresInSeconds: number};
type VerificationResult = 'ok' | 'expired' | 'invalid' | 'locked' | 'mismatch';
type StorageOperation = 'issue' | 'verify' | 'peek' | 'consume';
const hashValue = (value: string) => createHash('sha256').update(value).digest('hex');

@Injectable()
export class PasswordResetOtpService {
  private readonly cooldownSeconds = 60;
  private readonly resetTokenSeconds = 10 * 60;
  private readonly logger = new Logger(PasswordResetOtpService.name);

  constructor(private readonly db: Database, private readonly config: ConfigService) {}

  get expiresInSeconds() {
    const configured = Number(this.config.get('PASSWORD_RESET_OTP_TTL_MINUTES', 5));
    return Math.max(60, Math.round(configured * 60));
  }

  private storageUnavailable(error: unknown, operation: StorageOperation): never {
    const code = (error as {code?: unknown})?.code;
    this.logger.warn({event: 'auth.otp.storage_unavailable', storage: 'mongodb', operation,
      errorType: error instanceof Error ? error.name : 'Unknown',
      ...(typeof code === 'number' && Number.isSafeInteger(code) ? {code} : {})});
    throw new ServiceUnavailableException('Layanan OTP sedang tidak tersedia. Coba lagi sebentar.');
  }

  async issue(email: string, userId?: string): Promise<IssuedPasswordResetOtp> {
    const normalizedEmail = email.trim().toLowerCase();
    const now = new Date();
    const expiresInSeconds = this.expiresInSeconds;
    const cooldownUntil = new Date(now.getTime() + this.cooldownSeconds * 1000);
    const otpExpiresAt = new Date(now.getTime() + expiresInSeconds * 1000);
    const otp = userId ? String(randomInt(0, 1_000_000)).padStart(6, '0') : null;
    try {
      // The unique hashed-email _id makes parallel upserts contend on one row.
      // An active cooldown does not match, so its duplicate insert becomes 429.
      await this.db.collection('passwordResetChallenges').findOneAndUpdate({
        _id: hashValue(normalizedEmail),
        $or: [{cooldownUntil: {$lte: now}}, {cooldownUntil: {$exists: false}}],
      }, {
        $set: {attempts: 0, cooldownUntil,
          expiresAt: new Date(Math.max(cooldownUntil.getTime(), otpExpiresAt.getTime())),
          ...(otp ? {userId, otpHash: hashValue(otp), otpExpiresAt} : {})},
        ...(!otp ? {$unset: {userId: 1, otpHash: 1, otpExpiresAt: 1}} : {}),
      }, {upsert: true, returnDocument: 'after'}).lean();
      return {otp, expiresInSeconds};
    } catch (error) {
      if ((error as {code?: number})?.code === 11000) {
        throw new HttpException('Tunggu sebentar sebelum meminta OTP baru.', HttpStatus.TOO_MANY_REQUESTS);
      }
      if (error instanceof HttpException) throw error;
      return this.storageUnavailable(error, 'issue');
    }
  }

  private async clearChallenge(challenge: PasswordResetChallenge, session: ClientSession, now: Date, attempts = challenge.attempts) {
    await this.db.collection('passwordResetChallenges').updateOne({_id: challenge._id}, {
      $set: {attempts, expiresAt: new Date(Math.max(challenge.cooldownUntil.getTime(), now.getTime()))},
      $unset: {otpHash: 1, otpExpiresAt: 1},
    }, {session});
  }

  async verify(email: string, otp: string): Promise<string> {
    const challengeId = hashValue(email.trim().toLowerCase());
    const resetToken = randomBytes(32).toString('base64url');
    try {
      // Attempt accounting, consuming the OTP and issuing its reset credential
      // commit together. Mongo retries write conflicts across API replicas.
      const result = await this.db.connection.transaction(async (session): Promise<VerificationResult> => {
        const now = new Date();
        const challenge = await this.db.collection('passwordResetChallenges').findOne({_id: challengeId}).session(session).lean();
        if (!challenge || !challenge.otpHash) return 'expired';
        if (typeof challenge.userId !== 'string' || !challenge.userId ||
            !/^[a-f0-9]{64}$/.test(challenge.otpHash) ||
            !Number.isInteger(challenge.attempts) || challenge.attempts < 0 ||
            !(challenge.otpExpiresAt instanceof Date) || !Number.isFinite(challenge.otpExpiresAt.getTime()) ||
            !(challenge.cooldownUntil instanceof Date) || !Number.isFinite(challenge.cooldownUntil.getTime())) {
          await this.db.collection('passwordResetChallenges').updateOne({_id: challengeId},
            {$unset: {otpHash: 1, otpExpiresAt: 1}}, {session});
          return 'invalid';
        }
        if (challenge.otpExpiresAt <= now) return 'expired';
        if (challenge.attempts >= 5) {
          await this.clearChallenge(challenge, session, now, 5);
          return 'locked';
        }
        if (challenge.otpHash !== hashValue(otp)) {
          const attempts = challenge.attempts + 1;
          if (attempts >= 5) {
            await this.clearChallenge(challenge, session, now, 5);
            return 'locked';
          }
          await this.db.collection('passwordResetChallenges').updateOne({_id: challengeId}, {$inc: {attempts: 1}}, {session});
          return 'mismatch';
        }
        await this.db.collection('passwordResetTokens').create([{
          _id: hashValue(resetToken), userId: challenge.userId,
          expiresAt: new Date(now.getTime() + this.resetTokenSeconds * 1000),
        }], {session});
        await this.clearChallenge(challenge, session, now);
        return 'ok';
      });
      // Raise domain errors after commit so failed-attempt increments stay.
      if (result === 'expired') throw new UnauthorizedException('OTP kedaluwarsa atau belum diminta.');
      if (result === 'invalid') throw new UnauthorizedException('OTP tidak valid.');
      if (result === 'locked') throw new UnauthorizedException('Terlalu banyak percobaan OTP. Minta OTP baru.');
      if (result === 'mismatch') throw new UnauthorizedException('OTP tidak sesuai.');
      if (result !== 'ok') throw new ServiceUnavailableException('Layanan OTP sedang tidak tersedia. Coba lagi sebentar.');
      return resetToken;
    } catch (error) {
      if (error instanceof HttpException) throw error;
      return this.storageUnavailable(error, 'verify');
    }
  }

  async peek(resetToken: string): Promise<string> {
    try {
      // TTL is cleanup only: expired rows are rejected before physical deletion.
      const record = await this.db.collection('passwordResetTokens').findOne({
        _id: hashValue(resetToken), expiresAt: {$gt: new Date()},
      }).lean();
      if (!record) throw new UnauthorizedException('Token reset kedaluwarsa atau sudah dipakai.');
      if (typeof record.userId !== 'string' || !record.userId) throw new UnauthorizedException('Token reset tidak valid.');
      return record.userId;
    } catch (error) {
      if (error instanceof HttpException) throw error;
      return this.storageUnavailable(error, 'peek');
    }
  }

  async consume(resetToken: string, session?: ClientSession): Promise<string> {
    try {
      const query = this.db.collection('passwordResetTokens').findOneAndDelete({
        _id: hashValue(resetToken), expiresAt: {$gt: new Date()},
      });
      if (session) query.session(session);
      const record = await query.lean();
      if (!record) throw new UnauthorizedException('Token reset kedaluwarsa atau sudah dipakai.');
      if (typeof record.userId !== 'string' || !record.userId) throw new UnauthorizedException('Token reset tidak valid.');
      return record.userId;
    } catch (error) {
      if (error instanceof HttpException) throw error;
      // Preserve Mongo error labels until the enclosing transaction can retry.
      if (session) throw error;
      return this.storageUnavailable(error, 'consume');
    }
  }

  async completeReset<T>(resetToken: string, savePassword: (userId: string, session: ClientSession) => Promise<T>): Promise<T> {
    try {
      return await this.db.connection.transaction(async session => {
        const userId = await this.consume(resetToken, session);
        return savePassword(userId, session);
      });
    } catch (error) {
      if (error instanceof HttpException) throw error;
      return this.storageUnavailable(error, 'consume');
    }
  }
}
