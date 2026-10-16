import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { Database } from '../../database/database.module';
import { referralCodeHash } from './referral-code';
import { InvitationsService } from './invitations.service';
import type { PortalAccount } from '../../database/entities';
export type PortalRequest = Request & {portalSessionId:string;portalAccount:PortalAccount;portalProfile:Awaited<ReturnType<InvitationsService['profile']>>};
@Injectable()
export class PortalAuthGuard implements CanActivate {
  constructor(private readonly db:Database,private readonly invitations:InvitationsService) {}
  async canActivate(context:ExecutionContext) {
    const request = context.switchToHttp().getRequest<PortalRequest>();
    const token = request.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
    if (!token) throw new UnauthorizedException('Sesi referral diperlukan');
    const session = await this.db.collection('portalSessions').findOne({accessHash:referralCodeHash(token),accessExpiresAt:{$gt:new Date()},expiresAt:{$gt:new Date()}}).lean();
    if (!session) throw new UnauthorizedException('Sesi referral berakhir');
    const account = await this.db.collection('portalAccounts').findOne({_id:session.accountId,status:'active'}).lean();
    if (!account) throw new UnauthorizedException('Akses dicabut. Hubungi Guru.');
    request.portalAccount = account;
    request.portalProfile = await this.invitations.profile(account);
    request.portalSessionId = session._id;
    return true;
  }
}
