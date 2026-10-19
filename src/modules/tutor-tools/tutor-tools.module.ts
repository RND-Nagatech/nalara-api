import { Body, Controller, Delete, Get, Header, HttpCode, Module, Param, Patch, Post, Query, Req, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { Actor, IdPipe, Principal, Public } from '../../common/api';
import { ListQuery } from '../../common/query.dto';
import { InvitationsModule } from '../invitations/invitations.module';
import { PortalAuthGuard, PortalRequest } from '../invitations/portal.guard';
import { NotificationsModule } from '../notifications/notifications.module';
import { RequireFeature } from '../subscriptions/subscriptions.guard';
import { AssignmentDto, BrandingDto, FeedbackDto, PreferencesDto, SubmissionDto, TemplateDto } from './tutor-tools.dto';
import { TutorToolsService } from './tutor-tools.service';
import { AssignmentsService } from './assignments.service';
import { BrandingLogoService, LogoUpload } from './branding-logo.service';
import { LogoStorageModule, MAX_LOGO_BYTES } from '../../storage/logo-storage.service';
@ApiBearerAuth() @ApiTags('Tutor tools') @Controller('tutor-tools')
export class TutorToolsController {
  constructor(private readonly tools: TutorToolsService, private readonly tasks: AssignmentsService, private readonly logos: BrandingLogoService) {}
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
  @Get('branding') @Header('Cache-Control', 'no-store') @RequireFeature('branding') branding(@Actor() a: Principal) { return this.tools.preferences(a); }
  @Patch('branding') @RequireFeature('branding') brandingSave(@Actor() a: Principal, @Body() d: BrandingDto) { return this.tools.savePreferences(a, d); }
  @Get('branding/logo') @Header('Cache-Control', 'no-store') @RequireFeature('branding')
  logo(@Actor() a: Principal) { return this.logos.current(a); }
  @Post('branding/logo') @HttpCode(200) @RequireFeature('branding') @Throttle({default: {limit: 10, ttl: 60_000}})
  @Header('Cache-Control', 'no-store') @ApiConsumes('multipart/form-data')
  @ApiBody({schema: {type: 'object', required: ['file'], properties: {file: {type: 'string', format: 'binary'}}}})
  @UseInterceptors(FileInterceptor('file', {limits: {fileSize: MAX_LOGO_BYTES, files: 1, fields: 0, parts: 1, headerPairs: 30}}))
  uploadLogo(@Actor() a: Principal, @UploadedFile() file?: LogoUpload) { return this.logos.upload(a, file); }
  @Delete('branding/logo') @Header('Cache-Control', 'no-store') @RequireFeature('branding') @Throttle({default: {limit: 10, ttl: 60_000}})
  removeLogo(@Actor() a: Principal) { return this.logos.remove(a); }
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
@Module({imports: [NotificationsModule, InvitationsModule, LogoStorageModule], controllers: [TutorToolsController, PortalAssignmentsController], providers: [TutorToolsService, AssignmentsService, BrandingLogoService]})
export class TutorToolsModule {}
