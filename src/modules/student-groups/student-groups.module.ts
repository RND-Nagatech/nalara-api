import { Body, Controller, Delete, Get, Module, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Actor, IdPipe, Principal } from '../../common/api';
import { ListQuery } from '../../common/query.dto';
import { StudentGroupDto, StudentGroupVersionDto, UpdateStudentGroupDto } from './student-groups.dto';
import { StudentGroupsService } from './student-groups.service';

@ApiTags('Student groups') @ApiBearerAuth() @Controller('student-groups')
export class StudentGroupsController {
  constructor(private readonly service: StudentGroupsService) {}
  @Get() list(@Actor() actor: Principal, @Query() query: ListQuery) { return this.service.list(actor, query); }
  @Get(':id') get(@Actor() actor: Principal, @Param('id', IdPipe) id: string) { return this.service.get(actor, id); }
  @Post() create(@Actor() actor: Principal, @Body() dto: StudentGroupDto) { return this.service.create(actor, dto); }
  @Patch(':id') update(@Actor() actor: Principal, @Param('id', IdPipe) id: string, @Body() dto: UpdateStudentGroupDto) { return this.service.update(actor, id, dto); }
  @Delete(':id') remove(@Actor() actor: Principal, @Param('id', IdPipe) id: string, @Body() dto: StudentGroupVersionDto) { return this.service.remove(actor, id, dto.version); }
}
@Module({controllers: [StudentGroupsController], providers: [StudentGroupsService]})
export class StudentGroupsModule {}
