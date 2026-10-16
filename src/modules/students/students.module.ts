import { Body, Controller, Get, Module, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Actor, IdPipe, Principal } from '../../common/api';
import { ListQuery } from '../../common/query.dto';
import { StudentDto, UpdateStudentDto } from './students.dto';
import { StudentsService } from './students.service';
import { StudentSummaryService } from './student-summary.service';
import { StudentListProgressService } from './student-list-progress.service';
import { InvitationsModule, InvitationsService } from '../invitations/invitations.module';
@ApiTags('Students') @ApiBearerAuth() @Controller('students')
export class StudentsController {
  constructor(private readonly service:StudentsService,private readonly codes:InvitationsService,private readonly summary:StudentSummaryService) {}
  @Get() list(@Actor() a:Principal,@Query() q:ListQuery) { return this.service.list(a,q); }
  @Post() create(@Actor() a:Principal,@Body() d:StudentDto) { return this.service.create(a,d); }
  @Get(':id') get(@Actor() a:Principal,@Param('id',IdPipe) id:string) { return this.service.get(a,id); }
  @Get(':id/summary') getSummary(@Actor() a:Principal,@Param('id',IdPipe) id:string) { return this.summary.get(a,id); }
  @Patch(':id') update(@Actor() a:Principal,@Param('id',IdPipe) id:string,@Body() d:UpdateStudentDto) { return this.service.update(a,id,d); }
  @Post(':id/invitations') invite(@Actor() a:Principal,@Param('id',IdPipe) id:string) { return this.service.invite(a,id); }
  @Get(':id/invitations') invitations(@Actor() a:Principal,@Param('id',IdPipe) id:string,@Query() q:ListQuery) { return this.service.invitations(a,id,q); }
  @Post(':id/invitations/:invitationId/revoke') revoke(@Actor() a:Principal,@Param('id',IdPipe) id:string,@Param('invitationId',IdPipe) invitationId:string) { return this.service.revoke(a,id,invitationId); }
  @Post(':id/access/revoke') revokeAccess(@Actor() a:Principal,@Param('id',IdPipe) id:string) { return this.codes.revokeAccess(a,{studentId:id},'student'); }
}
@Module({imports:[InvitationsModule],controllers:[StudentsController],providers:[StudentsService,StudentSummaryService,StudentListProgressService],exports:[StudentSummaryService,StudentListProgressService]}) export class StudentsModule {}
