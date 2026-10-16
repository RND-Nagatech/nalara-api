import { Body, Controller, Get, Module, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Actor, IdPipe, Principal } from '../../common/api';
import { ListQuery } from '../../common/query.dto';
import { PlanDto, ProgressDto, TargetDto, UpdateTargetDto } from './learning.dto';
import { LearningService } from './learning.service';
import { NotificationsModule } from '../notifications/notifications.module';
@ApiTags('Learning plans') @ApiBearerAuth() @Controller('learning-plans') export class PlansController {
  constructor(private readonly service:LearningService) {}
  @Get() list(@Actor() a:Principal,@Query() q:ListQuery) { return this.service.plans(a,q); }
  @Post() create(@Actor() a:Principal,@Body() d:PlanDto) { return this.service.createPlan(a,d); }
  @Get(':id') get(@Actor() a:Principal,@Param('id',IdPipe) id:string) { return this.service.plan(a,id); }
  @Post(':id/targets') add(@Actor() a:Principal,@Param('id',IdPipe) id:string,@Body() d:TargetDto) { return this.service.addTarget(a,id,d); }
}
@ApiTags('Targets') @ApiBearerAuth() @Controller('targets') export class TargetsController {
  constructor(private readonly service:LearningService) {}
  @Get() list(@Actor() a:Principal,@Query() q:ListQuery) { return this.service.targets(a,q); }
  @Get(':id') get(@Actor() a:Principal,@Param('id',IdPipe) id:string) { return this.service.target(a,id); }
  @Patch(':id') update(@Actor() a:Principal,@Param('id',IdPipe) id:string,@Body() d:UpdateTargetDto) { return this.service.update(a,id,d); }
  @Patch(':id/progress') progress(@Actor() a:Principal,@Param('id',IdPipe) id:string,@Body() d:ProgressDto) { return this.service.updateProgress(a,id,d); }
  @Get(':id/history') history(@Actor() a:Principal,@Param('id',IdPipe) id:string,@Query() q:ListQuery) { return this.service.history(a,id,q); }
}
@ApiTags('Student progress') @ApiBearerAuth() @Controller('students') export class StudentProgressController {
  constructor(private readonly service:LearningService) {}
  @Get(':id/progress') progress(@Actor() a:Principal,@Param('id',IdPipe) id:string,@Query() q:ListQuery) { return this.service.studentProgress(a,id,q); }
}
@Module({imports:[NotificationsModule],controllers:[PlansController,TargetsController,StudentProgressController],providers:[LearningService],exports:[LearningService]}) export class LearningModule {}
