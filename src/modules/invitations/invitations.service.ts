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
    const code = createReferralCode(), invitationId = randomUUID();
    const invitation = await this.db.connection.transaction(async session=>{
      await this.scope.activeStudent(id,actor,session);
      await this.db.collection('students').updateOne({_id:id,workspaceId:actor.workspaceId},{$inc:{invitationVersion:1},$set:{currentInvitationId:invitationId}},{session});
      await this.db.collection('invitations').updateMany({workspaceId:actor.workspaceId,studentId:id,audience:'student',revokedAt:{$exists:false}},{$set:{revokedAt:new Date()}},{session});
      const [invite] = await this.db.collection('invitations').create([{_id:invitationId,studentId:id,audience:'student',workspaceId:actor.workspaceId,tokenHash:referralCodeHash(code.raw),expiresAt:null}],{session});
      await this.scope.audit(actor,'invitation.student.created',invite._id,session);
      return invite.toObject();
    });
    return {_id:invitation._id,studentId:id,audience:'student',token:code.display,expiresAt:null};
  }
  async issueFamily(actor:Principal,id:string) {
    const code = createReferralCode(), invitationId = randomUUID();
    const invitation = await this.db.connection.transaction(async session=>{
      await this.scope.get('families',id,actor,session);
      if (!await this.db.collection('students').exists({workspaceId:actor.workspaceId,familyId:id,status:'active'}).session(session)) throw new BadRequestException('Hubungkan minimal satu siswa aktif ke Orang Tua ini sebelum membuat kode keluarga');
      await this.db.collection('families').updateOne({_id:id,workspaceId:actor.workspaceId},{$inc:{invitationVersion:1},$set:{currentInvitationId:invitationId}},{session});
      await this.db.collection('invitations').updateMany({workspaceId:actor.workspaceId,familyId:id,audience:'parent',revokedAt:{$exists:false}},{$set:{revokedAt:new Date()}},{session});
      const [invite] = await this.db.collection('invitations').create([{_id:invitationId,familyId:id,audience:'parent',workspaceId:actor.workspaceId,tokenHash:referralCodeHash(code.raw),expiresAt:null}],{session});
      await this.scope.audit(actor,'invitation.family.created',invite._id,session);
      return invite.toObject();
    });
    return {_id:invitation._id,familyId:id,audience:'parent',token:code.display,expiresAt:null};
  }

  private async latestInvitation(workspaceId:string,target:{familyId?:string;studentId?:string},audience:'parent'|'student',currentInvitationId?:string,session?:ClientSession) {
    const filter = {workspaceId,...target,audience};
    if (currentInvitationId) return this.db.collection('invitations').findOne({...filter,_id:currentInvitationId}).session(session??null).lean();
    // Legacy records have no pointer: use the newest record, even if revoked,
    // so an older used/unrevoked code can never become active again.
    const [latest] = await this.db.collection('invitations').find(filter).sort({createdAt:-1,_id:-1}).limit(1).session(session??null).lean();
    return latest ?? null;
  }

  private latestPage(invitation:Invitation|null,query:ListQuery) {
    // History is retained for audits, but only the current card is public here.
    const items = invitation && query.page===1 ? [{_id:invitation._id,studentId:invitation.studentId,familyId:invitation.familyId,
      audience:invitation.audience,expiresAt:null,revokedAt:invitation.revokedAt,lastUsedAt:invitation.lastUsedAt??invitation.redeemedAt,
      useCount:invitation.useCount??(invitation.redeemedAt?1:0),createdAt:invitation.createdAt}] : [];
    return {items,total:invitation?1:0,page:query.page,limit:1};
  }

  async studentInvitations(actor:Principal,id:string,query:ListQuery) {
    const student = await this.scope.get('students',id,actor);
    return this.latestPage(await this.latestInvitation(actor.workspaceId,{studentId:id},'student',student.currentInvitationId),query);
  }
  async familyInvitations(actor:Principal,id:string,query:ListQuery) {
    const family = await this.scope.get('families',id,actor);
    return this.latestPage(await this.latestInvitation(actor.workspaceId,{familyId:id},'parent',family.currentInvitationId),query);
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
      await this.db.collection('notificationDevices').deleteMany({workspaceId:actor.workspaceId,accountType:role,accountId:{$in:accounts.map(a=>a._id)}},{session});
      await this.db.collection('notifications').updateMany({workspaceId:actor.workspaceId,recipientAccountId:{$in:accounts.map(a=>a._id)},deliveryStatus:{$in:['pending','delivering']}},{$set:{deliveryStatus:'suppressed'},$unset:{deliveryClaimId:1,deliveryLeaseUntil:1,deliveryNextAttemptAt:1}},{session});
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
    const student = await this.db.collection('students').findOne({_id:account.studentId,workspaceId:account.workspaceId,status:'active'}).select('_id name grade avatarId').session(session??null).lean();
    if (!student) throw new UnauthorizedException('Akses siswa tidak tersedia. Hubungi Guru.');
    return {role:'student' as const,name:student.name,students:[student]};
  }
  private async usableInvitation(token:string,audience?:'student'|'parent',session?:ClientSession) {
    const normalized=normalizeReferralCode(token);
    if (!isNormalizedReferralCode(normalized)) throw wrongReferralCode();
    if (audience && !['student','parent'].includes(audience)) throw new BadRequestException(referralMessages.invalidRole);
    // Do not filter out inactive records: their state determines the message.
    const invitation=await this.db.collection('invitations').findOne({tokenHash:referralCodeHash(normalized)}).session(session??null).lean();
    assertUsableInvitation(invitation);
    const target = invitation.audience==='parent' ? {familyId:invitation.familyId!} : {studentId:invitation.studentId!};
    const record = invitation.audience==='parent'
      ? await this.db.collection('families').findOne({_id:invitation.familyId,workspaceId:invitation.workspaceId}).session(session??null).lean()
      : await this.db.collection('students').findOne({_id:invitation.studentId,workspaceId:invitation.workspaceId}).session(session??null).lean();
    if (!record) throw inactiveReferralCode();
    const latest = await this.latestInvitation(invitation.workspaceId,target,invitation.audience,record.currentInvitationId,session);
    if (latest?._id!==invitation._id) throw inactiveReferralCode();
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
      const workspace = await this.db.collection('workspaces').updateOne({_id: candidate.workspaceId, deletionRequestedAt: {$exists: false}}, {$inc: {scheduleVersion: 1}}, {session});
      if (!workspace.matchedCount) throw inactiveReferralCode();
      const invite = await this.db.collection('invitations').findOneAndUpdate({_id:candidate._id,workspaceId:candidate.workspaceId,audience:dto.audience,revokedAt:{$exists:false}},{$set:{lastUsedAt:new Date()},$inc:{useCount:1}},{session,returnDocument:'after'}).lean();
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
      if (!saved) throw new UnauthorizedException('Sesi referral berakhir. Silakan masuk kembali menggunakan kode referral terbaru dari Guru.');
      const account = await this.db.collection('portalAccounts').findOne({_id:saved.accountId,status:'active'}).session(session).lean();
      if (!account) throw new UnauthorizedException('Akses dicabut. Hubungi Guru.');
      return {...tokens,profile:await this.profile(account,session)};
    });
  }
  // Revocation needs the refresh credential, not a valid child profile. It must
  // still work after access expiry or after the last child has been archived.
  async logout(refreshToken:string) { await this.db.collection('portalSessions').deleteOne({refreshHash:referralCodeHash(refreshToken)}); return {message:'Berhasil keluar'}; }

  /**
   * Portal accounts are access accounts, not owners of the teacher's
   * learning records. Deleting one therefore removes the portal identity,
   * sessions, devices, and inbox rows while retaining the child/family data
   * managed by the teacher. A referral can be redeemed again only if the
   * teacher still chooses to issue/keep access for that relationship.
   */
  async deletePortalAccount(account: Pick<PortalAccount, '_id'|'workspaceId'|'role'>) {
    await this.db.connection.transaction(async session => {
      const current = await this.db.collection('portalAccounts').findOne({
        _id: account._id,
        workspaceId: account.workspaceId,
        role: account.role,
        status: 'active',
      }).session(session).lean();
      if (!current) throw new UnauthorizedException('Akun portal sudah tidak aktif.');

      await this.db.collection('portalSessions').deleteMany({accountId: current._id}, {session});
      await this.db.collection('notificationDevices').deleteMany({
        workspaceId: current.workspaceId,
        accountType: current.role,
        accountId: current._id,
      }, {session});
      await this.db.collection('notifications').deleteMany({
        workspaceId: current.workspaceId,
        recipientAccountId: current._id,
      }, {session});
      await this.db.collection('portalAccounts').deleteOne({
        _id: current._id,
        workspaceId: current.workspaceId,
        status: 'active',
      }, {session});
      await this.db.collection('audits').create([{
        workspaceId: current.workspaceId,
        actorId: current._id,
        action: 'portal.account.deleted',
        resourceId: current._id,
      }], {session});
    });
    return {
      accepted: true,
      message: 'Akun portal, sesi, perangkat, dan inbox Anda telah dihapus. Data siswa/keluarga yang dikelola Guru tidak ikut dihapus.',
    };
  }
}
