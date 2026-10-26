import { Body, Controller, ForbiddenException, Get, Module, NotFoundException, Param, Patch, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Actor, Public } from '../../common/api';
import type { Principal } from '../../common/api';
import { InvitationsModule } from '../invitations/invitations.module';
import { PortalAuthGuard } from '../invitations/portal.guard';
import type { PortalRequest } from '../invitations/portal.guard';
import { avatarAssets, avatarAssetsRoot } from './avatar-catalog';
import { UpdateAvatarDto } from './avatars.dto';
import { AvatarsService } from './avatars.service';

@ApiTags('Profile avatars')
@ApiBearerAuth()
@Controller()
export class AvatarsController {
  constructor(private readonly service: AvatarsService) {}
  @Get('me/avatars') teacherOptions() { return this.service.options('teacher'); }
  @Patch('me/avatar') teacher(@Actor() actor: Principal, @Body() dto: UpdateAvatarDto) { return this.service.teacher(actor, dto.avatarId); }
  @Public() @UseGuards(PortalAuthGuard) @Get('portal/student/profile/avatars') studentOptions(@Req() req: PortalRequest) {
    if (req.portalAccount.role !== 'student') throw new ForbiddenException('Pilihan karakter ini khusus akun Siswa.');
    return this.service.options('student');
  }
  @Public() @UseGuards(PortalAuthGuard) @Patch('portal/student/profile/avatar') student(@Req() req: PortalRequest, @Body() dto: UpdateAvatarDto) {
    return this.service.student(req.portalAccount, dto.avatarId);
  }
  @Public() @Get('avatars/:id/image') image(@Param('id') id: string, @Res() response: Response) {
    const entry = avatarAssets.find(avatar => avatar.avatarId === id);
    if (!entry) throw new NotFoundException('Karakter profil tidak ditemukan.');
    return response.sendFile(entry.file, { root: avatarAssetsRoot, headers: {
      'Cache-Control': 'public, max-age=86400', 'Cross-Origin-Resource-Policy': 'cross-origin',
    } });
  }
}

@Module({ imports: [InvitationsModule], controllers: [AvatarsController], providers: [AvatarsService] })
export class AvatarsModule {}
