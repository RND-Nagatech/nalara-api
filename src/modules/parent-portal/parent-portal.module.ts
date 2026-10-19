import { Body, Controller, Delete, Get, HttpCode, Module, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Actor, IdPipe, Principal, Public } from '../../common/api';
import { ListQuery } from '../../common/query.dto';
import { InvitationsModule } from '../invitations/invitations.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PortalAuthGuard, PortalRequest } from '../invitations/portal.guard';
import { ParentAvailabilityDto, ParentDashboardQuery, ParentRescheduleDto, ParentStudentListQuery, RescheduleAvailabilityQuery, RespondRescheduleDto, ReviewRescheduleDto } from './parent-portal.dto';
import { ParentPortalService } from './parent-portal.service';
import { NotificationDeviceDto } from '../notifications/notifications.dto';
import { NotificationDevicesService } from '../notifications/notification-devices.service';
import { StudentsModule } from '../students/students.module';
import { RequireFeature } from '../subscriptions/subscriptions.guard';

@Public()
@ApiTags('Parent portal')
@ApiBearerAuth()
@Controller('portal')
export class ParentPortalController {
  constructor(private readonly service: ParentPortalService, private readonly devices: NotificationDevicesService) {}
  @UseGuards(PortalAuthGuard) @Get('dashboard') dashboard(@Req() req: PortalRequest, @Query() query: ParentDashboardQuery) { return this.service.dashboard(req.portalAccount, query); }
  @UseGuards(PortalAuthGuard) @Get('students') students(@Req() req: PortalRequest, @Query() query: ParentStudentListQuery) { return this.service.students(req.portalAccount, query); }
  @UseGuards(PortalAuthGuard) @Get('students/:id') student(@Req() req: PortalRequest, @Param('id', IdPipe) id: string) { return this.service.student(req.portalAccount, id); }
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
  @UseGuards(PortalAuthGuard) @Post('notifications/devices') @HttpCode(200) registerDevice(@Req() req: PortalRequest, @Body() dto: NotificationDeviceDto) { return this.devices.registerPortal(req.portalAccount, dto, req.portalSessionId); }
  @UseGuards(PortalAuthGuard) @Delete('notifications/devices') @HttpCode(200) unregisterDevice(@Req() req: PortalRequest, @Body() dto: NotificationDeviceDto) { return this.devices.unregisterPortal(req.portalAccount, dto); }
  @UseGuards(PortalAuthGuard) @Get('availability') availability(@Req() req: PortalRequest, @Query() dto: ParentAvailabilityDto) { return this.service.availability(req.portalAccount, dto); }
  @UseGuards(PortalAuthGuard) @Post('reschedule-requests') @HttpCode(201) request(@Req() req: PortalRequest, @Body() dto: ParentRescheduleDto) { return this.service.requestReschedule(req.portalAccount, dto); }
  @UseGuards(PortalAuthGuard) @Get('reschedule-requests') requests(@Req() req: PortalRequest, @Query() query: ListQuery) { return this.service.parentRequests(req.portalAccount, query); }
  @UseGuards(PortalAuthGuard) @Delete('reschedule-requests/:id') @HttpCode(200) cancelRequest(@Req() req: PortalRequest, @Param('id', IdPipe) id: string) { return this.service.cancelRequest(req.portalAccount, id); }
  @UseGuards(PortalAuthGuard) @Patch('reschedule-requests/:id') respondRequest(@Req() req: PortalRequest, @Param('id', IdPipe) id: string, @Body() dto: RespondRescheduleDto) { return this.service.respondRequest(req.portalAccount, id, dto); }
}

@ApiTags('Reschedule requests')
@ApiBearerAuth()
@RequireFeature('reschedule')
@Controller('reschedule-requests')
export class TeacherRescheduleRequestsController {
  constructor(private readonly service: ParentPortalService) {}
  @Get() list(@Actor() actor: Principal, @Query() query: ListQuery) { return this.service.teacherRequests(actor, query); }
  @Get(':id/availability') availability(@Actor() actor: Principal, @Param('id', IdPipe) id: string, @Query() query: RescheduleAvailabilityQuery) { return this.service.teacherAvailability(actor, id, query); }
  @Patch(':id') review(@Actor() actor: Principal, @Param('id', IdPipe) id: string, @Body() dto: ReviewRescheduleDto) { return this.service.review(actor, id, dto); }
}

@Module({ imports: [InvitationsModule, NotificationsModule, StudentsModule], controllers: [ParentPortalController, TeacherRescheduleRequestsController], providers: [ParentPortalService], exports: [ParentPortalService] })
export class ParentPortalModule {}
