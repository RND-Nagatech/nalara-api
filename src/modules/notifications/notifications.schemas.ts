import { schema, required, scope } from '../../database/schema';
export const notificationsSchemas = {
  notifications: schema({...scope, recipientAccountId:String, title: required, body: required, route: required, readAt: Date, eventKey: required, deliveryStatus:{type:String,enum:['pending','delivering','delivered','suppressed','failed'],default:'pending'},deliveryAttempts:{type:Number,default:0,min:0},lastDeliveryError:String,deliveryClaimId:String,deliveryLeaseUntil:Date,deliveryNextAttemptAt:Date,deliveryExpiresAt:Date,deliveredDeviceKeys:{type:[String],default:[]},adapterDeliveredAt:Date}),
  notificationDevices: schema({...scope, accountId:required, accountType:{type:String,enum:['teacher','parent','student'],required:true}, token:required, platform:{type:String,enum:['android','ios','web'],required:true}, lastSeenAt:{type:Date,required:true}}),
};
notificationsSchemas.notifications.index({workspaceId: 1, eventKey: 1}, {unique: true});
notificationsSchemas.notifications.index({workspaceId:1,createdAt:-1});
notificationsSchemas.notifications.index({workspaceId:1,recipientAccountId:1,readAt:1,createdAt:-1});
notificationsSchemas.notifications.index({deliveryStatus:1,deliveryNextAttemptAt:1,_id:1});
notificationsSchemas.notifications.index({deliveryStatus:1,deliveryLeaseUntil:1});
notificationsSchemas.notificationDevices.index({token:1},{unique:true});
notificationsSchemas.notificationDevices.index({workspaceId:1,accountId:1});
