import { schema, required, date, scope } from '../../database/schema';
export const invitationsSchemas = {
  invitations: schema({...scope, studentId: String, familyId:String, audience:{type:String,enum:['student','parent'],default:'student'}, tokenHash: {...required, select: false}, expiresAt: {type:Date,default:null}, revokedAt: Date, redeemedAt: Date, lastUsedAt: Date, useCount:{type:Number,default:0,min:0}}),
  portalAccounts: schema({...scope, role:{type:String,required:true,enum:['student','parent']},familyId:String,studentId:String,status:{type:String,enum:['active','revoked'],default:'active'},notificationVersion:{type:Number,default:0,min:0}}),
  portalSessions: schema({accountId:required,accessHash:required,refreshHash:required,accessExpiresAt:date,expiresAt:date}),
};
invitationsSchemas.invitations.index({tokenHash: 1}, {unique: true});
invitationsSchemas.invitations.index({workspaceId:1,createdAt:-1});
invitationsSchemas.invitations.index({workspaceId:1,familyId:1,audience:1});
invitationsSchemas.invitations.index({workspaceId:1,studentId:1,audience:1,createdAt:-1,_id:-1});
invitationsSchemas.portalAccounts.index({workspaceId:1,role:1,familyId:1},{unique:true,partialFilterExpression:{familyId:{$type:'string'}}});
invitationsSchemas.portalAccounts.index({workspaceId:1,role:1,studentId:1},{unique:true,partialFilterExpression:{studentId:{$type:'string'}}});
invitationsSchemas.portalSessions.index({accessHash:1},{unique:true});
invitationsSchemas.portalSessions.index({refreshHash:1},{unique:true});
invitationsSchemas.portalSessions.index({expiresAt:1},{expireAfterSeconds:0});
