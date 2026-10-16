import { Injectable, UnauthorizedException, BadRequestException } from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import type { ClientSession } from 'mongoose';
import type { Principal } from '../../common/api';
import { ScopedService } from '../../common/scoped.service';
import { ListQuery } from '../../common/query.dto';
import { Database } from '../../database/database.module';
import type { Invitation, PortalAccount } from '../../database/entities';
import { createReferralCode, isNormalizedReferralCode, normalizeReferralCode, referralCodeHash } from './referral-code';
import { RedeemCodeDto } from './invitations.dto';
import { assertUsableInvitation, inactiveReferralCode, referralMessages, wrongReferralCode } from './referral-errors';
@Injectable()
export class InvitationsService {
  constructor(private readonly db:Database,private readonly scope:ScopedService) {}
  async issueStudent(actor:Principal,id:string) {
    const code = createReferralCode(), expiresAt = new Date(Date.now()+7*86400_000);
    const invitation = await this.db.connection.transaction(async session=>{
      await this.scope.activeStudent(id,actor,session);
      await this.db.collection('students').updateOne({_id:id,workspaceId:actor.workspaceId},{$inc:{invitationVersion:1}},{session});
      await this.db.collection('invitations').updateMany({workspaceId:actor.workspaceId,studentId:id,audience:'student',redeemedAt:{$exists:false},revokedAt:{$exists:false}},{$set:{revokedAt:new Date()}},{session});
      const [invite] = await this.db.collection('invitations').create([{studentId:id,audience:'student',workspaceId:actor.workspaceId,tokenHash:referralCodeHash(code.raw),expiresAt}],{session});
      await this.scope.audit(actor,'invitation.student.created',invite._id,session);
      return invite.toObject();
    });
    return {_id:invitation._id,studentId:id,audience:'student',token:code.display,expiresAt};
  }
  async issueFamily(actor:Principal,id:string) {
    const code = createReferralCode(), expiresAt = new Date(Date.now()+7*86400_000);
    const invitation = await this.db.connection.transaction(async session=>{
      await this.scope.get('families',id,actor,session);
      if (!await this.db.collection('students').exists({workspaceId:actor.workspaceId,familyId:id,status:'active'}).session(session)) throw new BadRequestException('Hubungkan minimal satu siswa aktif ke Orang Tua ini sebelum membuat kode keluarga');
      await this.db.collection('families').updateOne({_id:id,workspaceId:actor.workspaceId},{$inc:{invitationVersion:1}},{session});
      await this.db.collection('invitations').updateMany({workspaceId:actor.workspaceId,familyId:id,audience:'parent',redeemedAt:{$exists:false},revokedAt:{$exists:false}},{$set:{revokedAt:new Date()}},{session});
      const [invite] = await this.db.collection('invitations').create([{familyId:id,audience:'parent',workspaceId:actor.workspaceId,tokenHash:referralCodeHash(code.raw),expiresAt}],{session});
      await this.scope.audit(actor,'invitation.family.created',invite._id,session);
      return invite.toObject();
    });
    return {_id:invitation._id,familyId:id,audience:'parent',token:code.display,expiresAt};
  }
  async familyInvitations(actor:Principal,id:string,query:ListQuery) {
    await this.scope.get('families',id,actor);
    return this.scope.list('invitations',actor,query,{familyId:id,audience:'parent'});
  }
  async revokeFamily(actor:Principal,id:string,inviteId:string) {
    await this.scope.get('families',id,actor);
    const invite = await this.scope.get('invitations',inviteId,actor);
    if (invite.familyId!==id) return this.scope.get('invitations','invalid',actor);
    await this.db.collection('invitations').updateOne({_id:inviteId,workspaceId:actor.workspaceId},{$set:{revokedAt:new Date()}});
    await this.scope.audit(actor,'invitation.family.revoked',inviteId);
    return {message:'Kode referral dicabut. Sesi yang sudah aktif dicabut melalui Cabut akses Orang Tua.'};
  }
  async revokeAccess(actor:Principal,target:{familyId?:string;studentId?:string},role:'parent'|'student') {
    if (target.familyId) await this.scope.get('families',target.familyId,actor);
    else await this.scope.get('students',target.studentId!,actor);
    await this.db.connection.transaction(async session=>{
      // Serialize access revocation with issuance/redemption, including a first
      // account that did not exist when this transaction started.
      if (target.familyId) await this.db.collection('families').updateOne({_id:target.familyId,workspaceId:actor.workspaceId},{$inc:{invitationVersion:1}},{session});
      else await this.db.collection('students').updateOne({_id:target.studentId,workspaceId:actor.workspaceId},{$inc:{invitationVersion:1}},{session});
      const accounts = await this.db.collection('portalAccounts').find({workspaceId:actor.workspaceId,role,...target}).session(session).lean();
      await this.db.collection('portalAccounts').updateMany({workspaceId:actor.workspaceId,role,...target},{$set:{status:'revoked'}},{session});
      await this.db.collection('portalSessions').deleteMany({accountId:{$in:accounts.map(a=>a._id)}},{session});
      await this.db.collection('invitations').updateMany({workspaceId:actor.workspaceId,audience:role,...target},{$set:{revokedAt:new Date()}},{session});
      await this.scope.audit(actor,'portal.access.revoked',target.familyId??target.studentId!,session);
    });
    return {message:'Akses dan sesi terkait dicabut. Buat kode baru untuk memberikan akses kembali.'};
  }
  async profile(account:Pick<PortalAccount,'workspaceId'|'role'|'familyId'|'studentId'>,session?:ClientSession) {
    if (account.role==='parent') {
      if (!account.familyId) throw inactiveReferralCode();
      const family = await this.db.collection('families').findOne({_id:account.familyId,workspaceId:account.workspaceId}).session(session??null).lean();
      if (!family) throw new UnauthorizedException('Akses keluarga tidak tersedia. Hubungi Guru.');
      const students = await this.db.collection('students').find({workspaceId:account.workspaceId,familyId:family._id,status:'active'}).select('_id name grade').sort({name:1}).session(session??null).lean();
      if (!students.length) throw new UnauthorizedException('Belum ada anak aktif yang terhubung. Hubungi Guru.');
      return {role:'parent' as const,name:family.parentName,phone:family.parentPhone,familyName:family.name,familyId:family._id,students};
    }
    const student = await this.db.collection('students').findOne({_id:account.studentId,workspaceId:account.workspaceId,status:'active'}).select('_id name grade').session(session??null).lean();
    if (!student) throw new UnauthorizedException('Akses siswa tidak tersedia. Hubungi Guru.');
    return {role:'student' as const,name:student.name,students:[student]};
  }
  private async usableInvitation(token:string,audience?:'student'|'parent',session?:ClientSession) {
    const normalized=normalizeReferralCode(token);
    if (!isNormalizedReferralCode(normalized)) throw wrongReferralCode();
    if (audience && !['student','parent'].includes(audience)) throw new BadRequestException(referralMessages.invalidRole);
    // Do not filter out inactive records: their state determines the message.
    const invitation=await this.db.collection('invitations').findOne({tokenHash:referralCodeHash(normalized)}).session(session??null).lean();
    assertUsableInvitation(invitation,audience);
    return invitation;
  }
  private async invitationProfile(invitation:Invitation,session?:ClientSession) {
    try { return await this.profile({...invitation,role:invitation.audience},session); }
    catch (error) {
      if (error instanceof UnauthorizedException) throw inactiveReferralCode();
      throw error; // Database/provider failures are not incorrect referral codes.
    }
  }
  async verify(token:string,audience?:'student'|'parent') {
    const invitation=await this.usableInvitation(token,audience);
    await this.invitationProfile(invitation);
    return {valid:true};
  }
  private tokens() { return {accessToken:randomBytes(32).toString('base64url'),refreshToken:randomBytes(48).toString('base64url'),accessExpiresAt:new Date(Date.now()+15*60_000),expiresAt:new Date(Date.now()+30*86400_000)}; }
  async redeem(dto:RedeemCodeDto) {
    if (!['student','parent'].includes(dto.audience)) throw new BadRequestException(referralMessages.invalidRole);
    const tokens = this.tokens();
    return this.db.connection.transaction(async session=>{
      const candidate=await this.usableInvitation(dto.token,dto.audience,session);
      const invite = await this.db.collection('invitations').findOneAndUpdate({_id:candidate._id,workspaceId:candidate.workspaceId,audience:dto.audience,expiresAt:{$gt:new Date()},revokedAt:{$exists:false},redeemedAt:{$exists:false}},{$set:{redeemedAt:new Date()}},{session,returnDocument:'after'}).lean();
      if (!invite) throw inactiveReferralCode();
      if (invite.audience==='parent') await this.db.collection('families').updateOne({_id:invite.familyId,workspaceId:invite.workspaceId},{$inc:{invitationVersion:1}},{session});
      else await this.db.collection('students').updateOne({_id:invite.studentId,workspaceId:invite.workspaceId},{$inc:{invitationVersion:1}},{session});
      const profile = await this.invitationProfile(invite,session);
      const target = invite.audience==='parent' ? {familyId:invite.familyId!} : {studentId:invite.studentId!};
      const account = await this.db.collection('portalAccounts').findOneAndUpdate({workspaceId:invite.workspaceId,role:invite.audience,...target},{$set:{status:'active'},$setOnInsert:{_id:randomUUID()}},{session,upsert:true,returnDocument:'after',runValidators:true}).lean();
      await this.db.collection('portalSessions').create([{accountId:account!._id,accessHash:referralCodeHash(tokens.accessToken),refreshHash:referralCodeHash(tokens.refreshToken),accessExpiresAt:tokens.accessExpiresAt,expiresAt:tokens.expiresAt}],{session});
      await this.db.collection('audits').create([{workspaceId:invite.workspaceId,actorId:account!._id,action:'portal.referral.redeemed',resourceId:invite._id}],{session});
      return {...tokens,profile};
    });
  }
  async refresh(refreshToken:string) {
    const tokens = this.tokens();
    return this.db.connection.transaction(async session=>{
      const saved = await this.db.collection('portalSessions').findOneAndUpdate({refreshHash:referralCodeHash(refreshToken),expiresAt:{$gt:new Date()}},{$set:{accessHash:referralCodeHash(tokens.accessToken),refreshHash:referralCodeHash(tokens.refreshToken),accessExpiresAt:tokens.accessExpiresAt,expiresAt:tokens.expiresAt}},{session,returnDocument:'after'}).lean();
      if (!saved) throw new UnauthorizedException('Sesi referral berakhir. Minta kode baru kepada Guru.');
      const account = await this.db.collection('portalAccounts').findOne({_id:saved.accountId,status:'active'}).session(session).lean();
      if (!account) throw new UnauthorizedException('Akses dicabut. Hubungi Guru.');
      return {...tokens,profile:await this.profile(account,session)};
    });
  }
  // Revocation needs the refresh credential, not a valid child profile. It must
  // still work after access expiry or after the last child has been archived.
  async logout(refreshToken:string) { await this.db.collection('portalSessions').deleteOne({refreshHash:referralCodeHash(refreshToken)}); return {message:'Berhasil keluar'}; }
}
