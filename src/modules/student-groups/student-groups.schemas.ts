import { required, schema, scope } from '../../database/schema';

export const studentGroupsSchemas = {
  studentGroups: schema({...scope, name: {...required, minlength: 2, maxlength: 100},
    studentIds: {type: [String], required: true, validate: (ids: string[]) => ids.length >= 1 && ids.length <= 100 && new Set(ids).size === ids.length},
    version: {type: Number, default: 0, min: 0}}),
};
studentGroupsSchemas.studentGroups.index({workspaceId: 1, createdAt: -1, _id: -1});
