import { UnauthorizedException } from '@nestjs/common';
import type { Invitation } from '../../database/entities';

export const referralMessages = {
  wrongCode: 'Kode referral salah. Periksa kembali kode referral yang diberikan. Jika masih salah, silakan minta kode referral baru kepada Guru.',
  inactiveCode: 'Kode referral sudah tidak aktif. Silakan minta kode referral terbaru kepada Guru.',
  wrongRole: 'Kode referral tidak sesuai dengan peran yang dipilih. Periksa pilihan peran Anda atau minta kode referral yang sesuai kepada Guru.',
  invalidRole: 'Pilih peran Siswa atau Orang Tua untuk menggunakan kode referral.',
} as const;

export const wrongReferralCode = () => new UnauthorizedException(referralMessages.wrongCode);
export const inactiveReferralCode = () => new UnauthorizedException(referralMessages.inactiveCode);
type InvitationState = Pick<Invitation, 'audience' | 'familyId' | 'studentId' | 'expiresAt' | 'revokedAt' | 'redeemedAt'>;

/** Diagnose only the secret's state; never include the target or owner in errors. */
export function assertUsableInvitation(invitation:InvitationState | null, audience?:'student'|'parent', now:Date = new Date()):asserts invitation is InvitationState {
  if (!invitation) throw wrongReferralCode();
  if (invitation.revokedAt!==undefined || invitation.redeemedAt!==undefined ||
      !(invitation.expiresAt instanceof Date) || !Number.isFinite(invitation.expiresAt.getTime()) || invitation.expiresAt<=now ||
      !['student','parent'].includes(invitation.audience) ||
      (invitation.audience==='parent' ? !invitation.familyId : !invitation.studentId)) {
    throw inactiveReferralCode();
  }
  if (audience && invitation.audience!==audience) throw new UnauthorizedException(referralMessages.wrongRole);
}
