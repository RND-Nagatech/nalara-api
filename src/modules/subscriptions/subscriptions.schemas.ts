import { schema, required, date, scope } from '../../database/schema';
export const subscriptionSchemas = {
  subscriptions: schema({...scope, plan: {type: String, enum: ['trial', 'basic', 'pro'], default: 'trial'}, trialStartedAt: date, trialEndsAt: date, paidThrough: Date, usageVersion: {type: Number, default: 0}}),
  subscriptionOrders: schema({...scope, plan: {type: String, enum: ['basic', 'pro'], required: true}, amount: {type: Number, required: true, min: 1}, currency: {type: String, default: 'IDR'}, reference: required, status: {type: String, enum: ['creating', 'pending', 'paid', 'failed'], default: 'creating'}, open: {type: Boolean, default: true}, checkoutUrl: String, providerId: String, paidAt: Date, periodStart: Date, periodEnd: Date}),
  billingEvents: schema({eventHash: required, type: String, reference: String}),
};
subscriptionSchemas.subscriptions.index({workspaceId: 1}, {unique: true});
subscriptionSchemas.subscriptionOrders.index({reference: 1}, {unique: true});
subscriptionSchemas.subscriptionOrders.index({workspaceId: 1, open: 1}, {unique: true, partialFilterExpression: {open: true}});
subscriptionSchemas.subscriptionOrders.index({workspaceId: 1, createdAt: -1});
subscriptionSchemas.billingEvents.index({eventHash: 1}, {unique: true});
