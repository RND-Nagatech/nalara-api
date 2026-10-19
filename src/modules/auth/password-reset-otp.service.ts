import { HttpException, HttpStatus, Inject, Injectable, Logger, OnModuleDestroy, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { createHash, randomBytes, randomInt } from 'node:crypto';

export const AUTH_REDIS = Symbol('AUTH_REDIS');

type OtpRecord = {userId: string; otpHash: string; attempts: number};
type ResetTokenRecord = {userId: string};
export type IssuedPasswordResetOtp = {otp: string | null; expiresInSeconds: number};

const hashValue = (value: string) => createHash('sha256').update(value).digest('hex');

// One Redis operation owns comparison, attempt accounting, OTP consumption and
// reset-token issuance. A process-local lock cannot protect multiple API replicas.
export const PASSWORD_RESET_VERIFY_SCRIPT = `
local stored = redis.call('GET', KEYS[1])
if not stored then return 'expired' end
local ok, record = pcall(cjson.decode, stored)
if not ok or type(record) ~= 'table' or type(record.userId) ~= 'string'
  or record.userId == '' or type(record.otpHash) ~= 'string'
  or type(record.attempts) ~= 'number' or record.attempts < 0
  or record.attempts ~= math.floor(record.attempts) then
  redis.call('DEL', KEYS[1])
  return 'invalid'
end
if redis.call('PTTL', KEYS[1]) <= 0 then
  redis.call('DEL', KEYS[1])
  return 'expired'
end
if record.attempts >= 5 then
  redis.call('DEL', KEYS[1])
  return 'locked'
end
if record.otpHash ~= ARGV[1] then
  record.attempts = record.attempts + 1
  if record.attempts >= 5 then
    redis.call('DEL', KEYS[1])
    return 'locked'
  end
  redis.call('SET', KEYS[1], cjson.encode(record), 'KEEPTTL')
  return 'mismatch'
end
local issued = redis.call('SET', KEYS[2], cjson.encode({userId = record.userId}), 'EX', ARGV[2], 'NX')
if not issued then return 'unavailable' end
redis.call('DEL', KEYS[1])
return 'ok'
`;

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
    this.logger.warn({event: 'auth.otp.redis_unavailable', errorType: error instanceof Error ? error.name : 'Unknown'});
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
      const resetToken = randomBytes(32).toString('base64url');
      const result = await this.redis.eval(PASSWORD_RESET_VERIFY_SCRIPT, 2, key, this.resetTokenKey(resetToken), hashValue(otp), this.resetTokenSeconds);
      if (result === 'expired') throw new UnauthorizedException('OTP kedaluwarsa atau belum diminta.');
      if (result === 'invalid') throw new UnauthorizedException('OTP tidak valid.');
      if (result === 'locked') throw new UnauthorizedException('Terlalu banyak percobaan OTP. Minta OTP baru.');
      if (result === 'mismatch') throw new UnauthorizedException('OTP tidak sesuai.');
      if (result !== 'ok') throw new ServiceUnavailableException('Layanan OTP sedang tidak tersedia. Coba lagi sebentar.');
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
