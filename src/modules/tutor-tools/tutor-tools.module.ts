import { Body, Controller, Delete, Get, Header, Module, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Actor, IdPipe, Principal, Public } from '../../common/api';
import { ListQuery } from '../../common/query.dto';
import { InvitationsModule } from '../invitations/invitations.module';
import { PortalAuthGuard, PortalRequest } from '../invitations/portal.guard';
import { NotificationsModule } from '../notifications/notifications.module';
import { RequireFeature } from '../subscriptions/subscriptions.guard';
import { AssignmentDto, BrandingDto, FeedbackDto, PreferencesDto, SubmissionDto, TemplateDto } from './tutor-tools.dto';
import { TutorToolsService } from './tutor-tools.service';
import { AssignmentsService } from './assignments.service';
@ApiBearerAuth() @ApiTags('Tutor tools') @Controller('tutor-tools')
export class TutorToolsController {
  constructor(private readonly tools: TutorToolsService, private readonly tasks: AssignmentsService) {}
  @Get('assignments') @RequireFeature('assignments') list(@Actor() a: Principal, @Query() q: ListQuery) { return this.tasks.list(a, q); }
  @Post('assignments') @RequireFeature('assignments') create(@Actor() a: Principal, @Body() d: AssignmentDto) { return this.tasks.save(a, d); }
  @Get('assignments/:id') @RequireFeature('assignments') get(@Actor() a: Principal, @Param('id', IdPipe) id: string) { return this.tasks.get(a, id); }
  @Patch('assignments/:id') @RequireFeature('assignments') update(@Actor() a: Principal, @Param('id', IdPipe) id: string, @Body() d: AssignmentDto) { return this.tasks.save(a, d, id); }
  @Patch('submissions/:id/feedback') @RequireFeature('assignments') feedback(@Actor() a: Principal, @Param('id', IdPipe) id: string, @Body() d: FeedbackDto) { return this.tasks.feedback(a, id, d); }
  @Get('templates') @RequireFeature('reportTemplates') templates(@Actor() a: Principal, @Query() q: ListQuery) { return this.tools.templates(a, q); }
  @Post('templates') @RequireFeature('reportTemplates') template(@Actor() a: Principal, @Body() d: TemplateDto) { return this.tools.saveTemplate(a, d); }
  @Patch('templates/:id') @RequireFeature('reportTemplates') templateUpdate(@Actor() a: Principal, @Param('id', IdPipe) id: string, @Body() d: TemplateDto) { return this.tools.saveTemplate(a, d, id); }
  @Delete('templates/:id') @RequireFeature('reportTemplates') templateDelete(@Actor() a: Principal, @Param('id', IdPipe) id: string) { return this.tools.removeTemplate(a, id); }
  @Get('analytics') @RequireFeature('progressAnalytics') analytics(@Actor() a: Principal, @Query() q: ListQuery) { return this.tools.analytics(a, q); }
  @Get('branding') @RequireFeature('branding') branding(@Actor() a: Principal) { return this.tools.preferences(a); }
  @Patch('branding') @RequireFeature('branding') brandingSave(@Actor() a: Principal, @Body() d: BrandingDto) { return this.tools.savePreferences(a, d); }
  @Get('notification-preferences') @RequireFeature('notificationPreferences') preferences(@Actor() a: Principal) { return this.tools.preferences(a); }
  @Patch('notification-preferences') @RequireFeature('notificationPreferences') preferencesSave(@Actor() a: Principal, @Body() d: PreferencesDto) { return this.tools.savePreferences(a, d); }
  @Get('reports/:id/pdf') @Header('Cache-Control','no-store') @RequireFeature('pdfExport') pdf(@Actor() a: Principal, @Param('id', IdPipe) id: string) { return this.tools.pdf(a, id); }
  @Get('export') @Header('Cache-Control','no-store') @RequireFeature('dataExport') export(@Actor() a: Principal) { return this.tools.export(a); }
}
@Public() @UseGuards(PortalAuthGuard) @ApiBearerAuth() @ApiTags('Portal assignments') @Controller('portal/assignments')
export class PortalAssignmentsController {
  constructor(private readonly tasks: AssignmentsService) {}
  @Get() list(@Req() r: PortalRequest, @Query() q: ListQuery) { return this.tasks.portalList(r.portalAccount, q); }
  @Get(':id') get(@Req() r: PortalRequest, @Param('id', IdPipe) id: string) { return this.tasks.portalGet(r.portalAccount, id); }
  @Post(':id/submission') submit(@Req() r: PortalRequest, @Param('id', IdPipe) id: string, @Body() d: SubmissionDto) { return this.tasks.submit(r.portalAccount, id, d); }
}
@Module({imports: [NotificationsModule, InvitationsModule], controllers: [TutorToolsController, PortalAssignmentsController], providers: [TutorToolsService, AssignmentsService]})
export class TutorToolsModule {}
