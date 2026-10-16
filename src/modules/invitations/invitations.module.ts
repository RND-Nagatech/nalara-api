import { Body, Controller, Get, HttpCode, Module, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../../common/api';
import { InvitationsService } from './invitations.service';
import { InvitationCodeDto, RedeemCodeDto, PortalRefreshDto } from './invitations.dto';
import { PortalAuthGuard, PortalRequest } from './portal.guard';
export { InvitationsService } from './invitations.service';
@Public() @ApiTags('Invitations') @Controller('invitations') export class InvitationsController {
  constructor(private readonly service:InvitationsService) {}
  @Post('verify') @HttpCode(200) @Throttle({default:{limit:10,ttl:60_000}}) verify(@Body() dto:InvitationCodeDto) { return this.service.verify(dto.token,dto.audience); }
  @Post('redeem') @HttpCode(200) @Throttle({default:{limit:10,ttl:60_000}}) redeem(@Body() dto:RedeemCodeDto) { return this.service.redeem(dto); }
}
@Public() @ApiTags('Portal sessions') @Controller('portal')
export class PortalController {
  constructor(private readonly service:InvitationsService) {}
  @ApiBearerAuth() @UseGuards(PortalAuthGuard) @Get('me') me(@Req() req:PortalRequest) { return req.portalProfile; }
  @Post('refresh') @HttpCode(200) @Throttle({default:{limit:30,ttl:60_000}}) refresh(@Body() dto:PortalRefreshDto) { return this.service.refresh(dto.refreshToken); }
  @Post('logout') @HttpCode(200) @Throttle({default:{limit:30,ttl:60_000}}) logout(@Body() dto:PortalRefreshDto) { return this.service.logout(dto.refreshToken); }
}
@Module({controllers:[InvitationsController,PortalController],providers:[InvitationsService,PortalAuthGuard],exports:[InvitationsService,PortalAuthGuard]}) export class InvitationsModule {}
