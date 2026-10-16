import { Body, Controller, Get, Global, Header, HttpCode, Module, Param, Post, Query, RawBodyRequest, Req, UnauthorizedException } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiTags } from '@nestjs/swagger';
import { IsIn } from 'class-validator';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { Actor, IdPipe, Principal, Public } from '../../common/api';
import { ListQuery } from '../../common/query.dto';
import { SubscriptionsService } from './subscriptions.service';
import { BillingService } from './billing.service';
import { SingaPayProvider } from './singapay.provider';
class CheckoutDto { @ApiProperty({enum: ['basic', 'pro']}) @IsIn(['basic', 'pro']) plan!: 'basic' | 'pro'; }
@ApiBearerAuth() @ApiTags('Subscriptions') @Controller('subscriptions')
export class SubscriptionsController {
  constructor(private readonly service: SubscriptionsService, private readonly billing: BillingService) {}
  @Get('current') @Header('Cache-Control', 'no-store') async current(@Actor() actor: Principal) { return {...await this.service.current(actor.workspaceId), checkoutEnabled: this.billing.provider.configured}; }
  @Post('sync') @HttpCode(200) @Header('Cache-Control', 'no-store') @Throttle({default:{limit:10,ttl:60_000}})
  async sync(@Actor() actor: Principal) {
    const paymentSyncWarning = await this.billing.synchronize(actor);
    return {...await this.service.current(actor.workspaceId), checkoutEnabled: this.billing.provider.configured, paymentSyncWarning};
  }
  @Post('checkout') @Throttle({default:{limit:5,ttl:60_000}}) checkout(@Actor() actor: Principal, @Body() dto: CheckoutDto) { return this.billing.checkout(actor, dto.plan); }
  @Get('payments') payments(@Actor() actor: Principal, @Query() q: ListQuery) { return this.billing.history(actor, q.page, q.limit); }
  @Post('payments/:id/refresh') @HttpCode(200) @Throttle({default:{limit:10,ttl:60_000}}) refresh(@Actor() actor: Principal, @Param('id', IdPipe) id: string) { return this.billing.refresh(actor, id); }
  @Post('payments/:id/cancel') @HttpCode(200) cancel(@Actor() actor: Principal, @Param('id', IdPipe) id: string) { return this.billing.cancel(actor, id); }
  @Public() @Post('webhooks/singapay') @HttpCode(200) webhook(@Req() req: RawBodyRequest<Request>) {
    if (!req.rawBody) throw new UnauthorizedException('Payload pembayaran tidak valid.');
    return this.billing.webhook(req.rawBody.toString('utf8'), req.headers);
  }
}
@Global() @Module({controllers: [SubscriptionsController], providers: [SubscriptionsService, BillingService, SingaPayProvider], exports: [SubscriptionsService]})
export class SubscriptionsModule {}
