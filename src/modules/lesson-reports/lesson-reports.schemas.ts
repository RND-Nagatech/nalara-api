import { schema, required, scope } from '../../database/schema';
export const reportsSchemas = {
  reports: schema({...scope, sessionId: required, studentId: required, topic: required, summary: required, targetIds: {type: [String], default: []}, observations: {type: String, default: ''}, difficulties: {type: String, default: ''}, homework: {type: String, default: ''}, recommendation: {type: String, default: ''}, visibility: {type: String, enum: ['teacher', 'student', 'shared'], default: 'teacher'}, status: {type: String, enum: ['draft', 'published'], default: 'draft'}, publishedAt: Date}),
};
reportsSchemas.reports.index({workspaceId: 1, sessionId: 1}, {unique: true});
reportsSchemas.reports.index({workspaceId:1,createdAt:-1});
