import type { Database } from '../../database/database.module';
import type { Principal } from '../../common/api';

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Filter before pagination/counting, so settled/revised fees cannot leave phantom
// inbox rows or Home unread badges. Reading a reminder never changes the fee.
export async function teacherNotificationScope(db: Database, actor: Principal) {
  const fees = await db.collection('tuitionFees').find({workspaceId:actor.workspaceId,status:'unpaid'}).select('_id studentId version').lean();
  const students = fees.length ? await db.collection('students').find({workspaceId:actor.workspaceId,status:'active',_id:{$in:fees.map(fee => fee.studentId)}}).select('_id').lean() : [];
  const active = new Set(students.map(student => student._id));
  return {$and:[
    {$or:[{recipientAccountId:{$exists:false}},{recipientAccountId:actor._id}]},
    {$or:[{eventKey:{$regex:'^(?!tuition-check:)'}}, ...fees.filter(fee => active.has(fee.studentId)).map(fee => ({
      eventKey:{$regex:`^tuition-check:${escapeRegex(fee._id)}:\\d{4}-\\d{2}-\\d{2}:teacher:${escapeRegex(actor._id)}$`},
      tuitionFeeVersion:fee.version, route:`/teacher/students/${fee.studentId}?tab=tuition`,
    }))]},
  ]};
}
