import { Injectable } from '@nestjs/common';
import type { ClientSession } from 'mongoose';
import { Database } from '../../database/database.module';
import { NotificationDelivery } from './delivery.service';

export interface NotificationEventInput {
  workspaceId: string;
  recipientAccountId?: string;
  title: string;
  body: string;
  route: string;
  eventKey: string;
}

@Injectable()
export class NotificationEventsService {
  constructor(
    private readonly db: Database,
    private readonly delivery: NotificationDelivery,
  ) {}

  async create(
    events: readonly NotificationEventInput[],
    session?: ClientSession,
  ): Promise<string[]> {
    const ids: string[] = [];
    for (const event of events) {
      const notification = await this.db.collection('notifications').findOneAndUpdate(
        { workspaceId: event.workspaceId, eventKey: event.eventKey },
        { $setOnInsert: event },
        {
          upsert: true,
          returnDocument: 'after',
          session,
          setDefaultsOnInsert: true,
        },
      ).lean();
      if (notification) ids.push(notification._id);
    }
    return ids;
  }

  async deliverAfterCommit(ids: readonly string[]) {
    await Promise.all(ids.map((id) => this.delivery.deliver(id)));
  }

  async teacherIds(workspaceId: string, session?: ClientSession) {
    const teachers = await this.db.collection('users')
      .find({ workspaceId, role: 'teacher' })
      .select('_id')
      .session(session ?? null)
      .lean();
    return teachers.map((teacher) => teacher._id);
  }

  async studentRecipients(
    workspaceId: string,
    studentId: string,
    session?: ClientSession,
  ) {
    const student = await this.db.collection('students')
      .findOne({ _id: studentId, workspaceId })
      .select('familyId')
      .session(session ?? null)
      .lean();
    if (!student) return { parentIds: [] as string[], studentIds: [] as string[] };

    const [parents, students] = await Promise.all([
      student.familyId
        ? this.db.collection('portalAccounts').find({
            workspaceId,
            role: 'parent',
            familyId: student.familyId,
            status: 'active',
          }).select('_id').session(session ?? null).lean()
        : [],
      this.db.collection('portalAccounts').find({
        workspaceId,
        role: 'student',
        studentId,
        status: 'active',
      }).select('_id').session(session ?? null).lean(),
    ]);
    return {
      parentIds: parents.map((parent) => parent._id),
      studentIds: students.map((studentAccount) => studentAccount._id),
    };
  }
}
