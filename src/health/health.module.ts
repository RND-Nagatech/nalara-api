import { Controller, Get, Inject, Module, ServiceUnavailableException } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import Redis from 'ioredis';
import { SkipThrottle } from '@nestjs/throttler';
import { Database } from '../database/database.module';
import { Public } from '../common/api';
import { AuthModule } from '../modules/auth/auth.module';
import { AUTH_REDIS } from '../modules/auth/password-reset-otp.service';
@Public() @SkipThrottle() @ApiTags('Health') @Controller('health')
export class HealthController {
  constructor(private readonly db: Database, @Inject(AUTH_REDIS) private readonly redis: Redis) {}
  @Get('live') live() { return {status:'up'}; }
  @Get('ready') async ready() {
    try {
      await Promise.all([
        this.db.connection.db!.command({ping:1}, {timeoutMS:2000}),
        this.redis.ping(),
      ]);
      return {status:'up', database:'up', redis:'up'};
    } catch { throw new ServiceUnavailableException('Database atau Redis belum siap'); }
  }
}
@Module({imports:[AuthModule], controllers:[HealthController]}) export class HealthModule {}
