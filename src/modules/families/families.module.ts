import { Body, Controller, Get, Module, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Actor, IdPipe, Principal } from '../../common/api';
import { ListQuery } from '../../common/query.dto';
import { InvitationsModule, InvitationsService } from '../invitations/invitations.module';
import { FamilyDto, UpdateFamilyDto } from './families.dto';
import { FamiliesService } from './families.service';
@ApiTags('Families') @ApiBearerAuth() @Controller('families')
export class FamiliesController {
  constructor(private readonly families:FamiliesService, private readonly invitations:InvitationsService) {}
  @Get() list(@Actor() a:Principal,@Query() q:ListQuery) { return this.families.list(a,q); }
  @Post() create(@Actor() a:Principal,@Body() d:FamilyDto) { return this.families.create(a,d); }
  @Get(':id') get(@Actor() a:Principal,@Param('id',IdPipe) id:string) { return this.families.get(a,id); }
  @Patch(':id') update(@Actor() a:Principal,@Param('id',IdPipe) id:string,@Body() d:UpdateFamilyDto) { return this.families.update(a,id,d); }
  @Post(':id/invitations') invite(@Actor() a:Principal,@Param('id',IdPipe) id:string) { return this.invitations.issueFamily(a,id); }
  @Get(':id/invitations') invites(@Actor() a:Principal,@Param('id',IdPipe) id:string,@Query() q:ListQuery) { return this.invitations.familyInvitations(a,id,q); }
  @Post(':id/invitations/:invitationId/revoke') revoke(@Actor() a:Principal,@Param('id',IdPipe) id:string,@Param('invitationId',IdPipe) invite:string) { return this.invitations.revokeFamily(a,id,invite); }
  @Post(':id/access/revoke') revokeAccess(@Actor() a:Principal,@Param('id',IdPipe) id:string) { return this.invitations.revokeAccess(a,{familyId:id},'parent'); }
}
@Module({imports:[InvitationsModule],controllers:[FamiliesController],providers:[FamiliesService]}) export class FamiliesModule {}
