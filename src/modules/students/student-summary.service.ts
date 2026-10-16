import { Injectable, NotFoundException } from '@nestjs/common';
import type { PipelineStage } from 'mongoose';
import type { Principal } from '../../common/api';
import { ScopedService } from '../../common/scoped.service';
import { progressFromTotals } from '../learning-plans/progress.rules';
import { studentSummaryWindow } from './student-summary.rules';

interface Totals {total:number;sum:number;completed:number;historyCount:number;}
type SummaryFacets = Record<string,Totals[]>;

@Injectable()
export class StudentSummaryService {
  constructor(private readonly scope:ScopedService) {}
  // Callers authorize the role/family; this shared read only needs server scope.
  async get(actor:Pick<Principal,'workspaceId'|'timezone'>,id:string,now:Date=new Date()) {
    if(!await this.scope.db.collection('students').exists({_id:id,workspaceId:actor.workspaceId})) throw new NotFoundException('Data tidak ditemukan');
    const {weekStart,weekEnd,weekStartDate,weekEndDate,days}=studentSummaryWindow(now,actor.timezone);
    const db=this.scope.db,workspaceId=actor.workspaceId;
    const historyMatch={workspaceId,studentId:id,$expr:{$eq:['$targetId','$$targetId']}};
    const group={_id:null,total:{$sum:1},sum:{$sum:'$currentProgress'},completed:{$sum:{$cond:[{$eq:['$currentProgress',100]},1,0]}},historyCount:{$sum:{$cond:[{$gt:[{$size:'$firstHistory'},0]},1,0]}}};
    const facets:PipelineStage.Facet['$facet']={
      overall:[{$group:group}],
      weekly:[{$match:{'plan.startAt':{$lt:weekEnd},'plan.endAt':{$gte:weekStart}}},{$group:group}],
    };
    for(const [index,day] of days.entries()) {
      // Today's point uses the same snapshot as the headline, including an
      // update committed while this request was entering the aggregate.
      if(index===days.length-1) {
        facets[`day${index}`]=[{$group:{_id:null,total:{$sum:1},sum:{$sum:'$currentProgress'}}}];
        continue;
      }
      facets[`day${index}`]=[
        {$match:{createdAt:{$lte:day.at}}},
        {$lookup:{from:db.collection('histories').collection.name,let:{targetId:'$_id'},pipeline:[
          {$match:{...historyMatch,createdAt:{$lte:day.at}}},{$sort:{createdAt:-1,_id:-1}},{$limit:1},{$project:{after:1}},
        ],as:'latest'}},
        {$project:{value:{$ifNull:[{$arrayElemAt:['$latest.after',0]},{$ifNull:[{$arrayElemAt:['$firstHistory.before',0]},'$currentProgress']}]}}},
        {$group:{_id:null,total:{$sum:1},sum:{$sum:'$value'}}},
      ];
    }
    // Single aggregate snapshot, scoped before every join. Each lookup returns
    // at most one history record; neither a list page nor all history is loaded.
    const [result]=await db.collection('targets').aggregate<SummaryFacets>([
      {$match:{workspaceId,studentId:id,status:{$nin:['archived','cancelled']}}},
      {$addFields:{currentProgress:{$cond:[{$eq:['$status','completed']},100,'$progress']}}},
      {$lookup:{from:db.collection('histories').collection.name,let:{targetId:'$_id'},pipeline:[
        {$match:{...historyMatch,createdAt:{$lte:now}}},{$sort:{createdAt:1,_id:1}},{$limit:1},{$project:{before:1}},
      ],as:'firstHistory'}},
      {$lookup:{from:db.collection('plans').collection.name,let:{planId:'$planId'},pipeline:[
        {$match:{workspaceId,studentId:id,$expr:{$eq:['$_id','$$planId']}}},{$project:{startAt:1,endAt:1}},
      ],as:'plan'}},
      {$facet:facets},
    ]).readConcern('snapshot').option({maxTimeMS:10000});
    const overall=result?.overall[0],weekly=result?.weekly[0];
    const total=overall?.total??0,weeklyTotal=weekly?.total??0,completed=weekly?.completed??0;
    // A graph is never invented for a student without an actual progress audit.
    const trend=(overall?.historyCount??0)>0 ? days.flatMap((day,index)=>{
      const point=result?.[`day${index}`][0];
      return point?.total ? [{...day,progress:progressFromTotals(point.sum,point.total),targetCount:point.total}] : [];
    }) : [];
    return {studentId:id,generatedAt:now,timezone:actor.timezone,
      overall:{progress:progressFromTotals(overall?.sum??0,total),targetCount:total},
      weekly:{from:weekStart,to:weekEnd,startDate:weekStartDate,endDate:weekEndDate,targetCount:weeklyTotal,completedCount:completed,completionProgress:progressFromTotals(completed*100,weeklyTotal)},
      trend,trendScope:'currently_eligible_targets',
    };
  }
}
