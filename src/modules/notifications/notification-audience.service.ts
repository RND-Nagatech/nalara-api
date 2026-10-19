import { Injectable } from '@nestjs/common';
import { Database } from '../../database/database.module';
import type { Notification, PortalAccount } from '../../database/entities';

export interface NotificationAudience {
  accountType: 'teacher' | 'parent' | 'student';
  accountIds: string[];
}

@Injectable()
export class NotificationAudienceService {
  constructor(private readonly db: Database) {}

  // Resolve current authorization, not just the recipient saved when the event
  // was created. Unknown portal event types fail closed, including legacy rows.
  async resolve(notification: Notification): Promise<NotificationAudience | null> {
    const {workspaceId, recipientAccountId, route} = notification;
    if (notification.deliveryExpiresAt && notification.deliveryExpiresAt <= new Date()) return null;
    const [kind, resourceId, deadline] = notification.eventKey.split(':');
    if (kind === 'subscription-expiring') {
      const subscription = await this.db.collection('subscriptions').findOne({_id:resourceId,workspaceId}).lean();
      const endsAt = subscription?.plan === 'trial' ? subscription.trialEndsAt : subscription?.paidThrough;
      if (!endsAt || endsAt.getTime() !== Number(deadline) || endsAt <= new Date()) return null;
    }
    if (kind === 'target-due' && !await this.db.collection('targets').exists({_id: resourceId, workspaceId, status: 'active', progress: {$lt: 100}})) return null;
    if (kind === 'lesson-reminder' && !await this.db.collection('sessions').exists({_id: resourceId, workspaceId, status: 'scheduled'})) return null;
    if (route.startsWith('/teacher/')) {
      const teachers = await this.db.collection('users').find({workspaceId, role: 'teacher', deletionRequestedAt: {$exists: false}, ...(recipientAccountId ? {_id: recipientAccountId} : {})}).select('_id').lean();
      return teachers.length ? {accountType: 'teacher', accountIds: teachers.map(row => row._id)} : null;
    }
    if (!recipientAccountId) return null;
    const account = await this.db.collection('portalAccounts').findOne({_id: recipientAccountId, workspaceId, status: 'active'}).lean();
    if (!account || !route.startsWith(`/${account.role}/`)) return null;
    const studentId = await this.resourceStudent(notification, account);
    if (!studentId) return null;
    const student = await this.db.collection('students').findOne({
      _id: studentId, workspaceId, status: 'active',
      ...(account.role === 'parent' ? {familyId: account.familyId} : {}),
    }).select('_id').lean();
    if (!student || (account.role === 'student' && studentId !== account.studentId)) return null;
    if (account.role === 'parent' && (!account.familyId || !await this.db.collection('families').exists({_id: account.familyId, workspaceId}))) return null;
    return {accountType: account.role, accountIds: [account._id]};
  }

  private async resourceStudent(notification: Notification, account: PortalAccount): Promise<string | null> {
    const [kind, id] = notification.eventKey.split(':');
    if (!id) return null;
    const filter = {_id: id, workspaceId: notification.workspaceId};
    const visibility = account.role === 'parent' ? ['shared'] as const : ['student', 'shared'] as const;
    switch (kind) {
      case 'attendance':
      case 'lesson-reminder': {
        const row = await this.db.collection('sessions').findOne({...filter, ...(kind === 'lesson-reminder' ? {status: 'scheduled' as const} : {})}).select('studentId').lean();
        return row?.studentId ?? null;
      }
      case 'target-created':
      case 'target-due': {
        const row = await this.db.collection('targets').findOne({...filter, ...(kind === 'target-due' ? {status: 'active' as const, progress: {$lt: 100}} : {})}).select('studentId').lean();
        return row?.studentId ?? null;
      }
      case 'progress': {
        const row = await this.db.collection('histories').findOne({...filter, visibility: {$in: visibility}}).select('studentId').lean();
        return row?.studentId ?? null;
      }
      case 'report': {
        const row = await this.db.collection('reports').findOne({...filter, status: 'published', visibility: {$in: visibility}}).select('studentId').lean();
        return row?.studentId ?? null;
      }
      case 'assignment': {
        const row = await this.db.collection('assignments').findOne({...filter, status: 'published', visibility: {$in: visibility}}).select('studentId').lean();
        return row?.studentId ?? null;
      }
      case 'reschedule-proposal':
      case 'reschedule-review':
      case 'reschedule-parent-response': {
        if (account.role !== 'parent' || !account.familyId) return null;
        const row = await this.db.collection('rescheduleRequests').findOne({...filter, familyId: account.familyId, parentAccountId: account._id}).select('studentId').lean();
        return row?.studentId ?? null;
      }
      default: return null;
    }
  }
}
