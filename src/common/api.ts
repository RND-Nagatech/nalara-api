import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Injectable, NestInterceptor, ExecutionContext, CallHandler, createParamDecorator, SetMetadata, PipeTransform, BadRequestException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { map } from 'rxjs';
import type { User } from '../database/entities';
import { Logger } from 'nestjs-pino';
export type Principal = Pick<User, '_id' | 'name' | 'email' | 'phone' | 'workspaceId' | 'role' | 'timezone'>;
export type AuthRequest = Request & {user: Principal; sessionId: string; id?: string};
export const Public = () => SetMetadata('public', true);
export const Actor = createParamDecorator((_data: unknown, ctx: ExecutionContext): Principal => ctx.switchToHttp().getRequest<AuthRequest>().user);
@Injectable()
export class IdPipe implements PipeTransform { transform(value: string) { if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new BadRequestException('Identitas tidak valid'); return value; } }
@Injectable()
export class EnvelopeInterceptor implements NestInterceptor { intercept(_ctx: ExecutionContext, next: CallHandler) { return next.handle().pipe(map(data => ({data}))); } }
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  constructor(private readonly logger:Logger) {}
  catch(error: unknown, host: ArgumentsHost) {
    const request = host.switchToHttp().getRequest<AuthRequest>();
    const response = host.switchToHttp().getResponse<Response>();
    const status = error instanceof HttpException ? error.getStatus() : (error as {code?: number})?.code === 11000 ? 409 : 500;
    if(status>=500) this.logger.error({requestId:request.id,errorType:error instanceof Error?error.name:'Unknown',errorMessage:error instanceof Error?error.message:String(error),status},'Unhandled API error');
    const payload = error instanceof HttpException ? error.getResponse() : null;
    const message = typeof payload === 'string' ? payload : (payload as {message?: unknown})?.message ?? (status === 409 ? 'Data sudah tersedia' : 'Terjadi kesalahan pada server');
    const details = payload && typeof payload === 'object' ? payload as {code?: string; feature?: string; route?: string} : {};
    response.status(status).json({error: {code: details.code ?? ({400:'VALIDATION_ERROR',401:'UNAUTHENTICATED',402:'SUBSCRIPTION_REQUIRED',403:'FORBIDDEN',404:'NOT_FOUND',409:'CONFLICT',429:'RATE_LIMITED',503:'UNAVAILABLE'} as Record<number,string>)[status] ?? 'INTERNAL_ERROR', message, feature: details.feature, route: details.route, requestId: request.id}});
  }
}
