import { Injectable, NotFoundException } from '@nestjs/common';
import type { Principal } from '../../common/api';
import { Database } from '../../database/database.module';

@Injectable()
export class TeachingGuideService {
  constructor(private readonly db: Database) {}

  async get(actor: Principal) {
    const workspaceId = actor.workspaceId;
    // Milestones are inferred from stored records, never client-supplied flags.
    // Archived/cancelled records still show that an existing tutor has done setup.
    const [user, subject, student, schedule, target, parents] = await Promise.all([
      this.db.collection('users').findOne({_id: actor._id, workspaceId}).select('teachingGuideDismissed').lean(),
      this.db.collection('subjects').exists({workspaceId}),
      this.db.collection('students').exists({workspaceId}),
      this.db.collection('schedules').exists({workspaceId}),
      this.db.collection('targets').exists({workspaceId}),
      this.db.collection('portalAccounts').aggregate<{_id: string}>([
        {$match: {workspaceId, role: 'parent', status: 'active', familyId: {$type: 'string', $ne: ''}}},
        {$lookup: {
          from: this.db.collection('students').collection.name,
          let: {familyId: '$familyId', workspaceId: '$workspaceId'},
          pipeline: [
            {$match: {$expr: {$and: [
              {$eq: ['$workspaceId', '$$workspaceId']},
              {$eq: ['$familyId', '$$familyId']},
              {$eq: ['$status', 'active']},
            ]}}},
            {$limit: 1}, {$project: {_id: 1}},
          ],
          as: 'children',
        }},
        {$match: {'children.0': {$exists: true}}},
        {$limit: 1}, {$project: {_id: 1}},
      ]).option({maxTimeMS: 10000}),
    ]);
    if (!user) throw new NotFoundException('Akun Guru tidak ditemukan.');
    return {
      dismissed: user.teachingGuideDismissed === true,
      hasSubject: !!subject,
      hasStudent: !!student,
      hasSchedule: !!schedule,
      hasTarget: !!target,
      parentConnected: parents.length > 0,
    };
  }

  async preferences(actor: Principal, dismissed: boolean) {
    const user = await this.db.collection('users').findOneAndUpdate(
      {_id: actor._id, workspaceId: actor.workspaceId},
      {$set: {teachingGuideDismissed: dismissed}},
      {new: true, runValidators: true},
    ).select('teachingGuideDismissed').lean();
    if (!user) throw new NotFoundException('Akun Guru tidak ditemukan.');
    return {dismissed: user.teachingGuideDismissed === true};
  }
}
