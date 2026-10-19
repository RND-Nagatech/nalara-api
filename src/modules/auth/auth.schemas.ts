import { schema, required, date } from '../../database/schema';
export const authSchemas = {
  users: schema({name: required, email: {...required, lowercase: true}, phone: {type: String, match: /^\+628[1-9]\d{7,10}$/}, passwordHash: {...required, select: false}, firebaseUid: {type: String}, role: {type: String, enum: ['teacher'], default: 'teacher'}, workspaceId: required, timezone: {type: String, default: 'Asia/Jakarta'}, teachingGuideDismissed: {type: Boolean, default: false}, deletionRequestedAt: Date, authVersion: {type: Number, default: 0}}),
  workspaces: schema({name: required, ownerId: required, scheduleVersion: {type: Number, default: 0}, deletionRequestedAt: Date}),
  authSessions: schema({userId: required, accessHash: required, refreshHash: required, accessExpiresAt: date, expiresAt: date}),
};
authSchemas.users.index({email: 1}, {unique: true});
authSchemas.users.index({firebaseUid: 1}, {unique: true, sparse: true});
authSchemas.users.index({phone: 1}, {unique: true, partialFilterExpression: {phone: {$type: 'string'}}});
authSchemas.authSessions.index({accessHash: 1}, {unique: true});
authSchemas.authSessions.index({refreshHash: 1}, {unique: true});
authSchemas.authSessions.index({expiresAt: 1}, {expireAfterSeconds: 0});
