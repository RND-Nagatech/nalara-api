// Source-only contracts with a deterministic fake. No app, Mongo, Redis or FCM.
const {test, beforeEach, afterEach, mock} = require('node:test');
const assert = require('node:assert/strict');
const {randomUUID} = require('node:crypto');
require('reflect-metadata');
const {ValidationPipe} = require('@nestjs/common');
const {source} = require('./helpers/source.cjs');
const {memoryDb, matches} = require('./helpers/memory-db.cjs');
const groups = source('modules/schedules/schedule-groups.ts');
const dto = source('modules/schedules/schedules.dto.ts');
const {ScopedService} = source('common/scoped.service.ts', {'../database/database.module': {Database:class {}}});
const calendar = source('common/calendar-lock.ts');
const progress=source('modules/learning-plans/progress.rules.ts');
const dashboardRules=source('modules/dashboard/dashboard.rules.ts');
const {ParentPortalService}=source('modules/parent-portal/parent-portal.service.ts',{
  '../../database/database.module':{Database:class {}},
  '../subscriptions/subscriptions.service':{SubscriptionsService:class {}},
  '../students/student-summary.service':{StudentSummaryService:class {}},
  '../students/student-list-progress.service':{StudentListProgressService:class {}},
  '../students/student-summary.rules':source('modules/students/student-summary.rules.ts'),
  '../learning-plans/progress.rules':progress,'../dashboard/dashboard.rules':dashboardRules,
  './parent-portal.views':source('modules/parent-portal/parent-portal.views.ts'),
  '../notifications/notification-events.service':{NotificationEventsService:class {}},
  '../../common/calendar-lock':calendar,
});
const {StudentPortalService}=source('modules/student-portal/student-portal.service.ts',{
  '../../database/database.module':{Database:class {}},
  '../learning-plans/progress.rules':progress,'../dashboard/dashboard.rules':dashboardRules,
});
const {ReportsService}=source('modules/lesson-reports/reports.service.ts',{
  '../../common/scoped.service':{ScopedService},
  '../../common/calendar-lock':calendar,
  '../notifications/notification-events.service':{NotificationEventsService:class {}},
  '../schedules/schedule-groups':groups,
});
const {DashboardService}=source('modules/dashboard/dashboard.service.ts',{
  '../notifications/teacher-notification-scope':source('modules/notifications/teacher-notification-scope.ts'),
  '../../common/scoped.service':{ScopedService},
  '../learning-plans/progress.rules':progress,'./dashboard.rules':dashboardRules,
  '../schedules/schedule-groups':groups,
});
const {SchedulesService} = source('modules/schedules/schedules.service.ts', {
  '../../common/scoped.service': {ScopedService},
  './schedules.dto': dto,
  '../notifications/notification-events.service': {NotificationEventsService:class {}},
  '../subscriptions/subscriptions.service': {SubscriptionsService:class {}},
  '../../common/calendar-lock': calendar,
  './schedule-groups': groups,
  './repeat-rules': source('modules/schedules/repeat-rules.ts'),
});
const actor = {_id:'teacher',workspaceId:'workspace',timezone:'Asia/Jakarta'};
const childA=randomUUID(), childB=randomUUID(), childC=randomUUID(), subjectId=randomUUID();
const draft = (extra={}) => ({studentIds:[childA,childB,childC],subjectId,startAt:'2026-10-21T00:00:00Z',endAt:'2026-10-21T03:00:00Z',timezone:'Asia/Jakarta',...extra});
// Attendance fixtures are in the past at a deterministic server instant.
beforeEach(()=>mock.timers.enable({apis:['Date'],now:Date.parse('2026-10-21T06:00:00Z')}));
afterEach(()=>mock.timers.reset());

function setup(extra={}) {
  const db=memoryDb({
    workspaces:[{_id:actor.workspaceId}],
    students:[childA,childB,childC].map((id,index)=>({_id:id,workspaceId:actor.workspaceId,name:`Siswa ${index+1}`,grade:'SD',status:'active'})),
    subjects:[{_id:subjectId,workspaceId:actor.workspaceId,name:'Piano'}],schedules:[],sessions:[],notifications:[],...extra,
  });
  const trace=[],pipelines=[],delivered=[],base=db.collection.bind(db);
  db.connection.transaction=async fn=>{
    const snapshot=structuredClone(db.data);
    try {const result=await fn({transaction:true}); trace.push('commit'); return result;}
    catch(error) {for(const key of Object.keys(db.data)) delete db.data[key]; Object.assign(db.data,snapshot); trace.push('rollback'); throw error;}
  };
  db.collection=name=>{
    const model=base(name);
    model.collection={name};
    model.countDocuments=async filter=>(db.data[name]??[]).filter(row=>matches(row,filter)).length;
    // Mongo compares BSON Date values; this project's small shared fake uses
    // JS identity for literal equality. Normalize only this test's Date reads.
    const find=model.find;
    model.find=filter=>find(Object.fromEntries(Object.entries(filter).map(([key,value])=>[key,value instanceof Date ? {$gte:value,$lte:value} : value])));
    const findOne=model.findOne;
    model.findOne=filter=>findOne(Object.fromEntries(Object.entries(filter).map(([key,value])=>[key,value instanceof Date ? {$gte:value,$lte:value} : value])));
    model.exists=filter=>({session:async()=>{trace.push('overlap'); return (db.data[name]??[]).some(row=>matches(row,filter));}});
    if(name==='workspaces') {
      const update=model.updateOne;
      model.updateOne=async(...args)=>{trace.push('lock'); return update(...args);};
    }
    if(name==='rescheduleRequests') {
      const create=model.create;
      model.create=(rows,options)=>create(rows.map(row=>({status:'pending',...row})),options);
    }
    if(name==='schedules' || name==='sessions') {
      const create=model.create;
      model.create=async(value,options)=>{
        if(value.length>1 && options?.session) assert.equal(options.ordered,true,'Mongoose requires ordered multi-document create in a transaction');
        return create(value.map(row=>({status:'scheduled',...(name==='sessions'?{attendance:'pending'}:{}),...row})));
      };
      model.aggregate=pipeline=>({option:async options=>{
        pipelines.push({pipeline,options});
        // Deliberately narrow interpreter for grouping/pagination contracts.
        const found=(db.data[name]??[]).filter(row=>matches(row,pipeline[0].$match)).sort((a,b)=>a._id.localeCompare(b._id));
        if(pipeline.some(stage=>stage.$lookup)) {
          return [{total:found.filter(row=>!(db.data.reports??[]).some(report=>report.workspaceId===row.workspaceId && report.sessionId===row._id && report.status==='published')).length}];
        }
        const byKey=new Map();
        for(const row of found) {
          const key=JSON.stringify([row.groupId??row._id,...(name==='sessions'?[row.startAt,row.endAt]:[])]);
          if(!byKey.has(key)) byKey.set(key,{row:structuredClone(row),members:[]});
          byKey.get(key).members.push(row);
        }
        let result=[...byKey.values()];
        for(const group of result) group.row.status=group.members.some(row=>row.status==='scheduled')?'scheduled':group.members.some(row=>row.status==='completed')?'completed':'cancelled';
        result.sort((a,b)=>name==='sessions' ? a.row.startAt-b.row.startAt || a.row._id.localeCompare(b.row._id) : 0);
        const status=pipeline.find(stage=>stage.$match?.['row.status'])?.$match['row.status'];
        if(status) result=result.filter(group=>group.row.status===status);
        const facet=pipeline.find(stage=>stage.$facet)?.$facet;
        if(!facet) return result;
        const skip=facet.items.find(stage=>stage.$skip!==undefined)?.$skip??0;
        const limit=facet.items.find(stage=>stage.$limit)?.$limit??result.length;
        return [{items:result.slice(skip,skip+limit),total:[{count:result.length}]}];
      }});
    }
    return model;
  };
  const scope=new ScopedService(db);
  scope.list=async(name,a,q,additional={})=>{
    const filter={workspaceId:a.workspaceId,...additional,...(q.studentId?{studentId:q.studentId}:{})};
    const items=(db.data[name]??[]).filter(row=>matches(row,filter));
    return {items:await scope.teachingNames(a,items),total:items.length,page:q.page,limit:q.limit};
  };
  const notifications={
    studentRecipients:async(_,studentId)=>({parentIds:[`parent-${studentId}`],studentIds:[]}),
    create:async(events)=>{db.data.notifications.push(...events); return events.map(row=>row.eventKey);},
    deliverAfterCommit:async ids=>{assert.equal(trace.at(-1),'commit'); delivered.push(...ids);},
  };
  const features=[];
  const service=new SchedulesService(scope,notifications,{requireFeature:async(...args)=>features.push(args)});
  return {db,scope,service,notifications,features,trace,pipelines,delivered};
}

test('cancellation DTOs require a trimmed public reason; other updates remain compatible',async()=>{
  const pipe=new ValidationPipe({transform:true,whitelist:true,forbidNonWhitelisted:true});
  for(const [metatype,field] of [[dto.UpdateSessionDto,'status'],[dto.UpdateScheduleDto,'status'],[dto.AttendanceDto,'attendance']]) {
    for(const cancellationReason of [undefined,null,'','   ','ab','x'.repeat(501),34]) {
      await assert.rejects(pipe.transform({[field]:'cancelled',...(cancellationReason===undefined?{}:{cancellationReason})},{type:'body',metatype}));
    }
    const value=await pipe.transform({[field]:'cancelled',cancellationReason:'  Guru sedang sakit.  '},{type:'body',metatype});
    assert.equal(value.cancellationReason,'Guru sedang sakit.');
  }
  await pipe.transform({startAt:'2030-01-01T00:00:00Z'},{type:'body',metatype:dto.UpdateSessionDto});
  await pipe.transform({attendance:'present'},{type:'body',metatype:dto.AttendanceDto});
  await assert.rejects(pipe.transform({entries:[{sessionId:childA,attendance:'cancelled'}]},{type:'body',metatype:dto.BatchAttendanceDto}));
});

test('missing reasons and reason-only edits cannot mutate or bypass cancellation through attendance',async()=>{
  const {service,db}=setup(); const schedule=await service.create(actor,draft());
  const id=db.data.sessions[0]._id,before=structuredClone(db.data);
  for(const action of [
    ()=>service.updateSession(actor,id,{status:'cancelled'}),
    ()=>service.update(actor,schedule._id,{status:'cancelled'}),
    ()=>service.attendance(actor,id,{attendance:'cancelled'}),
    ()=>service.updateSession(actor,id,{cancellationReason:'Guru sakit'}),
    ()=>service.update(actor,schedule._id,{cancellationReason:'Guru sakit'}),
    ()=>service.batchAttendance(actor,id,{entries:[{sessionId:id,attendance:'cancelled'}]}),
  ]) await assert.rejects(action(),/Alasan pembatalan/);
  assert.deepEqual(db.data,before);
});

test('one occurrence stores reasons per child, preserves earlier reasons on retry, and leaves other weeks untouched',async()=>{
  const {service,db}=setup(); await service.create(actor,draft({recurrence:'weekly',repeatCount:2}));
  const id=db.data.sessions[0]._id;
  await service.updateSession(actor,id,{status:'cancelled',cancellationReason:'  Guru sedang sakit.  '});
  assert.ok(db.data.sessions.slice(0,3).every(row=>row.status==='cancelled' && row.cancellationReason==='Guru sedang sakit.'));
  assert.ok(db.data.sessions.slice(3).every(row=>row.status==='scheduled' && row.cancellationReason===undefined));
  await service.updateSession(actor,id,{status:'cancelled',cancellationReason:'Tidak boleh menimpa alasan asli.'});
  assert.ok(db.data.sessions.slice(0,3).every(row=>row.cancellationReason==='Guru sedang sakit.'));
  await assert.rejects(service.updateSession({...actor,workspaceId:'other'},id,{status:'cancelled',cancellationReason:'Guru sakit'}),error=>error.getStatus()===404);
});

test('series cancellation preserves completed attendance and individual cancellation reasons',async()=>{
  const {service,db}=setup(); const schedule=await service.create(actor,draft({recurrence:'weekly',repeatCount:2}));
  const [recorded,cancelled]=db.data.sessions;
  await service.attendance(actor,recorded._id,{attendance:'present'});
  await service.attendance(actor,cancelled._id,{attendance:'cancelled',cancellationReason:'Alasan pertama.'});
  await service.update(actor,schedule._id,{status:'cancelled',cancellationReason:'Seri dihentikan oleh Guru.'});
  assert.equal(recorded.status,'completed'); assert.equal(recorded.cancellationReason,undefined);
  assert.equal(cancelled.cancellationReason,'Alasan pertama.');
  assert.ok(db.data.sessions.filter(row=>![recorded._id,cancelled._id].includes(row._id)).every(row=>row.cancellationReason==='Seri dihentikan oleh Guru.'));
  assert.ok(db.data.schedules.every(row=>row.recurrenceComplete && row.cancellationReason==='Seri dihentikan oleh Guru.'));
});

test('legacy batch cancellation validates all reasons before writes and keeps distinct child reasons in the teacher group view',async()=>{
  const {service,db,delivered}=setup(); await service.create(actor,draft());
  const rows=db.data.sessions, before=structuredClone(db.data);
  const entries=rows.map((row,index)=>({sessionId:row._id,attendance:'cancelled',cancellationReason:`Alasan untuk siswa ${index+1}.`}));
  await assert.rejects(service.batchAttendance(actor,rows[0]._id,{entries:entries.map((row,index)=>index===1?{...row,cancellationReason:' '}:row)}),/Alasan pembatalan/);
  assert.deepEqual(db.data,before);
  await service.batchAttendance(actor,rows[0]._id,{entries});
  const view=await service.session(actor,rows[0]._id);
  assert.equal(view.status,'cancelled'); assert.equal(view.cancellationReason,undefined);
  const expected=new Map(entries.map(row=>[row.sessionId,row.cancellationReason]));
  for(const participant of view.participants) assert.equal(participant.cancellationReason,expected.get(participant.sessionId));
  assert.deepEqual(delivered,[]);
});

test('DTO accepts checkbox IDs and legacy one-child input; rejects malformed/duplicate/oversized payloads and client group ownership',async()=>{
  const pipe=new ValidationPipe({transform:true,whitelist:true,forbidNonWhitelisted:true});
  await pipe.transform(draft(),{type:'body',metatype:dto.ScheduleDto});
  await pipe.transform(draft({studentIds:undefined,studentId:childA}),{type:'body',metatype:dto.ScheduleDto});
  for(const studentIds of [[],[childA,childA],['bad-id'],Array.from({length:101},randomUUID),null]) {
    if(studentIds===null) continue; // optional null is rejected by the service's empty selection guard.
    await assert.rejects(pipe.transform(draft({studentIds}),{type:'body',metatype:dto.ScheduleDto}));
  }
  await assert.rejects(pipe.transform(draft({groupId:randomUUID()}),{type:'body',metatype:dto.ScheduleDto}));
  for(const entries of [[],[null],[{sessionId:childA,attendance:'made-up'}],[{sessionId:childA,attendance:'present'},{sessionId:childA,attendance:'absent'}]]) {
    await assert.rejects(pipe.transform({entries},{type:'body',metatype:dto.BatchAttendanceDto}));
  }
});

test('one group slot creates private child series/occurrences, with one shared calendar lock and weekly entitlement',async()=>{
  const {service,db,trace,features}=setup();
  const schedule=await service.create(actor,draft({recurrence:'weekly',repeatCount:2}));
  assert.equal(schedule.participantCount,3);
  assert.equal(db.data.schedules.length,3); assert.equal(db.data.sessions.length,6);
  assert.equal(new Set(db.data.schedules.map(row=>row.groupId)).size,1);
  assert.equal(new Set(db.data.sessions.map(row=>row.groupId)).size,2);
  assert.deepEqual(trace,['lock','overlap','overlap','commit']);
  assert.deepEqual(features,[[actor.workspaceId,'recurringSchedules']]);
  for(const row of db.data.sessions) assert.equal(db.data.schedules.find(schedule=>schedule._id===row.scheduleId).studentId,row.studentId);
});

test('legacy and new single-student schedules remain ungrouped and keep old individual attendance',async()=>{
  const {service,db}=setup();
  await service.create(actor,draft({studentIds:undefined,studentId:childA}));
  assert.equal(db.data.sessions[0].groupId,undefined);
  const saved=await service.attendance(actor,db.data.sessions[0]._id,{attendance:'present'});
  assert.equal(saved.attendance,'present');
  await assert.rejects(service.attendance(actor,saved._id,{attendance:'absent'}),/dikunci/);
});

test('missing, ambiguous, duplicate, archived and cross-workspace selections cannot create partial schedules',async()=>{
  for(const extra of [{studentIds:[]},{studentIds:null},{studentIds:[childA,childA]},{studentId:childA},{studentIds:[childA,randomUUID()]}]) {
    const {service,db}=setup();
    await assert.rejects(service.create(actor,draft(extra)));
    assert.equal(db.data.schedules.length,0); assert.equal(db.data.sessions.length,0);
  }
  const {service,db}=setup(); db.data.students[1].status='archived';
  await assert.rejects(service.create(actor,draft()),/diarsipkan/);
  assert.equal(db.data.schedules.length,0);
  db.data.students[1].status='active'; db.data.students[1].workspaceId='other';
  await assert.rejects(service.create(actor,draft()),/tidak ditemukan/);
});

test('an unrelated overlapping lesson still blocks group creation and rolls everything back',async()=>{
  const {service,db,trace}=setup();
  await service.create(actor,draft({studentIds:[childA]}));
  const before=structuredClone(db.data);
  await assert.rejects(service.create(actor,draft()),/sudah digunakan/);
  assert.deepEqual(db.data,before); assert.equal(trace.at(-1),'rollback');
});

test('teacher agenda and series pagination count groups, not children; child-filtered history stays individual',async()=>{
  const {service,db,pipelines}=setup();
  await service.create(actor,draft({recurrence:'weekly',repeatCount:2}));
  const page=await service.sessions(actor,{page:1,limit:1});
  assert.equal(page.total,2); assert.equal(page.items.length,1); assert.equal(page.items[0].participants.length,3);
  assert.equal(page.items[0].studentName,'3 siswa');
  const next=await service.sessions(actor,{page:2,limit:1});
  assert.notEqual(page.items[0]._id,next.items[0]._id);
  const series=await service.list(actor,{page:1,limit:30}); assert.equal(series.total,1);
  assert.equal((await service.sessions(actor,{page:1,limit:30,scheduleId:db.data.schedules[0]._id})).total,2);
  const own=await service.sessions(actor,{page:1,limit:30,studentId:childB});
  assert.equal(own.total,2); assert.ok(own.items.every(row=>row.studentId===childB && row.participants===undefined));
  assert.equal(pipelines[0].pipeline[0].$match.workspaceId,actor.workspaceId);
  assert.ok(pipelines[0].pipeline.findIndex(stage=>stage.$group) < pipelines[0].pipeline.findIndex(stage=>stage.$facet));
  assert.equal(pipelines[0].options.maxTimeMS,10000);
});

test('group detail is workspace scoped even when another tenant reuses a group key',async()=>{
  const {service,db}=setup(); await service.create(actor,draft());
  const first=db.data.sessions[0]; db.data.sessions.push({...first,_id:randomUUID(),studentId:'foreign',workspaceId:'other'});
  const result=await service.session(actor,first._id);
  assert.equal(result.participants.length,3); assert.ok(!result.participants.some(row=>row.studentId==='foreign'));
  await assert.rejects(service.session({...actor,workspaceId:'other'},first._id),/tidak ditemukan/);
});

test('batch attendance saves distinct child statuses once and notifies only the correct parent after commit',async()=>{
  const {service,db,delivered}=setup(); await service.create(actor,draft());
  const entries=db.data.sessions.map((row,index)=>({sessionId:row._id,attendance:['present','excused','absent'][index]}));
  assert.deepEqual(await service.batchAttendance(actor,entries[0].sessionId,{entries}),{savedCount:3});
  assert.deepEqual(db.data.sessions.map(row=>row.attendance),['present','excused','absent']);
  assert.equal(db.data.notifications.length,1); assert.equal(delivered.length,1);
  assert.equal(db.data.notifications[0].recipientAccountId,`parent-${childA}`);
  assert.equal(db.data.notifications[0].route,`/parent/sessions/${entries[0].sessionId}`);
  const result=await service.session(actor,entries[0].sessionId);
  assert.equal(result.attendance,'mixed'); assert.equal(result.status,'completed'); assert.equal(result.recordedCount,3);
  await assert.rejects(service.batchAttendance(actor,entries[0].sessionId,{entries}),/dikunci/);
  assert.equal(db.data.notifications.length,1);
});

test('partial save leaves unselected pupils pending, then allows saving only the remainder',async()=>{
  const {service,db}=setup(); await service.create(actor,draft()); const rows=db.data.sessions;
  await service.batchAttendance(actor,rows[0]._id,{entries:[{sessionId:rows[0]._id,attendance:'present'}]});
  const detail=await service.session(actor,rows[0]._id);
  assert.equal(detail.attendance,'pending'); assert.equal(detail.status,'scheduled'); assert.equal(detail.recordedCount,1);
  assert.equal(rows[1].attendance,'pending');
  await service.batchAttendance(actor,rows[0]._id,{entries:rows.slice(1).map(row=>({sessionId:row._id,attendance:'present'}))});
  assert.equal((await service.session(actor,rows[0]._id)).attendance,'present');
});

test('locked, unrelated, duplicate and other-week entries reject the whole batch without partial updates',async()=>{
  const {service,db}=setup(); await service.create(actor,draft({recurrence:'weekly',repeatCount:2}));
  const rows=db.data.sessions; const id=rows[0]._id;
  await service.attendance(actor,rows[1]._id,{attendance:'excused'});
  for(const secondId of [rows[1]._id,rows[3]._id,randomUUID(),id]) {
    const before=structuredClone(db.data);
    await assert.rejects(service.batchAttendance(actor,id,{entries:[{sessionId:id,attendance:'present'},{sessionId:secondId,attendance:'absent'}]}));
    assert.deepEqual(db.data,before);
  }
});

test('notification persistence failure rolls back attendance; no delivery occurs before commit',async()=>{
  const {service,db,notifications,delivered}=setup(); await service.create(actor,draft());
  notifications.create=async()=>{throw new Error('outbox unavailable');};
  await assert.rejects(service.batchAttendance(actor,db.data.sessions[0]._id,{entries:db.data.sessions.map(row=>({sessionId:row._id,attendance:'present'}))}),/outbox unavailable/);
  assert.ok(db.data.sessions.every(row=>row.attendance==='pending')); assert.equal(delivered.length,0);
});

test('teacher reschedules the whole occurrence under lock, preserving the other weeks; unrelated slots still conflict',async()=>{
  const {service,db,trace}=setup(); await service.create(actor,draft({recurrence:'weekly',repeatCount:2}));
  const id=db.data.sessions[0]._id, secondWeek=db.data.sessions[3].startAt;
  await service.updateSession(actor,id,{startAt:'2026-10-22T00:00:00Z',endAt:'2026-10-22T03:00:00Z'});
  assert.ok(db.data.sessions.slice(0,3).every(row=>row.startAt.toISOString()==='2026-10-22T00:00:00.000Z'));
  assert.equal(db.data.sessions[3].startAt.getTime(),secondWeek.getTime());
  assert.deepEqual(trace.slice(-3),['lock','overlap','commit']);
  await assert.rejects(service.updateSession(actor,id,{startAt:db.data.sessions[3].startAt.toISOString(),endAt:db.data.sessions[3].endAt.toISOString()}),/sudah digunakan/);
});

test('teacher cannot move partially recorded groups and series cancellation preserves recorded child history',async()=>{
  const {service,db}=setup(); const series=await service.create(actor,draft({recurrence:'weekly',repeatCount:2}));
  await service.attendance(actor,db.data.sessions[0]._id,{attendance:'present'});
  await assert.rejects(service.updateSession(actor,db.data.sessions[1]._id,{startAt:'2026-10-22T00:00:00Z',endAt:'2026-10-22T03:00:00Z'}),/presensi tersimpan/);
  await service.update(actor,series._id,{status:'cancelled',cancellationReason:'Guru tidak dapat melanjutkan jadwal.'});
  assert.equal(db.data.sessions[0].status,'completed');
  assert.equal(db.data.sessions.filter(row=>row.status==='cancelled').length,5);
  assert.ok(db.data.schedules.every(row=>row.status==='cancelled'));
});

test('an individual parent-approved move naturally leaves the group without changing peers or disclosing them',async()=>{
  const {service,db}=setup(); await service.create(actor,draft()); const moved=db.data.sessions[0];
  // Parent approval's existing authorized single-row interval write.
  moved.startAt=new Date('2026-10-22T00:00:00Z'); moved.endAt=new Date('2026-10-22T03:00:00Z');
  const result=await service.sessions(actor,{page:1,limit:30});
  assert.equal(result.total,2); assert.deepEqual(result.items.map(row=>row.participantCount).sort(),[1,2]);
  assert.equal((await service.session(actor,moved._id)).participants.length,1);
  const filter=groups.occurrenceMembers(moved);
  assert.equal(filter.workspaceId,actor.workspaceId); assert.equal(filter.endAt,moved.endAt);
});

test('aggregation retains legacy rows by ID and groups only exact occurrence intervals',()=>{
  const pipeline=groups.groupPipeline({workspaceId:'safe'},true);
  assert.deepEqual(pipeline[0],{$match:{workspaceId:'safe'}});
  assert.deepEqual(pipeline[2].$group._id,{group:{$ifNull:['$groupId','$_id']},start:'$startAt',end:'$endAt'});
  assert.ok(pipeline[3].$set['row.status']);
});

test('parent and student group-session views contain only their own child and published shared reports',async()=>{
  const {service,db}=setup(); await service.create(actor,draft());
  db.data.families=[{_id:'family-one',workspaceId:actor.workspaceId}];
  db.data.students[0].familyId='family-one';
  db.data.students[1].familyId='family-two';
  db.data.users=[{...actor,role:'teacher',name:'Guru'}];
  const own=db.data.sessions[0],other=db.data.sessions[1];
  await service.updateSession(actor,own._id,{status:'cancelled',cancellationReason:'Guru sedang sakit.'});
  db.data.reports=[
    {_id:'own-shared',workspaceId:actor.workspaceId,studentId:childA,sessionId:own._id,visibility:'shared',status:'published'},
    {_id:'private',workspaceId:actor.workspaceId,studentId:childA,sessionId:own._id,visibility:'teacher',status:'published'},
    {_id:'draft',workspaceId:actor.workspaceId,studentId:childA,sessionId:own._id,visibility:'shared',status:'draft'},
    {_id:'other-child',workspaceId:actor.workspaceId,studentId:childB,sessionId:other._id,visibility:'shared',status:'published'},
  ];
  const parent=new ParentPortalService(db,{}, {}, {}, {});
  const student=new StudentPortalService(db);
  const parentAccount={_id:'parent',workspaceId:actor.workspaceId,role:'parent',familyId:'family-one'};
  const studentAccount={_id:'account',workspaceId:actor.workspaceId,role:'student',studentId:childA};
  for(const [portal,account] of [[parent,parentAccount],[student,studentAccount]]) {
    const view=await portal.sessionOverview(account,own._id);
    assert.equal(view.lesson.cancellationReason,'Guru sedang sakit.');
    assert.equal(view.lesson.studentId,childA); assert.equal(view.lesson.participants,undefined);
    assert.equal(view.schedule.participants,undefined);
    assert.deepEqual(view.reports.map(row=>row._id),['own-shared']);
    assert.ok(!JSON.stringify(view).includes('Siswa 2'));
    await assert.rejects(portal.sessionOverview(account,other._id),/tidak ditemukan/);
  }
  // Siblings still do not expand the student's account scope.
  db.data.students[1].familyId='family-one';
  await assert.rejects(student.sessionOverview(studentAccount,other._id),/tidak ditemukan/);
  assert.equal((await parent.sessionOverview(parentAccount,other._id)).lesson.studentId,childB);
});

test('teacher group report listing includes each member, but writing a report still binds to one child occurrence',async()=>{
  const {service,scope,notifications,db}=setup(); await service.create(actor,draft());
  const reports=new ReportsService(scope,notifications), own=db.data.sessions[0],other=db.data.sessions[1];
  const saved=await reports.create(actor,other._id,{topic:'Piano',summary:'Catatan pribadi',visibility:'shared'});
  assert.equal(saved.toObject().studentId,childB);
  const listing=await reports.list(actor,{page:1,limit:30,sessionId:own._id});
  assert.equal(listing.items.length,1); assert.equal(listing.items[0].studentId,childB);
  await assert.rejects(reports.list({...actor,workspaceId:'other'},{page:1,limit:30,sessionId:own._id}),/tidak ditemukan/);
});

test('future attendance is rejected for single and group requests without writes or notifications; cancellation stays available',async()=>{
  for(const grouped of [false,true]) {
    const {service,db,delivered,trace}=setup();
    await service.create(actor,draft({studentIds:grouped?[childA,childB]:[childA],startAt:'2026-10-22T00:00:00Z',endAt:'2026-10-22T01:00:00Z'}));
    const before=structuredClone(db.data);
    const id=db.data.sessions[0]._id;
    await assert.rejects(grouped
      ? service.batchAttendance(actor,id,{entries:db.data.sessions.map(row=>({sessionId:row._id,attendance:'present'}))})
      : service.attendance(actor,id,{attendance:'present'}),error=>error.getStatus()===400 && /Presensi tersedia saat sesi dimulai/.test(error.message));
    assert.deepEqual(db.data,before); assert.deepEqual(delivered,[]); assert.equal(trace.at(-1),'rollback');
    await service.updateSession(actor,id,{status:'cancelled',cancellationReason:'Guru berhalangan mengajar.'});
    assert.ok(db.data.sessions.every(row=>row.status==='cancelled'));
  }
});

test('attendance opens exactly at server start, stays available afterwards and remains write-once',async()=>{
  for(const startAt of ['2026-10-21T06:00:00Z','2026-10-20T06:00:00Z']) {
    const {service,db}=setup();
    await service.create(actor,draft({studentIds:[childA],startAt,endAt:new Date(Date.parse(startAt)+3600000).toISOString()}));
    const id=db.data.sessions[0]._id;
    await service.attendance(actor,id,{attendance:'present'});
    assert.equal(db.data.sessions[0].attendance,'present');
    await assert.rejects(service.attendance(actor,id,{attendance:'absent'}),/dikunci/);
  }
});

test('parent overview exposes only a current scoped pending flag, including another parent in the same family',async()=>{
  const {service,db}=setup({families:[{_id:'family',workspaceId:actor.workspaceId}]});
  db.data.students[0].familyId='family';
  await service.create(actor,draft({studentIds:[childA],startAt:'2026-10-22T00:00:00Z',endAt:'2026-10-22T03:00:00Z'}));
  const lesson=db.data.sessions[0];
  const parent=new ParentPortalService(db,{}, {}, {}, {});
  const account={_id:'parent',workspaceId:actor.workspaceId,role:'parent',familyId:'family'};
  assert.equal((await parent.sessionOverview(account,lesson._id)).reschedulePending,false);
  const pending={_id:'request',workspaceId:actor.workspaceId,sessionId:lesson._id,studentId:childA,familyId:'family',parentAccountId:'other-parent',status:'pending',oldStartAt:lesson.startAt,oldEndAt:lesson.endAt,requestedStartAt:new Date('2026-10-23T00:00:00Z'),reason:'private reason'};
  db.data.rescheduleRequests=[pending];
  const view=await parent.sessionOverview(account,lesson._id);
  assert.equal(view.reschedulePending,true);
  assert.ok(!JSON.stringify(view).includes('private reason'));
  assert.ok(!JSON.stringify(view).includes('other-parent'));
  for(const change of [{familyId:'other'}, {workspaceId:'other'}, {status:'rejected'}, {oldStartAt:new Date('2026-10-22T01:00:00Z')}, {requestedStartAt:new Date('2026-10-20T00:00:00Z')}]) {
    db.data.rescheduleRequests=[{...pending,...change}];
    assert.equal((await parent.sessionOverview(account,lesson._id)).reschedulePending,false);
  }
  db.data.rescheduleRequests=[{...pending,requestedStartAt:new Date('2026-10-20T00:00:00Z'),proposedStartAt:new Date('2026-10-24T00:00:00Z')}];
  assert.equal((await parent.sessionOverview(account,lesson._id)).reschedulePending,true);
  await assert.rejects(parent.sessionOverview({...account,familyId:'foreign'},lesson._id),/keluarga/);
});

test('lost post-commit response leaves one pending request and retry returns RESCHEDULE_PENDING without a second event',async()=>{
  const {service,db,notifications,trace}=setup({families:[{_id:'family',workspaceId:actor.workspaceId}]});
  db.data.students[0].familyId='family';
  await service.create(actor,draft({studentIds:[childA],startAt:'2026-10-22T00:00:00Z',endAt:'2026-10-22T03:00:00Z'}));
  const account={_id:'parent',workspaceId:actor.workspaceId,role:'parent',familyId:'family'};
  const parent=new ParentPortalService(db,{requireFeature:async()=>{}}, {}, {}, {
    ...notifications,deliverAfterCommit:async()=>{assert.equal(trace.at(-1),'commit'); throw new Error('delivery response lost');},
  });
  // The narrow fake does not implement expiry aggregation. Every request here
  // remains future/current, so expiry is explicitly outside this case.
  parent.expireRequests=async()=>{};
  const input={sessionId:db.data.sessions[0]._id,startAt:'2026-10-23T00:00:00Z',endAt:'2026-10-23T03:00:00Z',reason:'anak sakit'};
  await assert.rejects(parent.requestReschedule(account,input),/delivery response lost/);
  assert.equal(db.data.rescheduleRequests.length,1);
  assert.equal(db.data.notifications.length,1);
  assert.equal((await parent.sessionOverview(account,input.sessionId)).reschedulePending,true);
  await assert.rejects(parent.requestReschedule(account,input),error=>error.getStatus()===409 && error.getResponse().code==='RESCHEDULE_PENDING');
  assert.equal(db.data.rescheduleRequests.length,1);assert.equal(db.data.notifications.length,1);
  db.data.rescheduleRequests[0].status='rejected';
  await assert.rejects(parent.requestReschedule(account,input),/delivery response lost/);
  assert.equal(db.data.rescheduleRequests.length,2);
});

test('teacher Home counts one session per group, preserves chronological max-three previews and individual pending reports',async()=>{
  const {service,scope,db}=setup(); await service.create(actor,draft());
  await service.create(actor,draft({studentIds:[childA],startAt:'2026-10-21T04:00:00Z',endAt:'2026-10-21T05:00:00Z'}));
  const home=await new DashboardService(scope).get(actor,new Date('2026-10-21T06:00:00Z'));
  assert.equal(home.activeStudents,3); assert.equal(home.sessionsToday,2);
  assert.equal(home.todaySessions.length,2); assert.equal(home.todaySessions[0].participantCount,3);
  assert.equal(home.pendingReports,4); // A report is still required for each child.
  assert.equal(home.todaySessions[1].studentGrade,'SD');
  assert.equal(db.data.sessions.length,4);
});
