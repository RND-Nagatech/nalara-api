import { schema, required, scope } from '../../database/schema';
export const tutorToolsSchemas = {
  assignments: schema({...scope, studentId: required, subjectId: required, kind: {type: String, enum: ['task', 'material'], required: true}, title: required, content: required, dueAt: Date, status: {type: String, enum: ['draft', 'published', 'archived'], default: 'draft'}, visibility: {type: String, enum: ['student', 'shared'], default: 'shared'}}),
  submissions: schema({...scope, assignmentId: required, studentId: required, text: required, feedback: {type: String, default: ''}, reviewedAt: Date, version: {type: Number, default: 0}}),
  reportTemplates: schema({...scope, name: required, topic: String, summary: String, observations: String, difficulties: String, homework: String, recommendation: String}),
  tutorPreferences: schema({...scope, displayName: {type: String, default: ''}, tagline: {type: String, default: ''}, footer: {type: String, default: ''}, accentColor: {type: String, default: '#155D49'}, logoKey: String, reminders: {type: Boolean, default: true}, progress: {type: Boolean, default: true}, reports: {type: Boolean, default: true}, assignments: {type: Boolean, default: true}, tuitionTeacherReminders: {type: Boolean, default: true}, tuitionParentReminders: {type: Boolean, default: true}}),
};
tutorToolsSchemas.assignments.index({workspaceId: 1, studentId: 1, status: 1, createdAt: -1});
tutorToolsSchemas.submissions.index({workspaceId: 1, assignmentId: 1, studentId: 1}, {unique: true});
tutorToolsSchemas.reportTemplates.index({workspaceId: 1, createdAt: -1});
tutorToolsSchemas.tutorPreferences.index({workspaceId: 1}, {unique: true});
