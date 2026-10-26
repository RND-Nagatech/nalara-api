import { schema, required, scope } from '../../database/schema';
export const familiesSchemas = {
  families: schema({...scope, name: required, parentName: required, parentPhone: required, version: {type:Number, default:0}, invitationVersion:{type:Number,default:0}}),
};
familiesSchemas.families.add({ currentInvitationId: String });
familiesSchemas.families.index({workspaceId:1,parentPhone:1}, {unique:true});
familiesSchemas.families.index({workspaceId:1,createdAt:-1});
