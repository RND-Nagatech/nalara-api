import { schema, required, date, scope } from '../../database/schema';
export const learningSchemas = {
  plans: schema({...scope, studentId: required, subjectId: required, title: required, startAt: date, endAt: date}),
  targets: schema({...scope, planId: required, studentId: required, subjectId: required, title: required, description: {type: String, default: ''}, successCriteria: {type: String, default: ''}, priority: {type: String, enum: ['low', 'normal', 'high'], default: 'normal'}, status: {type: String, enum: ['active', 'completed', 'archived', 'cancelled'], default: 'active'}, progress: {type: Number, min: 0, max: 100, default: 0}, version: {type: Number, default: 0}}),
  histories: schema({...scope, targetId: required, planId: required, studentId: required, before: {type: Number, required: true}, after: {type: Number, required: true}, note: {type: String, default: ''}, actorId: required, sessionId: String, visibility: {type: String, enum: ['teacher', 'student', 'shared'], default: 'teacher'}}),
};
learningSchemas.targets.index({workspaceId: 1, planId: 1, status: 1});
learningSchemas.targets.index({workspaceId: 1, studentId: 1, status: 1});
learningSchemas.histories.index({workspaceId: 1, targetId: 1, createdAt: -1});
learningSchemas.plans.index({workspaceId:1,createdAt:-1});
