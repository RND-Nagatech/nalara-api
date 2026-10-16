import { HttpException, HttpStatus, Inject, Injectable, Logger, OnModuleDestroy, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { createHash, randomBytes, randomInt } from 'node:crypto';

export const AUTH_REDIS = Symbol('AUTH_REDIS');

type OtpRecord = {userId: string; otpHash: string; attempts: number};
type ResetTokenRecord = {userId: string};
export type IssuedPasswordResetOtp = {otp: string | null; expiresInSeconds: number};

const hashValue = (value: string) => createHash('sha256').update(value).digest('hex');

@Injectable()
export class PasswordResetOtpService implements OnModuleDestroy {
  private readonly cooldownSeconds = 60;
  private readonly resetTokenSeconds = 10 * 60;
  private readonly logger = new Logger(PasswordResetOtpService.name);

  constructor(@Inject(AUTH_REDIS) private readonly redis: Redis, private readonly config: ConfigService) {}

  get expiresInSeconds() {
    const configured = Number(this.config.get('PASSWORD_RESET_OTP_TTL_MINUTES', 5));
    return Math.max(60, Math.round(configured * 60));
  }

  private otpKey(email: string) { return `password-reset:otp:${email}`; }
  private cooldownKey(email: string) { return `password-reset:cooldown:${email}`; }
  private resetTokenKey(token: string) { return `password-reset:token:${hashValue(token)}`; }

  private redisUnavailable(error: unknown): never {
    const message = error instanceof Error ? error.message : String(error);
    this.logger.warn(`Redis OTP operation failed: ${message}`);
    throw new ServiceUnavailableException('Layanan OTP sedang tidak tersedia. Coba lagi sebentar.');
  }

  async issue(email: string, userId?: string): Promise<IssuedPasswordResetOtp> {
    const normalizedEmail = email.trim().toLowerCase();
    let cooldownReserved = false;
    try {
      const accepted = await this.redis.set(this.cooldownKey(normalizedEmail), '1', 'EX', this.cooldownSeconds, 'NX');
      if (accepted !== 'OK') throw new HttpException('Tunggu sebentar sebelum meminta OTP baru.', HttpStatus.TOO_MANY_REQUESTS);
      cooldownReserved = true;
      if (!userId) return {otp: null, expiresInSeconds: this.expiresInSeconds};
      const otp = String(randomInt(0, 1_000_000)).padStart(6, '0');
      await this.redis.set(this.otpKey(normalizedEmail), JSON.stringify({userId, otpHash: hashValue(otp), attempts: 0} satisfies OtpRecord), 'EX', this.expiresInSeconds);
      return {otp, expiresInSeconds: this.expiresInSeconds};
    } catch (error) {
      if (cooldownReserved) await this.redis.del(this.cooldownKey(normalizedEmail)).catch(() => undefined);
      if (error instanceof HttpException) throw error;
      return this.redisUnavailable(error);
    }
  }

  async verify(email: string, otp: string): Promise<string> {
    try {
      const key = this.otpKey(email.trim().toLowerCase());
      const stored = await this.redis.get(key);
      if (!stored) throw new UnauthorizedException('OTP kedaluwarsa atau belum diminta.');
      let record: OtpRecord;
      try { record = JSON.parse(stored) as OtpRecord; } catch { await this.redis.del(key); throw new UnauthorizedException('OTP tidak valid.'); }
      if (record.attempts >= 5) { await this.redis.del(key); throw new UnauthorizedException('Terlalu banyak percobaan OTP. Minta OTP baru.'); }
      if (hashValue(otp) !== record.otpHash) {
        const ttl = await this.redis.ttl(key);
        record.attempts += 1;
        if (ttl > 0) await this.redis.set(key, JSON.stringify(record), 'EX', ttl);
        throw new UnauthorizedException('OTP tidak sesuai.');
      }
      await this.redis.del(key);
      const resetToken = randomBytes(32).toString('base64url');
      await this.redis.set(this.resetTokenKey(resetToken), JSON.stringify({userId: record.userId} satisfies ResetTokenRecord), 'EX', this.resetTokenSeconds);
      return resetToken;
    } catch (error) {
      if (error instanceof HttpException) throw error;
      return this.redisUnavailable(error);
    }
  }

  async peek(resetToken: string): Promise<string> {
    try {
      const stored = await this.redis.get(this.resetTokenKey(resetToken));
      if (!stored) throw new UnauthorizedException('Token reset kedaluwarsa atau sudah dipakai.');
      try {
        const record = JSON.parse(stored) as ResetTokenRecord;
        if (!record.userId) throw new Error('Missing reset token user ID');
        return record.userId;
      } catch (error) {
        if (error instanceof HttpException) throw error;
        throw new UnauthorizedException('Token reset tidak valid.');
      }
    } catch (error) {
      if (error instanceof HttpException) throw error;
      return this.redisUnavailable(error);
    }
  }

  async consume(resetToken: string): Promise<string> {
    try {
      const stored = await this.redis.getdel(this.resetTokenKey(resetToken));
      if (!stored) throw new UnauthorizedException('Token reset kedaluwarsa atau sudah dipakai.');
      try {
        return (JSON.parse(stored) as ResetTokenRecord).userId;
      } catch {
        throw new UnauthorizedException('Token reset tidak valid.');
      }
    } catch (error) {
      if (error instanceof HttpException) throw error;
      return this.redisUnavailable(error);
    }
  }

  onModuleDestroy() { this.redis.disconnect(); }
}
