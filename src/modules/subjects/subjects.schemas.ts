import { schema, required, scope } from '../../database/schema';
export const subjectsSchemas = {
  subjects: schema({...scope, name: required}),
};
subjectsSchemas.subjects.index({workspaceId: 1, name: 1}, {unique: true});
