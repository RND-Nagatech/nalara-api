import { BadRequestException, ConflictException, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { hash, verify, argon2id } from 'argon2';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { ClientSession } from 'mongoose';
import { Database } from '../../database/database.module';
import type { User } from '../../database/entities';
import { ForgotDto, GoogleLoginDto, LoginDto, RegisterDto, ResetDto, VerifyResetOtpDto } from './auth.dto';
import { FirebaseAuthService } from './firebase-auth.service';
import { normalizePhone } from './phone-number';
import { assertPasswordPolicy } from './password-policy';
import { PasswordResetOtpService } from './password-reset-otp.service';
import { ResendMailService } from './resend-mail.service';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
export const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
export const safeUser = (user: User) => ({_id: user._id, name: user.name, email: user.email, phone: user.phone, avatarId: user.avatarId ?? null, role: user.role, workspaceId: user.workspaceId, timezone: user.timezone});
@Injectable()
export class AuthService {
  constructor(private readonly db: Database, private readonly firebase: FirebaseAuthService, private readonly passwordResetOtp: PasswordResetOtpService, private readonly resendMail: ResendMailService, private readonly subscriptions: SubscriptionsService) {}
  async register(dto: RegisterDto) {
    assertPasswordPolicy(dto.password);
    if (dto.passwordConfirmation !== dto.password) throw new BadRequestException('Ulangi kata sandi harus sama dengan kata sandi');
    const email = dto.email.toLowerCase().trim();
    const phone = normalizePhone(dto.phone);
    if (!phone) throw new BadRequestException('Nomor HP Indonesia tidak valid');
    if (await this.db.collection('users').exists({email})) throw new ConflictException('Email tersebut sudah terdaftar. Silakan login atau ganti kata sandi.');
    if (await this.db.collection('users').exists({phone})) throw new ConflictException('Nomor HP tersebut sudah terdaftar. Silakan login atau ganti kata sandi.');
    const passwordHash = await hash(dto.password, {type: argon2id});
    const workspaceId = randomUUID();
    const userId = randomUUID();
    try {
      const user = await this.db.connection.transaction(async session => {
        await this.db.collection('workspaces').create([{_id: workspaceId, ownerId: userId, name: `Bimbel ${dto.name}`}], {session});
        const [record] = await this.db.collection('users').create([{_id: userId, name: dto.name.trim(), email, phone, passwordHash, workspaceId}], {session});
        return record.toObject();
      });
      return this.issue(user);
    } catch (error) {
      const duplicate = error as {code?:number; keyPattern?:Record<string,unknown>; keyValue?:Record<string,unknown>};
      if (duplicate.code === 11000 && (duplicate.keyPattern?.email || duplicate.keyValue?.email)) throw new ConflictException('Email tersebut sudah terdaftar. Silakan login atau ganti kata sandi.');
      if (duplicate.code === 11000 && (duplicate.keyPattern?.phone || duplicate.keyValue?.phone)) throw new ConflictException('Nomor HP tersebut sudah terdaftar. Silakan login atau ganti kata sandi.');
      throw error;
    }
  }
  async login(dto: LoginDto) {
    if ((dto.email === undefined) === (dto.phone === undefined)) throw new BadRequestException('Gunakan tepat satu: email atau nomor HP');
    const phone = dto.phone === undefined ? null : normalizePhone(dto.phone);
    if (dto.phone !== undefined && !phone) throw new BadRequestException('Nomor HP Indonesia tidak valid');
    const identity = dto.email !== undefined ? {email: dto.email.toLowerCase().trim()} : {phone: phone!};
    const invalidCredentials = dto.email !== undefined
      ? 'Email atau kata sandi salah. Silakan cek kembali atau gunakan Lupa kata sandi.'
      : 'Nomor HP atau kata sandi salah. Silakan cek kembali atau gunakan Lupa kata sandi.';
    const user = await this.db.collection('users').findOne(identity).select('+passwordHash').lean();
    // Keep unknown identities and wrong passwords indistinguishable to avoid
    // exposing which email or phone numbers have an account.
    if (!user) throw new UnauthorizedException(invalidCredentials);
    if (!await verify(user.passwordHash, dto.password)) throw new UnauthorizedException(invalidCredentials);
    if (user.deletionRequestedAt) throw new ForbiddenException('Akun sedang dihapus dan tidak dapat digunakan kembali.');
    return this.issue(user);
  }
  async loginWithGoogle(dto: GoogleLoginDto) {
    const decoded = await this.firebase.verifyIdToken(dto.idToken, true);
    const email = decoded.email?.trim().toLowerCase();
    if (!email || decoded.email_verified !== true) {
      throw new UnauthorizedException('Akun Google harus memiliki email terverifikasi.');
    }
    await this.assertGoogleIdentityOpen(decoded.uid);

    const users = this.db.collection('users');
    let user = await users.findOne({firebaseUid: decoded.uid}).lean();
    if (!user) {
      const emailUser = await users.findOne({email}).lean();
      if (emailUser) {
        if (emailUser.deletionRequestedAt) throw new ForbiddenException('Akun sedang dihapus dan tidak dapat digunakan kembali.');
        if (emailUser.firebaseUid && emailUser.firebaseUid !== decoded.uid) {
          throw new ConflictException('Email sudah terhubung ke akun Google lain.');
        }
        await this.assertGoogleIdentityOpen(decoded.uid);
        const linked = await users.updateOne({_id: emailUser._id, workspaceId: emailUser.workspaceId,
          deletionRequestedAt: {$exists: false},
          ...(emailUser.firebaseUid ? {firebaseUid: emailUser.firebaseUid} : {firebaseUid: {$exists: false}})},
        {$set: {firebaseUid: decoded.uid}});
        if (linked.matchedCount !== 1) throw new ConflictException('Informasi akun berubah. Silakan masuk kembali.');
        user = await users.findById(emailUser._id).lean();
      } else {
        const userId = randomUUID();
        const workspaceId = randomUUID();
        const name = (decoded.name?.trim() || email.split('@')[0]).slice(0, 100);
        const passwordHash = await hash(randomBytes(32).toString('base64url'), {type: argon2id});
        user = await this.db.connection.transaction(async session => {
          // A token verified before erasure must not recreate its old identity
          // after the worker has already removed the previous user record.
          await this.assertGoogleIdentityOpen(decoded.uid, session);
          await this.db.collection('workspaces').create([{_id: workspaceId, ownerId: userId, name: `Bimbel ${name}`}], {session});
          const [record] = await users.create([{_id: userId, name, email, passwordHash, firebaseUid: decoded.uid, workspaceId}], {session});
          return record.toObject();
        });
      }
    }
    if (!user) throw new UnauthorizedException('Akun Google tidak dapat dibuat.');
    return this.issue(user);
  }
  private async assertGoogleIdentityOpen(uid: string, session?: ClientSession) {
    if (await this.db.collection('accountDeletions').exists({$or: [{firebaseUid: uid}, {firebaseUidHash: tokenHash(uid)}]}).session(session ?? null)) {
      throw new ForbiddenException('Identitas NALARA ini sudah ditutup untuk penghapusan. Mulai login Google baru setelah proses selesai.');
    }
  }
  private tokens() { return {accessToken: randomBytes(32).toString('base64url'), refreshToken: randomBytes(48).toString('base64url'), accessExpiresAt: new Date(Date.now() + 15 * 60_000), expiresAt: new Date(Date.now() + 30 * 86400_000)}; }
  private async issue(user: User) {
    if (user.deletionRequestedAt) throw new ForbiddenException('Akun sedang dihapus dan tidak dapat digunakan kembali.');
    await this.subscriptions.ensure(user.workspaceId);
    const tokens = this.tokens();
    await this.db.connection.transaction(async session => {
      const admitted = await this.db.collection('users').updateOne({_id: user._id, workspaceId: user.workspaceId, deletionRequestedAt: {$exists: false}}, {$inc: {authVersion: 1}}, {session});
      if (!admitted.matchedCount) throw new ForbiddenException('Akun sedang dihapus dan tidak dapat digunakan kembali.');
      await this.db.collection('authSessions').create([{userId: user._id, accessHash: tokenHash(tokens.accessToken), refreshHash: tokenHash(tokens.refreshToken), accessExpiresAt: tokens.accessExpiresAt, expiresAt: tokens.expiresAt}], {session});
    });
    return {...tokens, user: safeUser(user)};
  }
  async refresh(refreshToken: string) {
    const tokens = this.tokens();
    const session = await this.db.collection('authSessions').findOneAndUpdate({refreshHash: tokenHash(refreshToken), expiresAt: {$gt: new Date()}}, {$set: {accessHash: tokenHash(tokens.accessToken), refreshHash: tokenHash(tokens.refreshToken), accessExpiresAt: tokens.accessExpiresAt}}, {returnDocument: 'after'}).lean();
    if (!session) throw new UnauthorizedException('Sesi telah berakhir');
    const user = await this.db.collection('users').findById(session.userId).lean();
    if (!user || user.deletionRequestedAt) throw new UnauthorizedException('Sesi tidak valid');
    return {...tokens, expiresAt: session.expiresAt, user: safeUser(user)};
  }
  async logout(sessionId: string) { await this.db.collection('authSessions').deleteOne({_id: sessionId}); return {message: 'Berhasil keluar'}; }
  async forgot(dto: ForgotDto) {
    const email = dto.email.toLowerCase().trim();
    const user = await this.db.collection('users').findOne({email, deletionRequestedAt: {$exists: false}}).lean();
    const challenge = await this.passwordResetOtp.issue(email, user?._id);
    if (user && challenge.otp) await this.resendMail.sendPasswordResetOtp(user.email, challenge.otp, challenge.expiresInSeconds);
    return {accepted: true, otpExpiresInSeconds: this.passwordResetOtp.expiresInSeconds};
  }
  async verifyResetOtp(dto: VerifyResetOtpDto) {
    const resetToken = await this.passwordResetOtp.verify(dto.email.toLowerCase().trim(), dto.otp);
    return {resetToken};
  }
  async reset(dto: ResetDto) {
    assertPasswordPolicy(dto.newPassword);
    const userId = await this.passwordResetOtp.peek(dto.resetToken);
    const user = await this.db.collection('users').findById(userId).select('+passwordHash').lean();
    if (!user || user.deletionRequestedAt) throw new UnauthorizedException('Token reset tidak valid.');
    if (await verify(user.passwordHash, dto.newPassword)) {
      throw new ConflictException('Password baru tidak boleh sama dengan password sebelumnya.');
    }
    const consumedUserId = await this.passwordResetOtp.consume(dto.resetToken);
    if (consumedUserId !== userId) throw new UnauthorizedException('Token reset tidak valid.');
    const passwordHash = await hash(dto.newPassword, {type: argon2id});
    const updated = await this.db.collection('users').updateOne({_id: userId, deletionRequestedAt: {$exists: false}}, {$set:{passwordHash}});
    if (updated.matchedCount !== 1) throw new UnauthorizedException('Token reset tidak valid.');
    await this.db.collection('authSessions').deleteMany({userId});
    return {message: 'Kata sandi diperbarui. Silakan masuk kembali.'};
  }
}
