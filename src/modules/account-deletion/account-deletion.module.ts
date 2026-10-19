import { Actor, Principal } from '../../common/api';
import { Body, Controller, Delete, Get, Header, HttpCode, Module } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AuthModule } from '../auth/auth.module';
import { AccountDeletionService } from './account-deletion.service';
import { AccountDeletionWorker } from './account-deletion.worker';
import { DeleteAccountDto } from './account-deletion.dto';
import { LogoStorageModule } from '../../storage/logo-storage.service';

@ApiTags('Account deletion') @ApiBearerAuth() @Controller('account-deletion')
export class AccountDeletionController {
  constructor(private readonly service: AccountDeletionService) {}
  @Get() @Header('Cache-Control', 'no-store')
  summary(@Actor() actor: Principal) { return this.service.summary(actor); }

  @Delete() @HttpCode(202) @Throttle({default: {limit: 5, ttl: 60_000}})
  remove(@Actor() actor: Principal, @Body() dto: DeleteAccountDto) { return this.service.request(actor, dto); }
}

@Module({imports: [AuthModule, LogoStorageModule], controllers: [AccountDeletionController], providers: [AccountDeletionService, AccountDeletionWorker]})
export class AccountDeletionModule {}
