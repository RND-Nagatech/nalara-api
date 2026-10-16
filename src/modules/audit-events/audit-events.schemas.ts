import { schema, required, scope } from '../../database/schema';
export const auditSchemas = {
  audits: schema({...scope, actorId: required, action: required, resourceId: required}),
};
auditSchemas.audits.index({workspaceId:1,createdAt:-1});
