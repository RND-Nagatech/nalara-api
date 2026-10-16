import { Injectable, NotFoundException } from '@nestjs/common';
import { ScopedService } from '../../common/scoped.service';
import type { Principal } from '../../common/api';
import { aggregateProgress } from '../learning-plans/progress.rules';
import { dashboardDayWindow, dashboardPreviewLimit } from './dashboard.rules';

@Injectable()
export class DashboardService {
  constructor(private readonly scope:ScopedService) {}
  async get(actor:Principal, now:Date = new Date()) {
    const {from,to,localDate}=dashboardDayWindow(now,actor.timezone);
    const workspaceId=actor.workspaceId, db=this.scope.db;
    const today={workspaceId,startAt:{$gte:from,$lt:to},status:{$ne:'cancelled' as const}};
    const [activeStudents,sessionsToday,todaySessions,unreadNotifications,plans,pending]=await Promise.all([
      db.collection('students').countDocuments({workspaceId,status:'active'}),
      db.collection('sessions').countDocuments(today),
      db.collection('sessions').find(today).sort({startAt:1,_id:1}).limit(dashboardPreviewLimit).lean(),
      db.collection('notifications').countDocuments({workspaceId,readAt:{$exists:false},$or:[{recipientAccountId:{$exists:false}},{recipientAccountId:actor._id}]}),
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
    const [students,subjects,targets]=await Promise.all([
      db.collection('students').find({workspaceId,_id:{$in:todaySessions.map(lesson=>lesson.studentId)}}).select('_id name grade').lean(),
      db.collection('subjects').find({workspaceId,_id:{$in:todaySessions.map(lesson=>lesson.subjectId)}}).select('_id name').lean(),
      db.collection('targets').find({workspaceId,planId:{$in:plans.map(plan=>plan._id)}}).lean(),
    ]);
    const studentMap=new Map(students.map(student=>[student._id,student]));
    const subjectMap=new Map(subjects.map(subject=>[subject._id,subject]));
    const enrichedSessions=todaySessions.map(lesson=>{
      const student=studentMap.get(lesson.studentId), subject=subjectMap.get(lesson.subjectId);
      if (!student || !subject) throw new NotFoundException('Data siswa atau bidang belajar pada jadwal tidak tersedia. Periksa kembali jadwal les.');
      return {...lesson,studentName:student.name,studentGrade:student.grade??'',subjectName:subject.name};
    });
    // Retain the existing plan contract for clients, using canonical aggregation.
    const learningPlans=plans.map(plan=>({...plan,...aggregateProgress(targets.filter(target=>target.planId===plan._id))}));
    return {teacher:actor,activeStudents,sessionsToday,pendingReports:pending[0]?.total??0,unreadNotifications,
      todaySessions:enrichedSessions,learningPlans,timezone:actor.timezone,
      generatedAt:now,dayStart:from,dayEnd:to,localDate,
    };
  }
}
