import { schema, required, date, scope } from '../../database/schema';
export const subscriptionSchemas = {
  subscriptions: schema({...scope, plan: {type: String, enum: ['trial', 'basic', 'pro'], default: 'trial'}, trialStartedAt: date, trialEndsAt: date, paidThrough: Date, usageVersion: {type: Number, default: 0}, deletionRequestedAt: Date}),
  subscriptionOrders: schema({...scope, plan: {type: String, enum: ['basic', 'pro'], required: true}, amount: {type: Number, required: true, min: 1}, currency: {type: String, default: 'IDR'}, reference: required, status: {type: String, enum: ['creating', 'pending', 'paid', 'failed', 'cancelled'], default: 'creating'}, open: {type: Boolean, default: true}, checkoutUrl: String, providerId: String, creationLeaseUntil: Date, creationFinishedAt: Date, creationErrorCode: String, creationErrorStatus: Number, cancelledAt: Date, paidAt: Date, periodStart: Date, periodEnd: Date, reconcileClaimId:String, reconcileLeaseUntil:Date, reconcileNextAttemptAt:Date, reconcileAttempts:{type:Number,default:0,min:0}, lastReconciledAt:Date, lastReconcileError:String}),
  billingEvents: schema({eventHash: required, type: String, reference: String}),
};
subscriptionSchemas.subscriptions.index({workspaceId: 1}, {unique: true});
subscriptionSchemas.subscriptionOrders.index({reference: 1}, {unique: true});
subscriptionSchemas.subscriptionOrders.index({workspaceId: 1, open: 1}, {unique: true, partialFilterExpression: {open: true}});
subscriptionSchemas.subscriptionOrders.index({workspaceId: 1, createdAt: -1});
subscriptionSchemas.subscriptionOrders.index({open:1,status:1,reconcileNextAttemptAt:1,_id:1});
subscriptionSchemas.billingEvents.index({eventHash: 1}, {unique: true});
