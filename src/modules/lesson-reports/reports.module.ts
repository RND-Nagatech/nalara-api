import { Body, Controller, Get, Module, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Actor, IdPipe, Principal } from '../../common/api';
import { ListQuery } from '../../common/query.dto';
import { BatchReportDto, ReportDto, UpdateReportDto } from './reports.dto';
import { ReportsService } from './reports.service';
import { NotificationsModule } from '../notifications/notifications.module';
@ApiTags('Reports') @ApiBearerAuth() @Controller('reports') export class ReportsController {
  constructor(private readonly service:ReportsService) {}
  @Get() list(@Actor() a:Principal,@Query() q:ListQuery) { return this.service.list(a,q); }
  @Get(':id') get(@Actor() a:Principal,@Param('id',IdPipe) id:string) { return this.service.get(a,id); }
}
@ApiTags('Session reports') @ApiBearerAuth() @Controller('sessions/:sessionId/reports') export class SessionReportsController {
  constructor(private readonly service:ReportsService) {}
  @Post() create(@Actor() a:Principal,@Param('sessionId',IdPipe) s:string,@Body() d:ReportDto) { return this.service.create(a,s,d); }
  @Post('batch') createBatch(@Actor() a:Principal,@Param('sessionId',IdPipe) s:string,@Body() d:BatchReportDto) { return this.service.createBatch(a,s,d); }
  @Patch(':id') update(@Actor() a:Principal,@Param('sessionId',IdPipe) s:string,@Param('id',IdPipe) id:string,@Body() d:UpdateReportDto) { return this.service.update(a,s,id,d); }
  @Post(':id/publish') publish(@Actor() a:Principal,@Param('sessionId',IdPipe) s:string,@Param('id',IdPipe) id:string) { return this.service.publish(a,s,id); }
}
@Module({imports:[NotificationsModule],controllers:[ReportsController,SessionReportsController],providers:[ReportsService]}) export class ReportsModule {}
