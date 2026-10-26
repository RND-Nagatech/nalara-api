import { Body, Controller, Delete, Get, HttpCode, Module, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ForbiddenException } from '@nestjs/common';
import { IdPipe, Public } from '../../common/api';
import { ListQuery } from '../../common/query.dto';
import { InvitationsModule, InvitationsService } from '../invitations/invitations.module';
import { PortalAuthGuard, PortalRequest } from '../invitations/portal.guard';
import { NotificationsModule } from '../notifications/notifications.module';
import { NotificationDevicesService } from '../notifications/notification-devices.service';
import { NotificationDeviceDto } from '../notifications/notifications.dto';
import { StudentPortalService } from './student-portal.service';

@Public()
@ApiTags('Student portal')
@ApiBearerAuth()
@Controller('portal/student')
export class StudentPortalController {
  constructor(private readonly service: StudentPortalService, private readonly devices: NotificationDevicesService, private readonly invitations: InvitationsService) {}

  @UseGuards(PortalAuthGuard) @Get('dashboard') dashboard(@Req() req: PortalRequest) { return this.service.dashboard(req.portalAccount); }
  @UseGuards(PortalAuthGuard) @Get('profile') profile(@Req() req: PortalRequest) { return this.service.profile(req.portalAccount); }
  @UseGuards(PortalAuthGuard) @Get('sessions') sessions(@Req() req: PortalRequest, @Query() query: ListQuery) { return this.service.sessions(req.portalAccount, query); }
  @UseGuards(PortalAuthGuard) @Get('sessions/:id') session(@Req() req: PortalRequest, @Param('id', IdPipe) id: string) { return this.service.session(req.portalAccount, id); }
  @UseGuards(PortalAuthGuard) @Get('sessions/:id/overview') sessionOverview(@Req() req: PortalRequest, @Param('id', IdPipe) id: string) { return this.service.sessionOverview(req.portalAccount, id); }
  @UseGuards(PortalAuthGuard) @Get('plans') plans(@Req() req: PortalRequest, @Query() query: ListQuery) { return this.service.plans(req.portalAccount, query); }
  @UseGuards(PortalAuthGuard) @Get('plans/:id') plan(@Req() req: PortalRequest, @Param('id', IdPipe) id: string) { return this.service.plan(req.portalAccount, id); }
  @UseGuards(PortalAuthGuard) @Get('targets/:id') target(@Req() req: PortalRequest, @Param('id', IdPipe) id: string) { return this.service.target(req.portalAccount, id); }
  @UseGuards(PortalAuthGuard) @Get('reports') reports(@Req() req: PortalRequest, @Query() query: ListQuery) { return this.service.reports(req.portalAccount, query); }
  @UseGuards(PortalAuthGuard) @Get('reports/:id') report(@Req() req: PortalRequest, @Param('id', IdPipe) id: string) { return this.service.report(req.portalAccount, id); }
  @UseGuards(PortalAuthGuard) @Get('notifications') notifications(@Req() req: PortalRequest, @Query() query: ListQuery) { return this.service.notifications(req.portalAccount, query); }
  @UseGuards(PortalAuthGuard) @Patch('notifications/:id/read') readNotification(@Req() req: PortalRequest, @Param('id', IdPipe) id: string) { return this.service.readNotification(req.portalAccount, id); }
  @UseGuards(PortalAuthGuard) @Post('notifications/read-all') @HttpCode(200) readAllNotifications(@Req() req: PortalRequest) { return this.service.readAllNotifications(req.portalAccount); }
  @UseGuards(PortalAuthGuard) @Post('notifications/devices') @HttpCode(200) registerDevice(@Req() req: PortalRequest, @Body() dto: NotificationDeviceDto) {
    if (req.portalAccount.role !== 'student') throw new ForbiddenException('Endpoint ini khusus akun siswa');
    return this.devices.registerPortal(req.portalAccount, dto, req.portalSessionId);
  }
  @UseGuards(PortalAuthGuard) @Delete('notifications/devices') @HttpCode(200) unregisterDevice(@Req() req: PortalRequest, @Body() dto: NotificationDeviceDto) {
    if (req.portalAccount.role !== 'student') throw new ForbiddenException('Endpoint ini khusus akun siswa');
    return this.devices.unregisterPortal(req.portalAccount, dto);
  }
  @UseGuards(PortalAuthGuard) @Delete('account') @HttpCode(200) deleteAccount(@Req() req: PortalRequest) {
    if (req.portalAccount.role !== 'student') throw new ForbiddenException('Endpoint ini khusus akun siswa');
    return this.invitations.deletePortalAccount(req.portalAccount);
  }
}

@Module({ imports: [InvitationsModule, NotificationsModule], controllers: [StudentPortalController], providers: [StudentPortalService], exports: [StudentPortalService] })
export class StudentPortalModule {}
