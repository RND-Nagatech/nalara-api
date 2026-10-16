import { schema, required, date, scope } from '../../database/schema';
export const schedulesSchemas = {
  schedules: schema({...scope, studentId: required, subjectId: required, startAt: date, endAt: date, timezone: required, recurrence: {type: String, enum: ['none', 'weekly'], default: 'none'}, repeatCount: {type: Number, default: 1}, status: {type: String, enum: ['scheduled', 'cancelled'], default: 'scheduled'}}),
  sessions: schema({...scope, scheduleId: required, studentId: required, subjectId: required, startAt: date, endAt: date, status: {type: String, enum: ['scheduled', 'completed', 'cancelled'], default: 'scheduled'}, attendance: {type: String, enum: ['pending', 'present', 'excused', 'absent', 'cancelled'], default: 'pending'}}),
};
schedulesSchemas.sessions.index({workspaceId: 1, scheduleId: 1, startAt: 1}, {unique: true});
schedulesSchemas.sessions.index({workspaceId: 1, startAt: 1});
schedulesSchemas.schedules.index({workspaceId:1,createdAt:-1});
