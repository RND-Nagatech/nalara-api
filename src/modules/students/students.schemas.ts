import { schema, required, scope } from '../../database/schema';
export const studentsSchemas = {
  students: schema({...scope, name: required, grade: {type: String, default: ''}, notes: {type: String, default: ''}, familyId:{type:String}, invitationVersion:{type:Number,default:0}, status: {type: String, enum: ['active', 'archived'], default: 'active'}}),
};
studentsSchemas.students.index({workspaceId:1,createdAt:-1});
studentsSchemas.students.index({workspaceId:1,familyId:1,status:1});
