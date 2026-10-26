import { Body, Controller, Get, Module, Param, Patch, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Actor, IdPipe, Principal, Public } from '../../common/api';
import { InvitationsModule } from '../invitations/invitations.module';
import { PortalAuthGuard, PortalRequest } from '../invitations/portal.guard';
import { SaveTuitionFeeDto } from './tuition-fees.dto';
import { TuitionFeesService } from './tuition-fees.service';

@ApiTags('Tuition fees') @ApiBearerAuth() @Controller('students/:studentId/tuition-fee')
export class TuitionFeesController {
  constructor(private readonly service: TuitionFeesService) {}
  @Get() get(@Actor() actor: Principal, @Param('studentId', IdPipe) id: string) { return this.service.get(actor, id); }
  @Patch() save(@Actor() actor: Principal, @Param('studentId', IdPipe) id: string, @Body() dto: SaveTuitionFeeDto) { return this.service.save(actor, id, dto); }
}
@Public() @UseGuards(PortalAuthGuard) @ApiTags('Parent tuition fees') @ApiBearerAuth()
@Controller('portal/students/:studentId/tuition-fee')
export class ParentTuitionFeesController {
  constructor(private readonly service: TuitionFeesService) {}
  @Get() get(@Req() req: PortalRequest, @Param('studentId', IdPipe) id: string) { return this.service.parent(req.portalAccount, id); }
}
@Module({imports: [InvitationsModule], controllers: [TuitionFeesController, ParentTuitionFeesController], providers: [TuitionFeesService]})
export class TuitionFeesModule {}
