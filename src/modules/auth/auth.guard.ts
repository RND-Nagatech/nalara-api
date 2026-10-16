import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Database } from '../../database/database.module';
import { AuthRequest } from '../../common/api';
import { safeUser, tokenHash } from './auth.service';
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly db: Database) {}
  async canActivate(context: ExecutionContext) {
    if (this.reflector.getAllAndOverride('public', [context.getHandler(), context.getClass()])) return true;
    const req = context.switchToHttp().getRequest<AuthRequest>();
    const token = req.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
    if (!token) throw new UnauthorizedException('Silakan masuk');
    const session = await this.db.collection('authSessions').findOne({accessHash:tokenHash(token), accessExpiresAt:{$gt:new Date()}, expiresAt:{$gt:new Date()}}).lean();
    if (!session) throw new UnauthorizedException('Sesi telah berakhir');
    const user = await this.db.collection('users').findById(session.userId).lean();
    if (!user) throw new UnauthorizedException('Sesi tidak valid');
    if (user.role !== 'teacher') throw new ForbiddenException('Akses khusus guru');
    req.user = safeUser(user); req.sessionId = session._id;
    return true;
  }
}
