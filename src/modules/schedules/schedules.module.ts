import { Body, Controller, Get, Module, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Actor, IdPipe, Principal } from '../../common/api';
import { ListQuery } from '../../common/query.dto';
import { AttendanceDto, BatchAttendanceDto, RepeatScheduleDto, ScheduleDto, UpdateScheduleDto, UpdateSessionDto } from './schedules.dto';
import { ScheduleRepeatWorker } from './schedule-repeat-worker.service';
import { SchedulesService } from './schedules.service';
import { NotificationsModule } from '../notifications/notifications.module';
@ApiTags('Schedules') @ApiBearerAuth() @Controller('schedules') export class SchedulesController {
  constructor(private readonly service:SchedulesService) {}
  @Get() list(@Actor() a:Principal,@Query() q:ListQuery) { return this.service.list(a,q); }
  @Post() create(@Actor() a:Principal,@Body() d:ScheduleDto) { return this.service.create(a,d); }
  @Get(':id') get(@Actor() a:Principal,@Param('id',IdPipe) id:string) { return this.service.get(a,id); }
  @Patch(':id') update(@Actor() a:Principal,@Param('id',IdPipe) id:string,@Body() d:UpdateScheduleDto) { return this.service.update(a,id,d); }
  @Post(':id/repeat') repeat(@Actor() a:Principal,@Param('id',IdPipe) id:string,@Body() d:RepeatScheduleDto) { return this.service.changeRepeat(a,id,d); }
}
@ApiTags('Sessions') @ApiBearerAuth() @Controller('sessions') export class SessionsController {
  constructor(private readonly service:SchedulesService) {}
  @Get() list(@Actor() a:Principal,@Query() q:ListQuery) { return this.service.sessions(a,q); }
  @Get(':id') get(@Actor() a:Principal,@Param('id',IdPipe) id:string) { return this.service.session(a,id); }
  @Patch(':id') update(@Actor() a:Principal,@Param('id',IdPipe) id:string,@Body() d:UpdateSessionDto) { return this.service.updateSession(a,id,d); }
  @Patch(':id/attendance') attendance(@Actor() a:Principal,@Param('id',IdPipe) id:string,@Body() d:AttendanceDto) { return this.service.attendance(a,id,d); }
  @Patch(':id/attendance-batch') batchAttendance(@Actor() a:Principal,@Param('id',IdPipe) id:string,@Body() d:BatchAttendanceDto) { return this.service.batchAttendance(a,id,d); }
}
@Module({imports:[NotificationsModule],controllers:[SchedulesController,SessionsController],providers:[SchedulesService,ScheduleRepeatWorker]}) export class SchedulesModule {}
