import { schema, required, scope } from '../../database/schema';

export const parentPortalSchemas = {
  rescheduleRequests: schema({
    ...scope,
    sessionId: required,
    familyId: required,
    parentAccountId: required,
    studentId: required,
    oldStartAt: { type: Date, required: true },
    oldEndAt: { type: Date, required: true },
    requestedStartAt: { type: Date, required: true },
    requestedEndAt: { type: Date, required: true },
    proposedStartAt: Date,
    proposedEndAt: Date,
    reason: { type: String, required: true, maxlength: 500 },
    status: { type: String, enum: ['pending', 'approved', 'rejected', 'cancelled', 'expired'], default: 'pending' },
    reviewedBy: String,
    reviewedAt: Date,
    reviewNote: String,
  }),
};

parentPortalSchemas.rescheduleRequests.index({ workspaceId: 1, status: 1, createdAt: -1 });
parentPortalSchemas.rescheduleRequests.index({ workspaceId: 1, sessionId: 1, status: 1 });
parentPortalSchemas.rescheduleRequests.index({ workspaceId: 1, sessionId: 1 }, { unique: true, partialFilterExpression: { status: 'pending' }, name: 'one_pending_reschedule_per_session' });
parentPortalSchemas.rescheduleRequests.index({ workspaceId: 1, parentAccountId: 1, createdAt: -1 });
