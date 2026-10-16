import { Injectable } from '@nestjs/common';
import type { Principal } from '../../common/api';
import { ScopedService } from '../../common/scoped.service';
import { progressFromTotals } from '../learning-plans/progress.rules';
import { studentSummaryWindow } from './student-summary.rules';

interface StudentTotals {
  _id: string;
  sum: number;
  targetCount: number;
  subjectNames: (string | null)[];
}

@Injectable()
export class StudentListProgressService {
  constructor(private readonly scope: ScopedService) {}

  async enrich<T extends {_id: string}>(actor: Pick<Principal, 'workspaceId' | 'timezone'>, students: readonly T[], now = new Date()) {
    if (students.length === 0) return [];
    const {weekStart, weekEnd, weekStartDate, weekEndDate} = studentSummaryWindow(now, actor.timezone);
    const db = this.scope.db;
    const workspaceId = actor.workspaceId;
    // Enrich only the requested page with one aggregate. Target totals are
    // complete within each weekly plan, never truncated by target pagination.
    const totals = await db.collection('plans').aggregate<StudentTotals>([
      {$match: {workspaceId, studentId: {$in: students.map(student => student._id)}, startAt: {$lt: weekEnd}, endAt: {$gte: weekStart}}},
      {$lookup: {
        from: db.collection('targets').collection.name,
        let: {planId: '$_id', studentId: '$studentId'},
        pipeline: [
          {$match: {workspaceId, status: {$nin: ['archived', 'cancelled']}, $expr: {$and: [{$eq: ['$planId', '$$planId']}, {$eq: ['$studentId', '$$studentId']}]}}},
          {$group: {_id: null, targetCount: {$sum: 1}, sum: {$sum: {$cond: [{$eq: ['$status', 'completed']}, 100, '$progress']}}}},
        ],
        as: 'targets',
      }},
      {$lookup: {
        from: db.collection('subjects').collection.name,
        let: {subjectId: '$subjectId'},
        pipeline: [{$match: {workspaceId, $expr: {$eq: ['$_id', '$$subjectId']}}}, {$project: {name: 1}}],
        as: 'subject',
      }},
      {$group: {
        _id: '$studentId',
        targetCount: {$sum: {$ifNull: [{$arrayElemAt: ['$targets.targetCount', 0]}, 0]}},
        sum: {$sum: {$ifNull: [{$arrayElemAt: ['$targets.sum', 0]}, 0]}},
        subjectNames: {$addToSet: {$arrayElemAt: ['$subject.name', 0]}},
      }},
    ]).readConcern('snapshot').option({maxTimeMS: 10000});
    const byStudent = new Map(totals.map(value => [value._id, value]));
    return students.map(student => {
      const value = byStudent.get(student._id);
      const targetCount = value?.targetCount ?? 0;
      return {...student, learningSummary: {
        subjectNames: (value?.subjectNames ?? []).filter((name): name is string => typeof name === 'string' && name.length > 0).sort((a, b) => a.localeCompare(b, 'id')),
        weeklyProgress: progressFromTotals(value?.sum ?? 0, targetCount),
        targetCount,
        weekStartDate,
        weekEndDate,
        timezone: actor.timezone,
      }};
    });
  }
}
