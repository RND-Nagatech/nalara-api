import { schema, required, date, scope } from '../../database/schema';
export const schedulesSchemas = {
  schedules: schema({...scope, studentId: required, subjectId: required, startAt: date, endAt: date, timezone: required, recurrence: {type: String, enum: ['none', 'weekly'], default: 'none'}, repeatCount: {type: Number, default: 1}, status: {type: String, enum: ['scheduled', 'cancelled'], default: 'scheduled'}}),
  sessions: schema({...scope, scheduleId: required, studentId: required, subjectId: required, startAt: date, endAt: date, status: {type: String, enum: ['scheduled', 'completed', 'cancelled'], default: 'scheduled'}, attendance: {type: String, enum: ['pending', 'present', 'excused', 'absent', 'cancelled'], default: 'pending'}}),
};
schedulesSchemas.sessions.index({workspaceId: 1, scheduleId: 1, startAt: 1}, {unique: true});
schedulesSchemas.sessions.index({workspaceId: 1, startAt: 1});
schedulesSchemas.schedules.index({workspaceId:1,createdAt:-1});
// Separate child records retain existing portal/report ownership and unique indexes.
schedulesSchemas.schedules.add({groupId: String});
schedulesSchemas.schedules.add({repeatDays: {type: [Number], default: undefined}, repeatEnd: {type: String, enum: ['never','count','until']}, repeatUntil: String,
  generatedThrough: Date, generatedCount: Number, recurrenceComplete: Boolean, nextExpansionAt: Date, recurrenceError: String});
schedulesSchemas.schedules.index({status:1,recurrenceComplete:1,nextExpansionAt:1});
schedulesSchemas.sessions.add({groupId: String});
schedulesSchemas.schedules.add({cancellationReason:{type:String,trim:true,minlength:3,maxlength:500}});
schedulesSchemas.sessions.add({cancellationReason:{type:String,trim:true,minlength:3,maxlength:500}});
schedulesSchemas.schedules.index({workspaceId:1,groupId:1});
schedulesSchemas.sessions.index({workspaceId:1,groupId:1,startAt:1,endAt:1});
