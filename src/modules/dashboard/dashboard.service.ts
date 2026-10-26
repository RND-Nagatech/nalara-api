import { Injectable, NotFoundException } from '@nestjs/common';
import { ScopedService } from '../../common/scoped.service';
import type { Principal } from '../../common/api';
import { aggregateProgress } from '../learning-plans/progress.rules';
import { dashboardDayWindow, dashboardPreviewLimit } from './dashboard.rules';
import { groupPipeline, namedGroups } from '../schedules/schedule-groups';
import type { LessonSession } from '../../database/entities';
import { teacherNotificationScope } from '../notifications/teacher-notification-scope';

@Injectable()
export class DashboardService {
  constructor(private readonly scope:ScopedService) {}
  async get(actor:Principal, now:Date = new Date()) {
    const {from,to,localDate}=dashboardDayWindow(now,actor.timezone);
    const workspaceId=actor.workspaceId, db=this.scope.db;
    const today={workspaceId,startAt:{$gte:from,$lt:to},status:{$ne:'cancelled' as const}};
    const [activeStudents,dailyGroups,unreadNotifications,plans,pending]=await Promise.all([
      db.collection('students').countDocuments({workspaceId,status:'active'}),
      db.collection('sessions').aggregate<{items:{row:LessonSession;members:LessonSession[]}[];total:{count:number}[]}>([
        ...groupPipeline(today,true),{$facet:{items:[{$limit:dashboardPreviewLimit}],total:[{$count:'count'}]}},
      ]).option({maxTimeMS:10000}),
      teacherNotificationScope(db,actor).then(filter => db.collection('notifications').countDocuments({workspaceId,readAt:{$exists:false},...filter})),
      db.collection('plans').find({workspaceId,startAt:{$lt:to},endAt:{$gte:from}}).sort({createdAt:-1}).limit(10).lean(),
      db.collection('sessions').aggregate<{total:number}>([
        {$match:{workspaceId,status:{$ne:'cancelled'},endAt:{$lte:now}}},
        {$lookup:{from:db.collection('reports').collection.name,let:{sessionId:'$_id',workspaceId:'$workspaceId'},pipeline:[
          {$match:{$expr:{$and:[{$eq:['$sessionId','$$sessionId']},{$eq:['$workspaceId','$$workspaceId']},{$eq:['$status','published']}]}}},
          {$limit:1},{$project:{_id:1}},
        ],as:'publishedReport'}},
        {$match:{'publishedReport.0':{$exists:false}}},{$count:'total'},
      ]).option({maxTimeMS:10000}),
    ]);
    const enrichedSessions=await namedGroups(this.scope,workspaceId,dailyGroups[0]?.items??[]);
    if(enrichedSessions.some(lesson=>!lesson.subjectName || lesson.participants.some(student=>!student.studentName))) throw new NotFoundException('Data siswa atau bidang belajar pada jadwal tidak tersedia. Periksa kembali jadwal les.');
    const sessionsToday=dailyGroups[0]?.total[0]?.count??0;
    const targets=await db.collection('targets').find({workspaceId,planId:{$in:plans.map(plan=>plan._id)}}).lean();
    // Retain the existing plan contract for clients, using canonical aggregation.
    const learningPlans=plans.map(plan=>({...plan,...aggregateProgress(targets.filter(target=>target.planId===plan._id))}));
    return {teacher:actor,activeStudents,sessionsToday,pendingReports:pending[0]?.total??0,unreadNotifications,
      todaySessions:enrichedSessions,learningPlans,timezone:actor.timezone,
      generatedAt:now,dayStart:from,dayEnd:to,localDate,
    };
  }
}
