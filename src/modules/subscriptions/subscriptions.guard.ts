import { CanActivate, ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AuthRequest } from '../../common/api';
import type { ProFeature } from './catalog';
import { SubscriptionsService } from './subscriptions.service';
export const RequireFeature = (feature: ProFeature) => SetMetadata('subscriptionFeature', feature);
@Injectable()
export class SubscriptionGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly subscriptions: SubscriptionsService) {}
  async canActivate(context: ExecutionContext) {
    if (this.reflector.getAllAndOverride('public', [context.getHandler(), context.getClass()])) return true;
    const req = context.switchToHttp().getRequest<AuthRequest>();
    if (!req.user) return true; // Authentication runs first.
    const feature = this.reflector.getAllAndOverride<ProFeature>('subscriptionFeature', [context.getHandler(), context.getClass()]);
    if (feature) { await this.subscriptions.requireFeature(req.user.workspaceId, feature); return true; }
    const path = req.path.replace(/^\/api\/v1/, '');
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || /^\/(auth|subscriptions|notifications)(\/|$)/.test(path)) return true;
    // Expired Pro users may reduce active-student usage before choosing Basic.
    // Only the reversible archive action is allowed, never arbitrary edits.
    if(req.method === 'PATCH' && /^\/students\/[0-9a-f-]+$/i.test(path) && req.body && Object.keys(req.body).length === 1 && req.body.status === 'archived') return true;
    await this.subscriptions.requireActive(req.user.workspaceId);
    return true;
  }
}
