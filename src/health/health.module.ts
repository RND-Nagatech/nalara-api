import { Controller, Get, Module, ServiceUnavailableException } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { Database } from '../database/database.module';
import { Public } from '../common/api';
@Public() @SkipThrottle() @ApiTags('Health') @Controller('health')
export class HealthController {
  constructor(private readonly db: Database) {}
  @Get('live') live() { return {status:'up'}; }
  @Get('ready') async ready() {
    try {
      await this.db.connection.db!.command({ping:1}, {timeoutMS:2000});
      return {status:'up', database:'up'};
    } catch { throw new ServiceUnavailableException('Database belum siap'); }
  }
}
@Module({controllers:[HealthController]}) export class HealthModule {}
