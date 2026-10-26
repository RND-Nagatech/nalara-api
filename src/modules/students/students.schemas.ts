import { schema, required, scope } from '../../database/schema';
import { avatarOptions } from '../avatars/avatar-catalog';
export const studentsSchemas = {
  students: schema({...scope, name: required, grade: {type: String, default: ''}, notes: {type: String, default: ''}, familyId:{type:String}, invitationVersion:{type:Number,default:0}, status: {type: String, enum: ['active', 'archived'], default: 'active'}}),
};
studentsSchemas.students.add({ avatarId: { type: String, enum: [...avatarOptions('student').map(entry => entry.avatarId), null], default: null } });
studentsSchemas.students.add({ currentInvitationId: String });
studentsSchemas.students.index({workspaceId:1,createdAt:-1});
studentsSchemas.students.index({workspaceId:1,familyId:1,status:1});
